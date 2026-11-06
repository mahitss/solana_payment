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
  total_amount_usdc: number;
  total_base_units: number;
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

/** Computes the USDC balance delta for an owner between pre and post state. */
function usdcBalanceDelta(
  tx: ParsedTransactionWithMeta,
  owner: string
): bigint {
  const mint = DEVNET_USDC_MINT.toBase58();
  const pre = tx.meta?.preTokenBalances?.find(
    (b) => b.owner === owner && b.mint === mint
  );
  const post = tx.meta?.postTokenBalances?.find(
    (b) => b.owner === owner && b.mint === mint
  );

  const preAmt = BigInt(pre?.uiTokenAmount.amount || '0');
  const postAmt = BigInt(post?.uiTokenAmount.amount || '0');

  return postAmt - preAmt;
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
 * Performs rigorous, server-side cryptographic and on-chain verification of a
 * buyer settlement transaction.
 *
 * Every check fails closed: any doubt means the paid content is not released.
 */
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

  // 3. Verify on-chain execution status
  if (tx.meta.err !== null) {
    throw new SolanaVerificationError(
      `Transaction failed on-chain with error: ${JSON.stringify(tx.meta.err)}`,
      'TRANSACTION_FAILED'
    );
  }

  // D. Never accept a missing block time as proof of timing.
  if (!tx.blockTime) {
    throw new SolanaVerificationError(
      `Transaction ${cleanSig} has no block time. Cannot verify quote expiry.`,
      'TRANSACTION_NO_BLOCK_TIME'
    );
  }

  // 5. Verify Signer / Payer
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

  // 4. Verify Quote Expiry against Block Time
  const blockTimeSec = tx.blockTime;
  const quoteExpiresTimeSec = Math.floor(new Date(quote.expires_at).getTime() / 1000);

  // Allow a 60 second clock tolerance
  if (blockTimeSec > quoteExpiresTimeSec + 60) {
    throw new SolanaVerificationError(
      `Quote ${quote.id} expired at ${quote.expires_at}, but transaction was mined at ${new Date(
        blockTimeSec * 1000
      ).toISOString()}`,
      'QUOTE_EXPIRED'
    );
  }

  // 6. Verify Memo instruction matches quote.memo_expected exactly.
  //    A substring match would let a buyer append arbitrary data to the memo,
  //    which breaks the "exact digest match" guarantee the protocol promises.
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

  // 7. Verify Royalty Transfers to Publishers.
  //
  //    CiteRail settles exclusively in SPL USDC. Native SOL transfers are not
  //    accepted: the old implementation compared lamports against USDC base
  //    units, which made a transfer of 50,000 lamports count as a $0.05
  //    payment.
  const payerKey = new PublicKey(feePayer);
  const payerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, payerKey);
  const payerAtaStr = payerAta.toBase58();
  const usdcMintStr = DEVNET_USDC_MINT.toBase58();

  const splTransfers = extractSplTransfers(tx);

  // Every USDC transfer in this transaction must originate from the buyer's
  // authorized USDC token account and go to a publisher we priced. This
  // prevents third-party funding and extra USDC outflows in the same tx.
  const expectedDestinations = new Map<string, string>();
  for (const pub of quote.publisher_breakdown) {
    const pubKey = new PublicKey(pub.publisher_wallet);
    expectedDestinations.set(
      getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubKey).toBase58(),
      pub.publisher_wallet
    );
  }

  // Validate every SPL transfer before crediting any publisher.
  for (const transfer of splTransfers) {
    // Reject transfers that do not involve the configured USDC mint.
    if (transfer.mint !== undefined && transfer.mint !== usdcMintStr) continue;

    // B. Every accepted USDC payment must originate from the buyer's ATA.
    if (transfer.source !== payerAtaStr) continue;

    // E. Every USDC transfer must go to a priced publisher's ATA.
    if (!expectedDestinations.has(transfer.destination)) {
      throw new SolanaVerificationError(
        `Transaction contains an unexpected USDC transfer to ${transfer.destination}, which is not a publisher in quote ${quote.id}.`,
        'UNEXPECTED_TRANSFER'
      );
    }
  }

  let totalTransferredBaseUnits = 0n;
  const verifiedBreakdown: Array<{
    publisher_id: string;
    publisher_wallet: string;
    publisher_name: string;
    document_ids: string[];
    document_titles: string[];
    expected_amount: bigint;
    received_amount: bigint;
    verified: boolean;
  }> = [];

  // Track which transfers have already been credited to prevent double counting
  // when the same publisher appears under multiple documents (G) or duplicate
  // transfer instructions exist in the transaction.
  const creditedTransferIndices = new Set<number>();

  for (const pub of quote.publisher_breakdown) {
    const pubWalletKey = new PublicKey(pub.publisher_wallet);
    const expectedAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubWalletKey);
    const expectedAtaStr = expectedAta.toBase58();

    let amountReceivedForPub = 0n;

    for (let i = 0; i < splTransfers.length; i++) {
      const transfer = splTransfers[i];

      // Skip transfers already credited (prevents duplicate counting).
      if (creditedTransferIndices.has(i)) continue;

      // Must go to this publisher's ATA.
      if (transfer.destination !== expectedAtaStr) continue;

      // Mint must be USDC (proven via transferChecked or source ATA inference).
      if (transfer.mint !== undefined && transfer.mint !== usdcMintStr) continue;

      // Source must be the buyer's ATA (third-party funding rejected).
      if (transfer.source !== payerAtaStr) continue;

      const amount = transfer.amount;
      if (amount <= 0n) continue;

      amountReceivedForPub += amount;
      creditedTransferIndices.add(i);
    }

    // Cross-check against the mint-filtered balance delta. This path is
    // immune to mint confusion entirely and uses BigInt.
    const balanceDelta = usdcBalanceDelta(tx, pub.publisher_wallet);
    if (balanceDelta > amountReceivedForPub) {
      amountReceivedForPub = balanceDelta;
    }

    const expectedAmount = BigInt(pub.amount_base_units);
    if (amountReceivedForPub < expectedAmount) {
      throw new SolanaVerificationError(
        `Insufficient ${SETTLEMENT_ASSET} received for publisher ${pub.publisher_name} (${pub.publisher_wallet}). Expected ${expectedAmount} base units, received ${amountReceivedForPub} base units.`,
        'INSUFFICIENT_TRANSFER'
      );
    }

    totalTransferredBaseUnits += amountReceivedForPub;
    // Flatten all document IDs and titles from this publisher's contributions.
    const allDocumentIds = pub.documents.flatMap((d) => d.document_id);
    const allDocumentTitles = pub.documents.map((d) => d.document_title);
    verifiedBreakdown.push({
      publisher_id: pub.publisher_id,
      publisher_wallet: pub.publisher_wallet,
      publisher_name: pub.publisher_name,
      document_ids: allDocumentIds,
      document_titles: allDocumentTitles,
      expected_amount: expectedAmount,
      received_amount: amountReceivedForPub,
      verified: true,
    });
  }

  // 8. Verify the payer was actually debited in USDC.
  const payerDelta = usdcBalanceDelta(tx, feePayer);
  const expectedPayerDebit = -BigInt(quote.total_base_units);
  if (payerDelta > expectedPayerDebit) {
    throw new SolanaVerificationError(
      `Payer USDC balance decreased by ${Math.abs(Number(payerDelta))} base units, but the quote requires ${quote.total_base_units} base units.`,
      'PAYER_NOT_DEBITED'
    );
  }

  // 9. Verify the total paid covers the quote total (BigInt comparison).
  if (totalTransferredBaseUnits < BigInt(quote.total_base_units)) {
    throw new SolanaVerificationError(
      `Total settled amount ${totalTransferredBaseUnits} base units is below the quoted total ${quote.total_base_units} base units.`,
      'INSUFFICIENT_TOTAL'
    );
  }

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
      feePayer,
      formatUsdc(quote.total_base_units),
      SETTLEMENT_ASSET,
      quote.total_base_units,
      tx.slot,
      new Date(blockTimeSec * 1000).toISOString(),
      JSON.stringify(verifiedBreakdown),
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
    for (const item of verifiedBreakdown) {
      await client.query(
        `INSERT INTO settlement_payouts (
           id, receipt_id, quote_id, publisher_id, publisher_wallet, publisher_name,
           document_ids, amount_base_units, amount_usdc, asset, tx_signature, block_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (receipt_id, publisher_wallet) DO NOTHING`,
        [
          `pay_${crypto.randomUUID()}`,
          receiptId,
          quote.id,
          item.publisher_id,
          item.publisher_wallet,
          item.publisher_name,
          item.document_ids,
          item.received_amount,
          formatUsdc(Number(item.received_amount)),
          SETTLEMENT_ASSET,
          cleanSig,
          new Date(blockTimeSec * 1000).toISOString(),
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
    total_amount_usdc: parseFloat(receipt.total_amount_usdc),
    total_base_units: Number(receipt.settlement_amount_base_units),
    settlement_asset: receipt.settlement_asset,
    solana_slot: Number(receipt.solana_slot),
    block_time: receipt.block_time,
    memo_verified: receipt.memo_verified,
    breakdown: verifiedBreakdown.map((b) => ({
      ...b,
      expected_amount: Number(b.expected_amount),
      received_amount: Number(b.received_amount),
    })),
    created_at: receipt.created_at,
  };
}

export { SETTLEMENT_ASSET };
