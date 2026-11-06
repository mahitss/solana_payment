import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getPublisherByWallet } from '@/lib/publishers';
import { AuthError, requireAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import { SETTLEMENT_ASSET } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

/**
 * Publisher economics.
 *
 * Requires an authenticated wallet session and returns only the authenticated
 * wallet's own revenue. Previously this endpoint accepted any wallet address
 * as a query parameter and returned that publisher's full earnings ledger and
 * query history to whoever asked.
 *
 * Aggregation happens in SQL against the indexed `settlement_payouts` table.
 * The previous implementation loaded every receipt in the database and
 * filtered the JSONB breakdown in application code, which was O(all receipts)
 * per request.
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const wallet = session.wallet;

    const publisher = await getPublisherByWallet(wallet);
    if (!publisher) {
      return NextResponse.json(
        {
          success: true,
          registered: false,
          message: 'Wallet is not yet registered as a publisher.',
        },
        { status: 200 }
      );
    }

    // 1. Documents authored by this publisher
    const docsRes = await query(
      `SELECT id, title, file_type, content_hash, license_type, price_per_query_usdc, total_chunks, created_at
       FROM documents
       WHERE publisher_id = $1
       ORDER BY created_at DESC`,
      [publisher.id]
    );

    // 2. Aggregated revenue and ledger from the normalised payout table
    const summaryRes = await query(
      `SELECT
         COALESCE(SUM(amount_base_units), 0)::bigint AS total_base_units,
         COUNT(*)::int AS payout_count
       FROM settlement_payouts
       WHERE publisher_wallet = $1`,
      [wallet]
    );

    const ledgerRes = await query(
      `SELECT
         receipt_id,
         tx_signature,
         quote_id,
         publisher_name,
         amount_base_units,
         amount_usdc,
         asset,
         block_time
       FROM settlement_payouts
       WHERE publisher_wallet = $1
       ORDER BY block_time DESC
       LIMIT 200`,
      [wallet]
    );

    const totalBaseUnits = Number(summaryRes.rows[0]?.total_base_units ?? 0);
    const totalEarnedUsdc = totalBaseUnits / 1_000_000;

    const ledger = ledgerRes.rows.map((row: any) => ({
      receipt_id: row.receipt_id,
      tx_signature: row.tx_signature,
      quote_id: row.quote_id,
      publisher_name: row.publisher_name,
      amount_earned_usdc: Number(row.amount_usdc),
      amount_base_units: Number(row.amount_base_units),
      asset: row.asset || SETTLEMENT_ASSET,
      query_text: null,
      block_time: row.block_time,
      explorer_url: `https://explorer.solana.com/tx/${row.tx_signature}?cluster=${config.solanaNetwork}`,
    }));

    return NextResponse.json({
      success: true,
      registered: true,
      publisher: {
        id: publisher.id,
        walletAddress: publisher.wallet_address,
        name: publisher.name,
        email: publisher.email,
        verified: Boolean(publisher.verified_at),
        totalRevenueUsdc: totalEarnedUsdc,
        totalQueriesAnswered: summaryRes.rows[0]?.payout_count ?? 0,
        settlementAsset: SETTLEMENT_ASSET,
        documents: docsRes.rows,
        ledger,
      },
    });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('Publisher economics error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
