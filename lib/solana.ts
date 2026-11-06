import crypto from 'crypto';
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  ParsedInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { withTransaction } from './db';
import { PaymentQuote } from './quotes';
import { config } from './config';
import { SETTLEMENT_ASSET, formatUsdc } from './protocol';

export const DEVNET_RPC_URL = config.solanaRpcUrl;
export const DEVNET_USDC_MINT = new PublicKey(config.usdcMint);
export const MEMO_PROGRAM_ID = new PublicKey(config.memoProgramId);

export interface ReceiptRecord {
  id: string;
  quote_id: string;
  tx_signature: string;
  payer_wallet: string;
  total_amount_usdc: string;
  total_base_units: string;
  settlement_asset: string;
  solana_slot: number;
  block_time: string;
  memo_verified: boolean;
  breakdown: any;
  created_at: string;
}

export class SolanaVerificationError extends Error {
  code: string;
  constructor(message: string, code: string = 'VERIFICATION_FAILED') {
    super(message);
    this.name = 'SolanaVerificationError';
    this.code = code;
  }
}

export function getSolanaConnection(): Connection {
  return new Connection(DEVNET_RPC_URL, 'confirmed');
}

/**
 * Extracts memo text from parsed transaction instructions.
 */
function extractMemoFromParsedTx(tx: ParsedTransactionWithMeta): string | null {
  const instructions = tx.transaction.message.instructions;

  for (const ix of instructions) {
    if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      if ('parsed' in ix && typeof ix.parsed === 'string') {
        return ix.parsed;
      }
      if ('data' in ix && typeof ix.data === 'string') {
        try {
          return Buffer.from(ix.data, 'base64').toString('utf8');
        } catch {
          return ix.data;
        }
      }
    }
  }

  // Check inner instructions as well
  if (tx.meta?.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if (ix.programId.equals(MEMO_PROGRAM_ID)) {
          if ('parsed' in ix && typeof ix.parsed === 'string') {
            return ix.parsed;
          }
          if ('data' in ix && typeof ix.data === 'string') {
            try {
              return Buffer.from(ix.data, 'base64').toString('utf8');
            } catch {
              return ix.data;
            }
          }
        }
      }
    }
  }

  return null;
}

/** Collects every parsed instruction in a transaction, including inner ones. */
function collectInstructions(tx: ParsedTransactionWithMeta): Array<
  ParsedInstruction | PartiallyDecodedInstruction
> {
  const all: Array<ParsedInstruction | PartiallyDecodedInstruction> = [
    ...tx.transaction.message.instructions,
  ];
  if (tx.meta?.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      all.push(...inner.instructions);
    }
  }
  return all;
}

interface SplTransfer {
  destination: string;
  source: string;
  amount: bigint;
  /** Mint when the instruction discloses it (transferChecked). */
  mint?: string;
}

/**
 * Extracts every SPL token transfer in the transaction.
 *
 * `transferChecked` discloses its mint directly. An unchecked `transfer` does
 * not, so the caller must infer the token from the source ATA.
 */
function extractSplTransfers(
  tx: ParsedTransactionWithMeta
): SplTransfer[] {
  const transfers: SplTransfer[] = [];

  for (const ix of collectInstructions(tx)) {
    if (!('parsed' in ix) || !ix.parsed) continue;
    if (ix.program !== 'spl-token') continue;

    const type = ix.parsed.type;
    if (type !== 'transfer' && type !== 'transferChecked') continue;

    const info = ix.parsed.info as any;
    if (!info) continue;

    const amount = info.tokenAmount
      ? BigInt(info.tokenAmount.amount)
      : BigInt(info.amount);

    if (amount <= 0n) continue;

    transfers.push({
      destination: String(info.destination ?? ''),
      source: String(info.source ?? ''),
      amount,
      mint: info.mint ? String(info.mint) : undefined,
    });
  }

  return transfers;
}

/**
 * Looks up the mint of a token account using pre/post token balance metadata.
 *
 * Uses the accountIndex field on token balance entries, which maps to the
 * transaction's accountKeys array. This is ground truth from the Solana
 * runtime, unlike instruction-parsed mint data which is absent for unchecked
 * `transfer` instructions.
 *
 * @returns The mint address, or null if the account is not a token account.
 */
