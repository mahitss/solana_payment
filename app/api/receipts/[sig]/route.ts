import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { config } from '@/lib/config';
import { SETTLEMENT_ASSET } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

/**
 * Public verifier. Anyone holding a transaction signature can audit the
 * settlement: the payment is provable on-chain, so the receipt is public
 * information by design.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sig: string }> }
) {
  try {
    const { sig } = await params;
    if (!sig) {
      return NextResponse.json(
        { success: false, error: 'Signature is required.' },
        { status: 400 }
      );
    }

    const receiptRes = await query(
      `SELECT r.*, q.query_text, q.total_price_usdc as quote_total_usdc, q.memo_expected,
              e.ai_provider, e.ai_model, e.citations, e.generated_answer
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
    const breakdown = parseMaybeJson(receipt.breakdown) || [];

    return NextResponse.json({
      success: true,
      receipt: {
        id: receipt.id,
        txSignature: receipt.tx_signature,
        payerWallet: receipt.payer_wallet,
        totalAmountUsdc: String(receipt.total_amount_usdc ?? '0'),
        totalBaseUnits: String(receipt.settlement_amount_base_units ?? '0'),
        settlementAsset: receipt.settlement_asset || SETTLEMENT_ASSET,
        slot: Number(receipt.solana_slot),
        blockTime: receipt.block_time,
        memoVerified: receipt.memo_verified,
        memoExpected: receipt.memo_expected,
        breakdown: breakdown.map((b: any) => ({
          ...b,
          expected_amount: String(b.expected_amount ?? '0'),
          received_amount: String(b.received_amount ?? '0'),
          documents: (b.documents ?? []).map((d: any) => ({
            ...d,
            amount_base_units: String(d.amount_base_units ?? '0'),
          })),
        })),
        queryText: receipt.query_text,
        citations: parseMaybeJson(receipt.citations) || [],
        aiProvider: receipt.ai_provider,
        aiModel: receipt.ai_model,
        explorerUrl: `https://explorer.solana.com/tx/${receipt.tx_signature}?cluster=${config.solanaNetwork}`,
        verifiedOnSolana: true,
      },
    });
  } catch (err: any) {
    console.error('Receipt lookup error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
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
