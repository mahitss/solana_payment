import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(
  req: Request,
  { params }: { params: { sig: string } }
) {
  try {
    const sig = params.sig;
    if (!sig) {
      return NextResponse.json({ success: false, error: 'Signature is required.' }, { status: 400 });
    }

    const receiptRes = await query(
      `SELECT r.*, q.query_text, q.total_price_usdc as quote_total_usdc, q.memo_expected,
              e.ai_provider, e.ai_model, e.citations
       FROM settlement_receipts r
       JOIN payment_quotes q ON r.quote_id = q.id
       LEFT JOIN query_executions e ON e.receipt_id = r.id
       WHERE r.tx_signature = $1`,
      [sig]
    );

    if (receiptRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: `No settlement receipt found for signature: ${sig}` },
        { status: 404 }
      );
    }

    const receipt = receiptRes.rows[0];

    return NextResponse.json({
      success: true,
      receipt: {
        id: receipt.id,
        txSignature: receipt.tx_signature,
        payerWallet: receipt.payer_wallet,
        totalAmountUsdc: parseFloat(receipt.total_amount_usdc),
        slot: Number(receipt.solana_slot),
        blockTime: receipt.block_time,
        memoVerified: receipt.memo_verified,
        memoExpected: receipt.memo_expected,
        breakdown: typeof receipt.breakdown === 'string' ? JSON.parse(receipt.breakdown) : receipt.breakdown,
        queryText: receipt.query_text,
        citations: receipt.citations ? (typeof receipt.citations === 'string' ? JSON.parse(receipt.citations) : receipt.citations) : [],
        aiProvider: receipt.ai_provider,
        aiModel: receipt.ai_model,
        explorerUrl: `https://explorer.solana.com/tx/${receipt.tx_signature}?cluster=devnet`,
        verifiedOnSolana: true,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