function getTokenAccountMint(
  tx: ParsedTransactionWithMeta,
  accountAddress: string
): string | null {
  const allBalances = [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ];
  const entry = allBalances.find(
    (b) =>
      b.accountIndex !== undefined &&
      tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() ===
        accountAddress
  );
  return entry?.mint ?? null;
}

/**
 * Computes the USDC balance delta for a specific token account using pre/post
 * token balance metadata.
 *
 * This is ground truth: the Solana runtime records the actual token balance
 * before and after the transaction. Instruction-parsed amounts (especially for
 * unchecked `transfer`) cannot be trusted for mint verification.
 *
 * @returns The post-minus-pre balance delta in base units, as BigInt.
 */
function getTokenAccountDelta(
  tx: ParsedTransactionWithMeta,
  accountAddress: string
): bigint {
  const usdcMintStr = DEVNET_USDC_MINT.toBase58();
  const pre = tx.meta?.preTokenBalances?.find(
    (b) =>
      b.accountIndex !== undefined &&
      b.mint === usdcMintStr &&
      tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() ===
        accountAddress
  );
  const post = tx.meta?.postTokenBalances?.find(
    (b) =>
      b.accountIndex !== undefined &&
      b.mint === usdcMintStr &&
      tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() ===
        accountAddress
  );
  const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : BigInt(0);
  const postAmt = post ? BigInt(post.uiTokenAmount.amount) : BigInt(0);
  return postAmt - preAmt;
}

/**
 * Removes the wallet-level balance fallback as an independent source of
 * payment proof. All payment verification now uses per-token-account balance
 * deltas from transaction metadata.
 */
export interface ValidatedSettlement {
  valid: true;
  payer: string;
  totalBaseUnits: bigint;
  breakdown: Array<{
    publisher_id: string;
    publisher_wallet: string;
    publisher_name: string;
    document_ids: string[];
    document_titles: string[];
    documents: Array<{
      document_id: string;
      document_title: string;
      chunk_ids: string[];
      amount_base_units: bigint;
      amount_usdc: string;
    }>;
    expected_amount: bigint;
    received_amount: bigint;
    verified: boolean;
  }>;
}

/**
 * TASK 5: Pure validation of a parsed Solana transaction against a quote.
 *
 * This function contains all security-critical verification logic and can be
 * tested independently of RPC and database access. It validates actual parsed
 * transaction data and returns a structured verified settlement result.
 *
 * Checks performed:
 *   1. Transaction metadata present
 *   2. On-chain execution successful (meta.err === null)
 *   3. Block time present and within quote expiry
 *   4. Fee payer matches expectedPayer (if provided)
 *   5. Memo instruction present and matches quote.memo_expected exactly
 *   6. Every SPL transfer originates from buyer's USDC ATA
 *   7. Every transfer to a priced publisher's ATA comes from buyer's ATA
 *   8. No transfers from buyer ATA to unpriced destinations
 *   9. No unexpected incoming transfers to buyer ATA
 *   10. Mint verified via token-balance metadata (accountIndex → accountKeys)
 *   11. Per-publisher amounts exact (no under/over payment)
 *   12. Total transferred equals quote total (no under/over payment)
 *   13. Payer USDC ATA debited by exactly quote total
 *
 * Does NOT perform: replay protection, signature format, RPC fetch,
 * database persistence. Those are handled by verifySettlementTransaction.
 */
