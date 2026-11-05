import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getPublisherByWallet, isValidSolanaAddress } from '@/lib/publishers';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet');

    if (!wallet || !isValidSolanaAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'A valid Solana wallet address is required.' },
        { status: 400 }
      );
    }

    const publisher = await getPublisherByWallet(wallet);
    if (!publisher) {
      return NextResponse.json(
        { success: true, registered: false, message: 'Wallet is not yet registered as a publisher.' },
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

    // 2. Fetch all verified receipts involving this publisher's wallet
    const receiptsRes = await query(
      `SELECT r.id, r.tx_signature, r.payer_wallet, r.total_amount_usdc, r.block_time, r.solana_slot, r.breakdown,
              q.query_text
       FROM settlement_receipts r
       JOIN payment_quotes q ON r.quote_id = q.id
       ORDER BY r.block_time DESC`
    );

    let totalEarnedUsdc = 0;
    let queryCount = 0;
    const ledger: Array<{
      receipt_id: string;
      tx_signature: string;
      payer_wallet: string;
      amount_earned_usdc: number;
      query_text: string;
      block_time: string;
      explorer_url: string;
    }> = [];

    for (const row of receiptsRes.rows) {
      const breakdown = typeof row.breakdown === 'string' ? JSON.parse(row.breakdown) : row.breakdown;
      if (Array.isArray(breakdown)) {
        const item = breakdown.find((b: any) => b.publisher_wallet === wallet);
        if (item && item.received_amount) {
          const earned = item.received_amount / 1_000_000;
          totalEarnedUsdc += earned;
          queryCount++;
          ledger.push({
            receipt_id: row.id,
            tx_signature: row.tx_signature,
            payer_wallet: row.payer_wallet,
            amount_earned_usdc: earned,
            query_text: row.query_text,
            block_time: row.block_time,
            explorer_url: `https://explorer.solana.com/tx/${row.tx_signature}?cluster=devnet`,
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      registered: true,
      publisher: {
        id: publisher.id,
        walletAddress: publisher.wallet_address,
        name: publisher.name,
        email: publisher.email,
        totalRevenueUsdc: totalEarnedUsdc,
        totalQueriesAnswered: queryCount,
        documents: docsRes.rows,
        ledger,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
