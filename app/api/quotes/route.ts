import { NextResponse } from 'next/server';
import { searchKnowledgeCollections } from '@/lib/retrieval';
import { createPaymentQuote } from '@/lib/quotes';
import { requireAuth, AuthError } from '@/lib/auth';
import { config } from '@/lib/config';
import { SETTLEMENT_ASSET } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

/**
 * Generates a payment quote for a consumer query.
 *
 * Requires an authenticated buyer session. The buyer wallet is derived from
 * the session token, never from the request body, so a caller cannot bind a
 * quote to a wallet they do not control.
 *
 * The response contains only metadata safe to display pre-payment:
 * document title, publisher name, publisher wallet, price, and quote expiry.
 * Raw document passages, chunk contents, and paid answer material are never
 * exposed before payment is verified.
 */
export async function POST(req: Request) {
  try {
    // Require buyer authentication before any quote is generated.
    const session = requireAuth(req);
    const buyerWallet = session.wallet;

    const { query: userQuery } = await req.json().catch(() => ({}));

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

    const matchedChunks = await searchKnowledgeCollections(trimmedQuery, 4);

    // No relevant sources means no quote and no charge.
    if (matchedChunks.length === 0) {
      return NextResponse.json({
        success: true,
        found: false,
        message:
          'No published knowledge sources matched this query in the licensed catalog.',
        matchedChunks: [],
      });
    }

    const quote = await createPaymentQuote(trimmedQuery, matchedChunks, buyerWallet);

    // Pre-payment preview: metadata only. No raw content, no snippets.
    const sourcesPreview = matchedChunks.map((c, i) => ({
      source_index: i + 1,
      document_title: c.document_title,
      publisher_name: c.publisher_name,
      publisher_wallet: c.publisher_wallet,
      price_usdc: c.price_per_query_usdc,
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
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('Error generating quote:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