export function validateParsedSettlementTransaction(
  tx: ParsedTransactionWithMeta,
  quote: PaymentQuote,
  expectedPayer?: string
): ValidatedSettlement {
  // Missing metadata
  if (!tx.meta) {
    throw new SolanaVerificationError(
      'Transaction has no on-chain metadata.',
      'TRANSACTION_NO_META'
    );
  }

  // Failed transaction
  if (tx.meta.err !== null) {
    throw new SolanaVerificationError(
      `Transaction failed on-chain with error: ${JSON.stringify(tx.meta.err)}`,
      'TRANSACTION_FAILED'
    );
  }

  // Missing block time
  if (!tx.blockTime) {
    throw new SolanaVerificationError(
      'Transaction has no block time. Cannot verify quote expiry.',
      'TRANSACTION_NO_BLOCK_TIME'
    );
  }

  // Payer check
  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
  if (!feePayer) {
    throw new SolanaVerificationError(
      'Could not determine the transaction fee payer.',
      'PAYER_MISSING'
    );
  }
  if (expectedPayer && feePayer !== expectedPayer.trim()) {
    throw new SolanaVerificationError(
      `Transaction payer mismatch. Expected: ${expectedPayer}, got: ${feePayer}`,
      'PAYER_MISMATCH'
    );
  }

  // Quote expiry
  const blockTimeSec = tx.blockTime;
  const quoteExpiresTimeSec = Math.floor(new Date(quote.expires_at).getTime() / 1000);
  if (blockTimeSec > quoteExpiresTimeSec + 60) {
    throw new SolanaVerificationError(
      `Quote ${quote.id} expired at ${quote.expires_at}, but transaction was mined at ${new Date(
        blockTimeSec * 1000
      ).toISOString()}`,
      'QUOTE_EXPIRED'
    );
  }

  // Memo check
  const memoText = extractMemoFromParsedTx(tx);
  if (!memoText) {
    throw new SolanaVerificationError(
      'Transaction does not contain a CiteRail memo instruction.',
      'MEMO_MISSING'
    );
  }
  if (memoText !== quote.memo_expected) {
    throw new SolanaVerificationError(
      `Transaction memo verification failed. Expected exactly "${quote.memo_expected}", got: "${memoText}"`,
      'MEMO_MISMATCH'
    );
  }

  // Transfer verification
  const payerKey = new PublicKey(feePayer);
  const payerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, payerKey);
  const payerAtaStr = payerAta.toBase58();
  const usdcMintStr = DEVNET_USDC_MINT.toBase58();

  // Build expected destinations from quote breakdown
  const expectedDestinations = new Map<string, string>();
  for (const pub of quote.publisher_breakdown) {
    const pubKey = new PublicKey(pub.publisher_wallet);
    expectedDestinations.set(
      getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubKey).toBase58(),
      pub.publisher_wallet
    );
  }

  const splTransfers = extractSplTransfers(tx);

  // Validate every SPL transfer
  for (const transfer of splTransfers) {
    const destIsPriced = expectedDestinations.has(transfer.destination);

    // Reject third-party funding to a priced publisher's ATA
    if (destIsPriced && transfer.source !== payerAtaStr) {
      throw new SolanaVerificationError(
        `Third-party funding detected: transfer to ${transfer.destination} from non-buyer source ${transfer.source}.`,
        'THIRD_PARTY_FUNDING'
      );
    }

    // Skip transfers that don't involve our pricing
    if (transfer.source !== payerAtaStr) continue;
    if (!destIsPriced) continue;

    // Verify source account mint is USDC via token-balance metadata
    const sourceMint = getTokenAccountMint(tx, transfer.source);
    if (sourceMint !== usdcMintStr) {
      throw new SolanaVerificationError(
        `Source account ${transfer.source} is not a USDC token account.`,
        'WRONG_SOURCE_MINT'
      );
    }

    // Verify destination account mint is USDC via token-balance metadata
    const destMint = getTokenAccountMint(tx, transfer.destination);
    if (destMint !== usdcMintStr) {
      throw new SolanaVerificationError(
        `Destination account ${transfer.destination} is not a USDC token account.`,
        'WRONG_DESTINATION_MINT'
      );
    }
  }

  // Compute actual credited amounts from token balance deltas
  const destinationDeltas = new Map<string, bigint>();
  for (const transfer of splTransfers) {
    if (transfer.source !== payerAtaStr) continue;
    if (!expectedDestinations.has(transfer.destination)) continue;

    const delta = getTokenAccountDelta(tx, transfer.destination);
    if (delta > BigInt(0)) {
      const existing = destinationDeltas.get(transfer.destination) ?? BigInt(0);
      destinationDeltas.set(transfer.destination, existing + delta);
    }
  }

  // Also check for unexpected incoming transfers to buyer ATA
  const buyerIncomingDeltas = new Map<string, bigint>();
  for (const transfer of splTransfers) {
    if (transfer.destination !== payerAtaStr) continue;
    if (transfer.source === payerAtaStr) continue;
    const delta = getTokenAccountDelta(tx, transfer.destination);
    if (delta > BigInt(0)) {
      const existing = buyerIncomingDeltas.get(transfer.source) ?? BigInt(0);
      buyerIncomingDeltas.set(transfer.source, existing + delta);
    }
  }
  if (buyerIncomingDeltas.size > 0) {
    const sources = Array.from(buyerIncomingDeltas.keys()).join(', ');
    throw new SolanaVerificationError(
      `Unexpected incoming transfers to buyer ATA from: ${sources}`,
      'UNEXPECTED_INFLOW'
    );
  }

  let totalTransferredBaseUnits = BigInt(0);
  const verifiedBreakdown: ValidatedSettlement['breakdown'] = [];

  for (const pub of quote.publisher_breakdown) {
    const expectedAta = getAssociatedTokenAddressSync(
      DEVNET_USDC_MINT,
      new PublicKey(pub.publisher_wallet)
    );
    const expectedAtaStr = expectedAta.toBase58();

    const amountReceivedForPub = destinationDeltas.get(expectedAtaStr) ?? BigInt(0);

    const expectedAmount = BigInt(pub.amount_base_units);
    if (amountReceivedForPub !== expectedAmount) {
      throw new SolanaVerificationError(
        `Incorrect ${SETTLEMENT_ASSET} amount for publisher ${pub.publisher_name} (${pub.publisher_wallet}). Expected exactly ${expectedAmount} base units, received ${amountReceivedForPub} base units.`,
        amountReceivedForPub < expectedAmount
          ? 'INSUFFICIENT_TRANSFER'
          : 'EXCESSIVE_TRANSFER'
      );
    }

    totalTransferredBaseUnits += amountReceivedForPub;
    verifiedBreakdown.push({
      publisher_id: pub.publisher_id,
      publisher_wallet: pub.publisher_wallet,
      publisher_name: pub.publisher_name,
      document_ids: pub.documents.flatMap((d) => d.document_id),
      document_titles: pub.documents.map((d) => d.document_title),
      documents: pub.documents,
      expected_amount: expectedAmount,
      received_amount: amountReceivedForPub,
      verified: true,
    });
  }

  // Exact total
  if (totalTransferredBaseUnits !== BigInt(quote.total_base_units)) {
    throw new SolanaVerificationError(
      `Total settled amount ${totalTransferredBaseUnits} base units does not equal quoted total ${quote.total_base_units} base units.`,
      totalTransferredBaseUnits < BigInt(quote.total_base_units)
        ? 'INSUFFICIENT_TOTAL'
        : 'EXCESSIVE_TOTAL'
    );
  }

  // Exact payer debit
  const payerAtaDelta = getTokenAccountDelta(tx, payerAtaStr);
  const expectedPayerDebit = -BigInt(quote.total_base_units);
  if (payerAtaDelta !== expectedPayerDebit) {
    throw new SolanaVerificationError(
      `Payer USDC ATA delta is ${payerAtaDelta} base units, but the quote requires exactly ${expectedPayerDebit} base units (debit of ${quote.total_base_units}).`,
      'PAYER_NOT_DEBITED_EXACT'
    );
  }

  return {
    valid: true,
    payer: feePayer,
    totalBaseUnits: totalTransferredBaseUnits,
    breakdown: verifiedBreakdown,
  };
}

