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
import {
  SETTLEMENT_ASSET,
  USDC_BASE_UNIT,
  formatUsdc,
  fromBaseUnits,
} from './protocol';

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
): number {
  const mint = DEVNET_USDC_MINT.toBase58();
  const pre = tx.meta?.preTokenBalances?.find(
    (b) => b.owner === owner && b.mint === mint
  );
  const post = tx.meta?.postTokenBalances?.find(
    (b) => b.owner === owner && b.mint === mint
  );

  const preAmt = Number.parseInt(pre?.uiTokenAmount.amount || '0', 10);
  const postAmt = Number.parseInt(post?.uiTokenAmount.amount || '0', 10);

  return postAmt - preAmt;
}

interface SplTransfer {
  destination: string;
  source: string;
  amount: number;
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
      ? Number.parseInt(info.tokenAmount.amount, 10)
      : Number.parseInt(info.amount, 10);

    if (!Number.isFinite(amount)) continue;

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

  // 3. Verify on-chain execution status
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    throw new SolanaVerificationError(
      `Transaction failed on-chain with error: ${JSON.stringify(tx.meta.err)}`,
      'TRANSACTION_FAILED'
    );
  }

  // 4. Verify Quote Expiry against Block Time
  const blockTimeSec = tx.blockTime || Math.floor(Date.now() / 1000);
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

  // Every USDC transfer in this transaction must go to a publisher we priced.
  // This prevents a buyer from bundling extra USDC outflows into the same
  // atomic transaction.
  const expectedDestinations = new Map<string, string>();
  for (const pub of quote.publisher_breakdown) {
    const pubKey = new PublicKey(pub.publisher_wallet);
    expectedDestinations.set(
      getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubKey).toBase58(),
      pub.publisher_wallet
    );
  }

  for (const transfer of splTransfers) {
    // Determine whether this transfer is a USDC transfer.
    const isUsdc =
      transfer.mint !== undefined
        ? transfer.mint === usdcMintStr
        : transfer.source === payerAtaStr;

    if (!isUsdc) continue;

    if (!expectedDestinations.has(transfer.destination)) {
      throw new SolanaVerificationError(
        `Transaction contains an unexpected USDC transfer to ${transfer.destination}, which is not a publisher in quote ${quote.id}.`,
        'UNEXPECTED_TRANSFER'
      );
    }
  }

  let totalTransferredBaseUnits = 0;
  const verifiedBreakdown: Array<{
    publisher_id: string;
    publisher_wallet: string;
    publisher_name: string;
    document_id: string;
    document_title: string;
    expected_amount: number;
    received_amount: number;
    verified: boolean;
  }> = [];

  for (const pub of quote.publisher_breakdown) {
    const pubWalletKey = new PublicKey(pub.publisher_wallet);
    const expectedAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubWalletKey);
    const expectedAtaStr = expectedAta.toBase58();

    let amountReceivedForPub = 0;

    for (const transfer of splTransfers) {
      const destIsAta = transfer.destination === expectedAtaStr;
      const destIsWallet = transfer.destination === pub.publisher_wallet;

      if (!destIsAta && !destIsWallet) continue;

      // A transfer into the publisher's USDC ATA is necessarily USDC.
      // A transfer into the bare wallet could be any SPL token, so the mint
      // must be proven. For an unchecked `transfer` the mint is implied by the
      // source ATA, which must therefore be the payer's USDC ATA.
      if (destIsAta) {
        if (transfer.mint !== undefined && transfer.mint !== usdcMintStr) continue;
        amountReceivedForPub += transfer.amount;
        continue;
      }

      if (transfer.mint === usdcMintStr) {
        amountReceivedForPub += transfer.amount;
      } else if (transfer.mint === undefined && transfer.source === payerAtaStr) {
        amountReceivedForPub += transfer.amount;
      }
    }

    // Cross-check against the mint-filtered balance delta. This path is
    // immune to mint confusion entirely.
    const balanceDelta = usdcBalanceDelta(tx, pub.publisher_wallet);
    if (balanceDelta > amountReceivedForPub) {
      amountReceivedForPub = balanceDelta;
    }

    if (amountReceivedForPub < pub.amount_base_units) {
      throw new SolanaVerificationError(
        `Insufficient ${SETTLEMENT_ASSET} received for publisher ${pub.publisher_name} (${pub.publisher_wallet}). Expected ${pub.amount_base_units} base units, received ${amountReceivedForPub} base units.`,
        'INSUFFICIENT_TRANSFER'
      );
    }

    totalTransferredBaseUnits += amountReceivedForPub;
    verifiedBreakdown.push({
      publisher_id: pub.publisher_id,
      publisher_wallet: pub.publisher_wallet,
      publisher_name: pub.publisher_name,
      document_id: pub.document_id,
      document_title: pub.document_title,
      expected_amount: pub.amount_base_units,
      received_amount: amountReceivedForPub,
      verified: true,
    });
  }

  // 8. Verify the payer was actually debited in USDC.
  const payerDelta = usdcBalanceDelta(tx, feePayer);
  if (payerDelta > -quote.total_base_units) {
    throw new SolanaVerificationError(
      `Payer USDC balance decreased by ${Math.abs(payerDelta)} base units, but the quote requires ${quote.total_base_units} base units.`,
      'PAYER_NOT_DEBITED'
    );
  }

  // 9. Verify the total paid covers the quote total.
  if (totalTransferredBaseUnits < quote.total_base_units) {
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
           amount_base_units, amount_usdc, asset, tx_signature, block_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (receipt_id, publisher_wallet) DO NOTHING`,
        [
          `pay_${cryptoRandomId()}`,
          receiptId,
          quote.id,
          item.publisher_id,
          item.publisher_wallet,
          item.publisher_name,
          item.received_amount,
          formatUsdc(item.received_amount),
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
    breakdown: verifiedBreakdown,
    created_at: receipt.created_at,
  };
}

function cryptoRandomId(): string {
  // Imported lazily to keep the module's import surface small.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').randomUUID();
}

export { USDC_BASE_UNIT, fromBaseUnits };
