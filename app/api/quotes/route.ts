import { NextResponse } from 'next/server';
import { searchKnowledgeCollections } from '@/lib/retrieval';
import { createPaymentQuote } from '@/lib/quotes';
import { isValidSolanaAddress } from '@/lib/publishers';
import { config } from '@/lib/config';
import { SETTLEMENT_ASSET } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { query: userQuery, buyerWallet } = await req.json().catch(() => ({}));

    if (!userQuery || typeof userQuery !== 'string' || !userQuery.trim()) {
      return NextResponse.json(
        { success: false, error: 'Query parameter is required.' },
        { status: 400 }
      );
    }

    const trimmedQuery = userQuery.trim();

    if (trimmedQuery.length > config.maxQueryLength) {
      return NextResponse.json(
        {
          success: false,
          error: `Query must be ${config.maxQueryLength} characters or fewer.`,
        },
        { status: 400 }
      );
    }

    if (buyerWallet && !isValidSolanaAddress(buyerWallet)) {
      return NextResponse.json(
        { success: false, error: 'Invalid buyer wallet address.' },
        { status: 400 }
      );
    }

    const matchedChunks = await searchKnowledgeCollections(trimmedQuery, 4);

    // No relevant sources means no quote and no charge. The previous
    // implementation fell back to returning arbitrary recent chunks, which
    // meant consumers were quoted and charged for content that had nothing to
    // do with their question.
    if (matchedChunks.length === 0) {
      return NextResponse.json({
        success: true,
        found: false,
        message:
          'No published knowledge sources matched this query in the licensed catalog.',
        matchedChunks: [],
      });
    }

    const quote = await createPaymentQuote(trimmedQuery, matchedChunks);

    const sourcesPreview = matchedChunks.map((c, i) => ({
      source_index: i + 1,
      document_title: c.document_title,
      publisher_name: c.publisher_name,
      publisher_wallet: c.publisher_wallet,
      price_usdc: c.price_per_query_usdc,
      preview_snippet: c.content.slice(0, 160) + '...',
    }));

    return NextResponse.json({
      success: true,
      found: true,
      settlementAsset: SETTLEMENT_ASSET,
      quote: {
        id: quote.id,
        quoteNonce: quote.quote_nonce,
        totalPriceUsdc: quote.total_price_usdc,
        totalBaseUnits: quote.total_base_units,
        memoExpected: quote.memo_expected,
        expiresAt: quote.expires_at,
        publisherBreakdown: quote.publisher_breakdown,
      },
      sourcesPreview,
    });
  } catch (err: any) {
    console.error('Error generating quote:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
