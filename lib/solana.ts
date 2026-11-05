import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  ParsedInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { query, pool } from './db';
import { PaymentQuote } from './quotes';

export const DEVNET_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
export const DEVNET_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);
export const MEMO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

export interface ReceiptRecord {
  id: string;
  quote_id: string;
  tx_signature: string;
  payer_wallet: string;
  total_amount_usdc: number;
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

/**
 * Performs rigorous, server-side cryptographic and on-chain verification
 * of a buyer settlement transaction.
 */
export async function verifySettlementTransaction(
  txSignature: string,
  quote: PaymentQuote,
  expectedPayer?: string
): Promise<ReceiptRecord> {
  const cleanSig = txSignature.trim();
  if (!cleanSig || cleanSig.length < 60) {
    throw new SolanaVerificationError('Invalid transaction signature format.', 'INVALID_SIGNATURE');
  }

  // 1. Check for Replay Attack in Database
  const replayCheck = await query('SELECT * FROM settlement_receipts WHERE tx_signature = $1', [cleanSig]);
  if (replayCheck.rows.length > 0) {
    throw new SolanaVerificationError(
      `Transaction signature ${cleanSig} has already been redeemed. Replay attacks are rejected.`,
      'REPLAY_DETECTED'
    );
  }

  // 2. Fetch confirmed transaction from Solana Devnet RPC
  const connection = getSolanaConnection();
  const tx = await connection.getParsedTransaction(cleanSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new SolanaVerificationError(
      `Transaction ${cleanSig} was not found on Solana Devnet. Ensure it has been confirmed.`,
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
  if (expectedPayer && feePayer !== expectedPayer) {
    throw new SolanaVerificationError(
      `Transaction payer mismatch. Expected: ${expectedPayer}, got: ${feePayer}`,
      'PAYER_MISMATCH'
    );
  }

  // 6. Verify Memo instruction matching quote.memo_expected
  const memoText = extractMemoFromParsedTx(tx);
  if (!memoText || !memoText.includes(quote.memo_expected)) {
    throw new SolanaVerificationError(
      `Transaction memo verification failed. Expected memo containing "${quote.memo_expected}", got: "${memoText || 'none'}"`,
      'MEMO_MISMATCH'
    );
  }

  // 7. Verify Royalty Transfers to Publishers
  // Check either SPL Token transfer (USDC) or Native SOL transfer fallback
  let totalTransferredBaseUnits = 0;
  const verifiedBreakdown: Array<{
    publisher_wallet: string;
    expected_amount: number;
    received_amount: number;
    verified: boolean;
  }> = [];

  for (const pub of quote.publisher_breakdown) {
    const pubWalletKey = new PublicKey(pub.publisher_wallet);
    const expectedAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pubWalletKey);

    let amountReceivedForPub = 0;

    // Scan parsed instructions
    const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
      ...tx.transaction.message.instructions,
    ];
    if (tx.meta?.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        allInstructions.push(...inner.instructions);
      }
    }

    for (const ix of allInstructions) {
      if ('parsed' in ix && ix.parsed) {
        const type = ix.parsed.type;
        const info = ix.parsed.info;

        // SPL Token transfer (USDC)
        if (
          ix.program === 'spl-token' &&
          (type === 'transfer' || type === 'transferChecked') &&
          info
        ) {
          const dest = info.destination;
          const transferAmount = info.tokenAmount
            ? parseInt(info.tokenAmount.amount, 10)
            : parseInt(info.amount, 10);

          if (
            dest === expectedAta.toBase58() ||
            dest === pub.publisher_wallet
          ) {
            amountReceivedForPub += transferAmount;
          }
        }

        // Native SOL transfer support (SystemProgram transfer)
        if (
          ix.program === 'system' &&
          type === 'transfer' &&
          info &&
          info.destination === pub.publisher_wallet
        ) {
          // Native SOL lamports
          amountReceivedForPub += parseInt(info.lamports, 10);
        }
      }
    }

    // Verify amount received meets minimum expected
    if (amountReceivedForPub < pub.amount_base_units) {
      // Also check postTokenBalances / preTokenBalances delta for the recipient ATA
      let balanceDelta = 0;
      if (tx.meta?.postTokenBalances && tx.meta?.preTokenBalances) {
        const post = tx.meta.postTokenBalances.find(
          (b) => b.owner === pub.publisher_wallet && b.mint === DEVNET_USDC_MINT.toBase58()
        );
        const pre = tx.meta.preTokenBalances.find(
          (b) => b.owner === pub.publisher_wallet && b.mint === DEVNET_USDC_MINT.toBase58()
        );
        const postAmt = parseInt(post?.uiTokenAmount.amount || '0', 10);
        const preAmt = parseInt(pre?.uiTokenAmount.amount || '0', 10);
        balanceDelta = Math.max(0, postAmt - preAmt);
      }

      if (balanceDelta >= pub.amount_base_units) {
        amountReceivedForPub = balanceDelta;
      } else {
        throw new SolanaVerificationError(
          `Insufficient payment received for publisher ${pub.publisher_name} (${pub.publisher_wallet}). Expected ${pub.amount_base_units} units, received ${amountReceivedForPub} units.`,
          'INSUFFICIENT_TRANSFER'
        );
      }
    }

    totalTransferredBaseUnits += amountReceivedForPub;
    verifiedBreakdown.push({
      publisher_wallet: pub.publisher_wallet,
      expected_amount: pub.amount_base_units,
      received_amount: amountReceivedForPub,
      verified: true,
    });
  }

  // 8. Atomic Persistence: Record Receipt & Mark Quote Redeemed
  const client = await pool.connect();
  const receiptId = `rcpt_${txSignature.slice(0, 16)}`;

  try {
    await client.query('BEGIN');

    const insertReceiptSql = `
      INSERT INTO settlement_receipts (
        id, quote_id, tx_signature, payer_wallet, total_amount_usdc,
        solana_slot, block_time, memo_verified, breakdown
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
      RETURNING *;
    `;

    const receiptRes = await client.query(insertReceiptSql, [
      receiptId,
      quote.id,
      cleanSig,
      feePayer || 'unknown',
      quote.total_price_usdc,
      tx.slot,
      new Date(blockTimeSec * 1000).toISOString(),
      JSON.stringify(verifiedBreakdown),
    ]);

    await client.query(
      `UPDATE payment_quotes SET status = 'REDEEMED' WHERE id = $1`,
      [quote.id]
    );

    await client.query('COMMIT');

    const r = receiptRes.rows[0];
    return {
      id: r.id,
      quote_id: r.quote_id,
      tx_signature: r.tx_signature,
      payer_wallet: r.payer_wallet,
      total_amount_usdc: parseFloat(r.total_amount_usdc),
      solana_slot: Number(r.solana_slot),
      block_time: r.block_time,
      memo_verified: r.memo_verified,
      breakdown: verifiedBreakdown,
      created_at: r.created_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
