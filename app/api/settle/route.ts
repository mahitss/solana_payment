import { NextResponse } from 'next/server';
import { getQuote } from '@/lib/quotes';
import { verifySettlementTransaction, SolanaVerificationError } from '@/lib/solana';
import { getActiveAIProvider } from '@/lib/ai/provider';
import { query } from '@/lib/db';
import { ChunkRecord } from '@/lib/documents';
import { SETTLEMENT_ASSET } from '@/lib/protocol';
import { computeSha256 } from '@/lib/chunker';
import { computeSourceDigest } from '@/lib/protocol';
import crypto from 'crypto';
import { requireAuth, AuthError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Settles a quote.
 *
 * Requires an authenticated buyer session. The buyer wallet is derived from
 * the session token and bound to the quote at creation time. Settlement
 * verifies that the transaction fee payer matches the authenticated buyer,
 * then verifies on-chain payment, then releases the paid answer.
 *
 * Order of operations: payment verified and recorded FIRST, then answer
 * generated. Idempotent — re-posting a redeemed quote returns the existing
 * receipt and (if needed) produces the answer without charging twice.
 */
export async function POST(req: Request) {
  try {
    // TASK 2: Settlement requires a valid authenticated session.
    const session = requireAuth(req);
    const buyerWallet = session.wallet;

    const { quoteId, txSignature } = await req.json().catch(() => ({}));

    // Never trust buyerWallet from the request body. The expected payer is
    // derived from the persisted quote data (Task 2, item 4 & 6).
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

    // TASK 2, item 8 & 9: Already-redeemed quotes return answers only to
    // their authenticated buyer.
    if (quote.status === 'REDEEMED') {
      // TASK 2, item 9: Only the authenticated buyer can retrieve the answer.
      if (quote.buyer_wallet !== buyerWallet) {
        return NextResponse.json(
          { success: false, error: 'This quote was purchased by a different wallet.' },
          { status: 403 }
        );
      }

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

      // TASK 2, item 10: Verify the original transaction signature matches
      // the recorded settlement.
      if (row.tx_signature !== txSignature) {
        return NextResponse.json(
          { success: false, error: 'Transaction signature does not match the recorded settlement.' },
          { status: 400 }
        );
      }

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

    // TASK 3: Source Integrity BEFORE settlement — verify exact purchased
    // chunks before allowing payment. Check every chunk's SHA-256 hash,
    // verify the combined source digest, ensure retrieved chunk IDs match
    // the quote exactly, and preserve deterministic source order.
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

    if (chunks.length !== quote.matched_chunk_ids.length) {
      // Reject missing chunks — no partial fulfillment, no receipt written.
      return NextResponse.json(
        {
          success: false,
          error:
            'Some purchased knowledge sources are no longer available. No settlement was recorded.',
        },
        { status: 409 }
      );
    }

    // Verify chunk IDs match the quote exactly, in deterministic order.
    const retrievedIds = chunks.map((c) => c.id);
    const expectedIds = [...quote.matched_chunk_ids];
    if (JSON.stringify(retrievedIds.sort()) !== JSON.stringify(expectedIds.sort())) {
      return NextResponse.json(
        {
          success: false,
          error: 'Retrieved chunk IDs do not match the quoted sources.',
        },
        { status: 409 }
      );
    }

    // Recalculate each SHA-256 content hash and verify against stored hash.
    for (const chunk of chunks) {
      const recalculatedHash = computeSha256(chunk.content);
      if (recalculatedHash !== chunk.content_hash) {
        return NextResponse.json(
          {
            success: false,
            error: `Source integrity check failed for chunk ${chunk.id}: content has been modified.`,
          },
          { status: 409 }
        );
      }
    }

    // Recalculate the combined source digest and verify against the memo.
    const recalculatedDigest = computeSourceDigest(chunks.map((c) => c.content_hash));
    const memoDigest = quote.memo_expected.split(':').pop() || '';
    if (recalculatedDigest !== memoDigest) {
      return NextResponse.json(
        {
          success: false,
          error: 'Source digest mismatch: purchased content does not match the quoted sources.',
        },
        { status: 409 }
      );
    }

    // 3. Perform Server-Side On-Chain Settlement Verification.
    //    Only reached after source integrity has been verified. The expected
    //    payer is derived from the quote's buyer_wallet, not from the request body.
    const receipt = await verifySettlementTransaction(txSignature, quote, buyerWallet);

    // TASK 3, item 8: Validate source integrity again before AI generation.
    // Re-fetch chunks and re-verify to prevent modification between integrity
    // check and settlement. This is a defense-in-depth check.
    const postSettlementChunksRes = await query<ChunkRecord>(
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

    const postSettlementChunks = postSettlementChunksRes.rows;
    if (postSettlementChunks.length !== quote.matched_chunk_ids.length) {
      return NextResponse.json(
        {
          success: false,
          paymentSettled: true,
          error:
            'Some purchased knowledge sources are no longer available after settlement. The receipt has been recorded; please contact support.',
        },
        { status: 409 }
      );
    }

    for (const chunk of postSettlementChunks) {
      const recalculatedHash = computeSha256(chunk.content);
      if (recalculatedHash !== chunk.content_hash) {
        return NextResponse.json(
          {
            success: false,
            paymentSettled: true,
            error: `Source integrity check failed for chunk ${chunk.id} after settlement: content has been modified.`,
          },
          { status: 409 }
        );
      }
    }

    const postSettlementDigest = computeSourceDigest(
      postSettlementChunks.map((c) => c.content_hash)
    );
    if (postSettlementDigest !== memoDigest) {
      return NextResponse.json(
        {
          success: false,
          paymentSettled: true,
          error: 'Source digest mismatch after settlement.',
        },
        { status: 409 }
      );
    }

    // Use post-settlement chunks for AI generation.
    const aiChunks = postSettlementChunks;

    // 4. Grounded AI Generation (fails closed when no provider is reachable)
    let generated: {
      answer: string;
      citations: any;
      provider: string;
      model: string;
    };

    try {
      generated = await generateAndRecord(quote, receipt.id, aiChunks);
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
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
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

/**
 * TASK 3: Validate source integrity before AI generation.
 * Checks every chunk's SHA-256 hash and verifies the combined source digest
 * against the memo commitment.
 */
function validateSourceIntegrity(
  chunks: ChunkRecord[],
  memoExpected: string
): void {
  const memoDigest = memoExpected.split(':').pop() || '';

  // Recalculate each SHA-256 content hash and verify against stored hash.
  for (const chunk of chunks) {
    const recalculatedHash = computeSha256(chunk.content);
    if (recalculatedHash !== chunk.content_hash) {
      throw new Error(
        `Source integrity check failed for chunk ${chunk.id}: content has been modified.`
      );
    }
  }

  // Recalculate the combined source digest and verify against the memo.
  const recalculatedDigest = computeSourceDigest(
    chunks.map((c) => c.content_hash)
  );
  if (recalculatedDigest !== memoDigest) {
    throw new Error(
      'Source digest mismatch: purchased content does not match the quoted sources.'
    );
  }
}

async function generateAndRecord(
  quote: {
    id: string;
    query_text: string;
    matched_chunk_ids: string[];
    memo_expected: string;
  },
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

  if (!chunks || chunks.length !== quote.matched_chunk_ids.length) {
    throw new Error('The paid knowledge sources are no longer available.');
  }

  // TASK 3, item 8: Validate source integrity again before AI generation.
  validateSourceIntegrity(chunks, quote.memo_expected);

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