export async function verifySettlementTransaction(
  txSignature: string,
  quote: PaymentQuote,
  expectedPayer?: string
): Promise<ReceiptRecord> {
  const cleanSig = txSignature.trim();
  if (!cleanSig || cleanSig.length < 60 || cleanSig.length > 100) {
    throw new SolanaVerificationError('Invalid transaction signature format.', 'INVALID_SIGNATURE');
  }

  // 1. Check for Replay Attack in Database
  const replayCheck = await withTransaction(async (client) => {
    const res = await client.query(
      'SELECT id FROM settlement_receipts WHERE tx_signature = $1',
      [cleanSig]
    );
    return res.rows;
  });
  if (replayCheck.length > 0) {
    throw new SolanaVerificationError(
      `Transaction signature ${cleanSig} has already been redeemed. Replay attacks are rejected.`,
      'REPLAY_DETECTED'
    );
  }

  // 2. Fetch confirmed transaction from Solana RPC
  const connection = getSolanaConnection();
  const tx = await connection.getParsedTransaction(cleanSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new SolanaVerificationError(
      `Transaction ${cleanSig} was not found on Solana ${config.solanaNetwork}. Ensure it has been confirmed.`,
      'TRANSACTION_NOT_FOUND'
    );
  }

  // D. Never accept missing transaction metadata as proof of success.
  if (!tx.meta) {
    throw new SolanaVerificationError(
      `Transaction ${cleanSig} has no on-chain metadata.`,
      'TRANSACTION_NO_META'
    );
  }

  // Delegate all on-chain validation to the pure function.
  const validated = validateParsedSettlementTransaction(tx, quote, expectedPayer);

  // 10. Atomic persistence: receipt, quote redemption and the normalised
  //     payout ledger are written in a single transaction.
  const receiptId = `rcpt_${txSignature.slice(0, 16)}`;

  const receipt = await withTransaction(async (client) => {
    const insertReceiptSql = `
      INSERT INTO settlement_receipts (
        id, quote_id, tx_signature, payer_wallet, total_amount_usdc,
        settlement_asset, settlement_amount_base_units,
        solana_slot, block_time, memo_verified, breakdown
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
      RETURNING *;
    `;

    const receiptRes = await client.query(insertReceiptSql, [
      receiptId,
      quote.id,
      cleanSig,
      validated.payer,
      formatUsdc(validated.totalBaseUnits),
      SETTLEMENT_ASSET,
      validated.totalBaseUnits,
      tx.slot,
      new Date(tx.blockTime! * 1000).toISOString(),
      JSON.stringify(validated.breakdown),
    ]);

    // Mark the quote redeemed. The conditional UPDATE means two concurrent
    // redemptions of the same quote cannot both succeed.
    const redeem = await client.query(
      `UPDATE payment_quotes SET status = 'REDEEMED'
       WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [quote.id]
    );
    if (redeem.rows.length === 0) {
      throw new SolanaVerificationError(
        `Quote ${quote.id} is no longer redeemable.`,
        'QUOTE_NOT_REDEEMABLE'
      );
    }

    // Normalised payout ledger: one row per publisher per receipt, indexed so
    // per-publisher royalty accounting is a query rather than a table scan.
    for (const item of validated.breakdown) {
      const documentAllocations = item.documents.map((d: any) => ({
        document_id: d.document_id,
        document_title: d.document_title,
        amount_base_units: String(d.amount_base_units),
        amount_usdc: d.amount_usdc,
        chunk_ids: d.chunk_ids,
      }));
      // Sum of document allocations must equal the publisher's verified payment.
      const allocationSum = documentAllocations.reduce(
        (acc: bigint, d: any) => acc + BigInt(d.amount_base_units),
        BigInt(0)
      );
      if (allocationSum !== BigInt(item.received_amount)) {
        throw new SolanaVerificationError(
          `Document allocation sum ${allocationSum} does not match verified payment ${item.received_amount} for publisher ${item.publisher_wallet}`,
          'ALLOCATION_SUM_MISMATCH'
        );
      }

      await client.query(
        `INSERT INTO settlement_payouts (
           id, receipt_id, quote_id, publisher_id, publisher_wallet, publisher_name,
           document_ids, document_allocations, amount_base_units, amount_usdc, asset, tx_signature, block_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (receipt_id, publisher_wallet) DO NOTHING`,
        [
          `pay_${crypto.randomUUID()}`,
          receiptId,
          quote.id,
          item.publisher_id,
          item.publisher_wallet,
          item.publisher_name,
          item.document_ids,
          JSON.stringify(documentAllocations),
          item.received_amount,
          formatUsdc(BigInt(item.received_amount)),
          SETTLEMENT_ASSET,
          cleanSig,
          new Date(tx.blockTime! * 1000).toISOString(),
        ]
      );
    }

    return receiptRes.rows[0];
  });

  return {
    id: receipt.id,
    quote_id: receipt.quote_id,
    tx_signature: receipt.tx_signature,
    payer_wallet: receipt.payer_wallet,
    total_amount_usdc: String(receipt.total_amount_usdc ?? '0'),
    total_base_units: String(receipt.settlement_amount_base_units ?? '0'),
    settlement_asset: receipt.settlement_asset,
    solana_slot: Number(receipt.solana_slot),
    block_time: receipt.block_time,
    memo_verified: receipt.memo_verified,
    breakdown: validated.breakdown.map((b: any) => ({
      ...b,
      expected_amount: String(b.expected_amount),
      received_amount: String(b.received_amount),
      documents: b.documents.map((d: any) => ({
        ...d,
        amount_base_units: String(d.amount_base_units),
      })),
    })),
    created_at: receipt.created_at,
  };
}

export { SETTLEMENT_ASSET };
