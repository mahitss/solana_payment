import { NextResponse } from 'next/server';
import { getQuote } from '@/lib/quotes';
import { verifySettlementTransaction, SolanaVerificationError } from '@/lib/solana';
import { getActiveAIProvider } from '@/lib/ai/provider';
import { query } from '@/lib/db';
import { ChunkRecord } from '@/lib/documents';
import { SETTLEMENT_ASSET } from '@/lib/protocol';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

interface ExecutionRow {
  id: string;
  ai_provider: string;
  ai_model: string;
  generated_answer: string;
  citations: any;
}

/**
 * Settles a quote.
 *
 * Order of operations is deliberate: the on-chain payment is verified and
 * recorded FIRST, and only then is the answer generated. If generation fails
 * the payment is still settled and recorded, and the endpoint stays
 * idempotent so the consumer can retry generation without paying twice.
 */
export async function POST(req: Request) {
  try {
    const { quoteId, txSignature, buyerWallet } = await req.json().catch(() => ({}));

    if (!quoteId || typeof quoteId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'quoteId is required.' },
        { status: 400 }
      );
    }

    if (!txSignature || typeof txSignature !== 'string') {
      return NextResponse.json(
        { success: false, error: 'txSignature is required.' },
        { status: 400 }
      );
    }

    // 1. Fetch Quote
    const quote = await getQuote(quoteId);
    if (!quote) {
      return NextResponse.json(
        { success: false, error: `Quote ${quoteId} not found.` },
        { status: 404 }
      );
    }

    // 2. Idempotent path: the quote was already settled. Return the existing
    //    receipt, regenerating the answer if it was never produced.
    if (quote.status === 'REDEEMED') {
      const existing = await query(
        `SELECT r.*, e.id AS exec_id, e.ai_provider, e.ai_model, e.generated_answer, e.citations
         FROM settlement_receipts r
         LEFT JOIN query_executions e ON e.receipt_id = r.id
         WHERE r.quote_id = $1
         ORDER BY e.created_at DESC
         LIMIT 1`,
        [quote.id]
      );

      if (existing.rows.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Quote is marked redeemed but no receipt was found.' },
          { status: 409 }
        );
      }

      const row = existing.rows[0];

      if (row.generated_answer) {
        return NextResponse.json({
          success: true,
          alreadySettled: true,
          answer: row.generated_answer,
          citations: parseMaybeJson(row.citations),
          provider: row.ai_provider,
          model: row.ai_model,
          receipt: serialiseReceipt(row),
        });
      }

      // Paid, but the answer was never generated. Produce it now.
      const answer = await generateAndRecord(quote, row.id);
      return NextResponse.json({
        success: true,
        alreadySettled: true,
        ...answer,
        receipt: serialiseReceipt(row),
      });
    }

    if (new Date() > new Date(quote.expires_at)) {
      return NextResponse.json(
        {
          success: false,
          error: `This quote expired at ${quote.expires_at}. Please request a new quote.`,
        },
        { status: 410 }
      );
    }

    // 3. Perform Server-Side On-Chain Settlement Verification.
    //    CRITICAL: Paid content is NEVER released before on-chain confirmation.
    const receipt = await verifySettlementTransaction(txSignature, quote, buyerWallet);

    // 4. Retrieve the Exact Matched Chunks
    const chunksRes = await query<ChunkRecord>(
      `SELECT
         c.id, c.document_id, c.publisher_id, c.chunk_index, c.content, c.content_hash, c.token_count,
         d.title as document_title, d.price_per_query_usdc,
         p.wallet_address as publisher_wallet, p.name as publisher_name
       FROM document_chunks c
       JOIN documents d ON c.document_id = d.id
       JOIN publishers p ON c.publisher_id = p.id
       WHERE c.id = ANY($1::varchar[])
       ORDER BY c.chunk_index ASC`,
      [quote.matched_chunk_ids]
    );

    const chunks = chunksRes.rows;

    if (chunks.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'The paid knowledge sources are no longer available. The receipt has been recorded; please contact support.',
        },
        { status: 409 }
      );
    }

    // 5. Grounded AI Generation (fails closed when no provider is reachable)
    let generated: {
      answer: string;
      citations: any;
      provider: string;
      model: string;
    };

    try {
      generated = await generateAndRecord(quote, receipt.id, chunks);
    } catch (aiErr: any) {
      // The payment is verified and recorded. Report that clearly instead of
      // pretending the whole operation failed - the consumer can retry.
      console.error('Answer generation failed after successful settlement:', aiErr);
      return NextResponse.json({
        success: false,
        paymentSettled: true,
        error: `Payment settled successfully, but the answer could not be generated: ${aiErr.message}`,
        receipt: serialiseReceipt(receipt),
      });
    }

    return NextResponse.json({
      success: true,
      ...generated,
      receipt: serialiseReceipt(receipt),
    });
  } catch (err: any) {
    console.error('Settlement verification error:', err);
    if (err instanceof SolanaVerificationError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

async function generateAndRecord(
  quote: { id: string; query_text: string; matched_chunk_ids: string[] },
  receiptId: string,
  preloadedChunks?: ChunkRecord[]
): Promise<{
  answer: string;
  citations: any;
  provider: string;
  model: string;
}> {
  let chunks = preloadedChunks;

  if (!chunks) {
    const chunksRes = await query<ChunkRecord>(
      `SELECT
         c.id, c.document_id, c.publisher_id, c.chunk_index, c.content, c.content_hash, c.token_count,
         d.title as document_title, d.price_per_query_usdc,
         p.wallet_address as publisher_wallet, p.name as publisher_name
       FROM document_chunks c
       JOIN documents d ON c.document_id = d.id
       JOIN publishers p ON c.publisher_id = p.id
       WHERE c.id = ANY($1::varchar[])
       ORDER BY c.chunk_index ASC`,
      [quote.matched_chunk_ids]
    );
    chunks = chunksRes.rows;
  }

  if (!chunks || chunks.length === 0) {
    throw new Error('The paid knowledge sources are no longer available.');
  }

  const aiProvider = await getActiveAIProvider();
  const groundedResult = await aiProvider.generateAnswer(quote.query_text, chunks);

  const execId = `exec_${crypto.randomUUID()}`;
  await query(
    `INSERT INTO query_executions (
      id, receipt_id, query_text, ai_provider, ai_model, generated_answer, citations
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      execId,
      receiptId,
      quote.query_text,
      groundedResult.provider,
      groundedResult.model,
      groundedResult.answer,
      JSON.stringify(groundedResult.citations),
    ]
  );

  return {
    answer: groundedResult.answer,
    citations: groundedResult.citations,
    provider: groundedResult.provider,
    model: groundedResult.model,
  };
}

function serialiseReceipt(row: any) {
  return {
    id: row.id,
    txSignature: row.tx_signature,
    payerWallet: row.payer_wallet,
    totalAmountUsdc: parseFloat(row.total_amount_usdc),
    totalBaseUnits: Number(row.settlement_amount_base_units ?? 0),
    settlementAsset: row.settlement_asset || SETTLEMENT_ASSET,
    slot: Number(row.solana_slot),
    blockTime: row.block_time,
    memoVerified: row.memo_verified,
    breakdown: parseMaybeJson(row.breakdown),
    solanaExplorerUrl: `https://explorer.solana.com/tx/${row.tx_signature}?cluster=devnet`,
  };
}

function parseMaybeJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
