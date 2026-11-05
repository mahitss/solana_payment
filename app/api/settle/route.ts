import { NextResponse } from 'next/server';
import { getQuote } from '@/lib/quotes';
import { verifySettlementTransaction, SolanaVerificationError } from '@/lib/solana';
import { getActiveAIProvider } from '@/lib/ai/provider';
import { query } from '@/lib/db';
import { ChunkRecord } from '@/lib/documents';
import crypto from 'crypto';

export async function POST(req: Request) {
  try {
    const { quoteId, txSignature, buyerWallet } = await req.json();

    if (!quoteId || typeof quoteId !== 'string') {
      return NextResponse.json({ success: false, error: 'quoteId is required.' }, { status: 400 });
    }

    if (!txSignature || typeof txSignature !== 'string') {
      return NextResponse.json({ success: false, error: 'txSignature is required.' }, { status: 400 });
    }

    // 1. Fetch Quote
    const quote = await getQuote(quoteId);
    if (!quote) {
      return NextResponse.json({ success: false, error: `Quote ${quoteId} not found.` }, { status: 404 });
    }

    if (quote.status === 'REDEEMED') {
      return NextResponse.json(
        { success: false, error: 'This quote has already been redeemed and cannot be reused.' },
        { status: 409 }
      );
    }

    if (new Date() > new Date(quote.expires_at)) {
      return NextResponse.json(
        { success: false, error: `This quote expired at ${quote.expires_at}. Please request a new quote.` },
        { status: 410 }
      );
    }

    // 2. Perform Server-Side On-Chain Settlement Verification
    // CRITICAL: Paid content is NEVER released before on-chain confirmation & validation
    const receipt = await verifySettlementTransaction(txSignature, quote, buyerWallet);

    // 3. Retrieve the Exact Matched Chunks
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

    // 4. Grounded AI Generation (Fail Closed Provider Abstraction)
    const aiProvider = await getActiveAIProvider();
    const groundedResult = await aiProvider.generateAnswer(quote.query_text, chunks);

    // 5. Record Query Execution
    const execId = `exec_${crypto.randomUUID()}`;
    await query(
      `INSERT INTO query_executions (
        id, receipt_id, query_text, ai_provider, ai_model, generated_answer, citations
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        execId,
        receipt.id,
        quote.query_text,
        groundedResult.provider,
        groundedResult.model,
        groundedResult.answer,
        JSON.stringify(groundedResult.citations),
      ]
    );

    return NextResponse.json({
      success: true,
      answer: groundedResult.answer,
      citations: groundedResult.citations,
      provider: groundedResult.provider,
      model: groundedResult.model,
      receipt: {
        id: receipt.id,
        txSignature: receipt.tx_signature,
        payerWallet: receipt.payer_wallet,
        totalAmountUsdc: receipt.total_amount_usdc,
        slot: receipt.solana_slot,
        blockTime: receipt.block_time,
        memoVerified: receipt.memo_verified,
        breakdown: receipt.breakdown,
        solanaExplorerUrl: `https://explorer.solana.com/tx/${receipt.tx_signature}?cluster=devnet`,
      },
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
