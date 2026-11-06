import crypto from 'crypto';
import { query } from './db';
import { ChunkRecord } from './documents';
import { computeSha256 } from './chunker';
import { config } from './config';
import {
  SETTLEMENT_ASSET,
  buildMemoPayload,
  computeSourceDigest,
  formatUsdc,
  fromBaseUnits,
  toBaseUnits,
} from './protocol';

export interface DocumentContribution {
  document_id: string;
  document_title: string;
  chunk_ids: string[];
  /** Price for this document, in USDC base units (6 dp). */
  amount_base_units: number;
  /** Price for this document, in whole USDC. */
  amount_usdc: number;
}

export interface PublisherPaymentBreakdown {
  publisher_id: string;
  publisher_wallet: string;
  publisher_name: string;
  /** One contribution per distinct document from this publisher. */
  documents: DocumentContribution[];
  /** Aggregated price across all documents from this publisher, in whole USDC. */
  amount_usdc: number;
  /** Aggregated price across all documents from this publisher, in USDC base units (6 dp). */
  amount_base_units: number;
}

export interface PaymentQuote {
  id: string;
  quote_nonce: string;
  query_text: string;
  matched_chunk_ids: string[];
  publisher_breakdown: PublisherPaymentBreakdown[];
  total_price_usdc: number;
  total_base_units: number;
  memo_expected: string;
  buyer_wallet: string | null;
  expires_at: string;
  status: 'PENDING' | 'REDEEMED' | 'EXPIRED';
  created_at: string;
}

export async function createPaymentQuote(
  queryText: string,
  matchedChunks: ChunkRecord[],
  buyerWallet: string | null = null,
  expirySeconds: number = config.quoteExpirySeconds
): Promise<PaymentQuote> {
  if (matchedChunks.length === 0) {
    throw new Error('Cannot create quote with zero matched chunks.');
  }

  const quoteId = `q_${crypto.randomUUID()}`;
  const quoteNonce = crypto.randomBytes(16).toString('hex');

  // Group by publisher wallet (not publisher_id + document_id). A publisher
  // who contributes chunks from multiple licensed documents receives one
  // aggregated payment at their single USDC ATA. Individual document
  // contributions are preserved separately in the `documents` array.
  const breakdownMap = new Map<string, PublisherPaymentBreakdown>();
  for (const chunk of matchedChunks) {
    const key = chunk.publisher_wallet;
    let entry = breakdownMap.get(key);

    if (!entry) {
      const price = Number.parseFloat(chunk.price_per_query_usdc);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(
          `Invalid or missing price for document ${chunk.document_id} (chunk ${chunk.id}). Quotes fail closed on invalid pricing.`
        );
      }
      const baseUnits = toBaseUnits(price);

      entry = {
        publisher_id: chunk.publisher_id,
        publisher_wallet: chunk.publisher_wallet,
        publisher_name: chunk.publisher_name,
        documents: [
          {
            document_id: chunk.document_id,
            document_title: chunk.document_title,
            chunk_ids: [chunk.id],
            amount_base_units: baseUnits,
            amount_usdc: fromBaseUnits(baseUnits),
          },
        ],
        amount_usdc: fromBaseUnits(baseUnits),
        amount_base_units: baseUnits,
      };
      breakdownMap.set(key, entry);
      continue;
    }

    // Find or create a document contribution within this publisher entry.
    const docContribution = entry.documents.find((d) => d.document_id === chunk.document_id);
    if (!docContribution) {
      const price = Number.parseFloat(chunk.price_per_query_usdc);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(
          `Invalid or missing price for document ${chunk.document_id} (chunk ${chunk.id}). Quotes fail closed on invalid pricing.`
        );
      }
      const baseUnits = toBaseUnits(price);
      entry.documents.push({
        document_id: chunk.document_id,
        document_title: chunk.document_title,
        chunk_ids: [chunk.id],
        amount_base_units: baseUnits,
        amount_usdc: fromBaseUnits(baseUnits),
      });
      entry.amount_base_units += baseUnits;
      entry.amount_usdc = fromBaseUnits(entry.amount_base_units);
    } else {
      docContribution.chunk_ids.push(chunk.id);
    }
  }

  const publisherBreakdown = Array.from(breakdownMap.values());

  // All money is summed in integer base units so the total can never drift
  // from the sum of its parts.
  const totalBaseUnits = publisherBreakdown.reduce(
    (sum, p) => sum + p.amount_base_units,
    0
  );
  const totalPriceUsdc = fromBaseUnits(totalBaseUnits);

  // Digest over the exact chunk hashes that were priced.
  const sourceDigest = computeSourceDigest(matchedChunks.map((c) => c.content_hash));

  const memoExpected = buildMemoPayload({
    quoteId,
    quoteNonce,
    sourceDigest,
  });

  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

  const insertSql = `
    INSERT INTO payment_quotes (
      id, quote_nonce, query_text, matched_chunk_ids, publisher_breakdown,
      total_price_usdc, memo_expected, buyer_wallet, expires_at, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
    RETURNING *;
  `;

  const res = await query(insertSql, [
    quoteId,
    quoteNonce,
    queryText,
    JSON.stringify(matchedChunks.map((c) => c.id)),
    JSON.stringify(publisherBreakdown),
    formatUsdc(totalBaseUnits),
    memoExpected,
    buyerWallet,
    expiresAt,
  ]);

  const row = res.rows[0];

  return {
    id: row.id,
    quote_nonce: row.quote_nonce,
    query_text: row.query_text,
    matched_chunk_ids: row.matched_chunk_ids,
    publisher_breakdown: publisherBreakdown,
    total_price_usdc: totalPriceUsdc,
    total_base_units: totalBaseUnits,
    memo_expected: row.memo_expected,
    buyer_wallet: row.buyer_wallet,
    expires_at: row.expires_at,
    status: row.status,
    created_at: row.created_at,
  };
}

export async function getQuote(quoteId: string): Promise<PaymentQuote | null> {
  const res = await query('SELECT * FROM payment_quotes WHERE id = $1', [quoteId]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const breakdown: PublisherPaymentBreakdown[] =
    typeof row.publisher_breakdown === 'string'
      ? JSON.parse(row.publisher_breakdown)
      : row.publisher_breakdown;

  // Recompute the totals from the breakdown in integer base units rather than
  // trusting the stored decimal, so a corrupted or hand-edited row can never
  // cause an under-payment to slip through.
  const totalBaseUnits = (breakdown || []).reduce(
    (sum: number, p: PublisherPaymentBreakdown) => sum + (p.amount_base_units || 0),
    0
  );

  return {
    id: row.id,
    quote_nonce: row.quote_nonce,
    query_text: row.query_text,
    matched_chunk_ids:
      typeof row.matched_chunk_ids === 'string'
        ? JSON.parse(row.matched_chunk_ids)
        : row.matched_chunk_ids,
    publisher_breakdown: breakdown,
    total_price_usdc: fromBaseUnits(totalBaseUnits),
    total_base_units: totalBaseUnits,
    memo_expected: row.memo_expected,
    buyer_wallet: row.buyer_wallet,
    expires_at: row.expires_at,
    status: row.status,
    created_at: row.created_at,
  };
}

/**
 * Marks a quote as expired. Called opportunistically so the `status` column
 * reflects reality without needing a background job.
 */
export async function markQuoteExpired(quoteId: string): Promise<void> {
  await query(
    `UPDATE payment_quotes SET status = 'EXPIRED'
     WHERE id = $1 AND status = 'PENDING' AND expires_at < NOW()`,
    [quoteId]
  );
}

/** Re-exported for convenience so callers do not need two imports. */
export { SETTLEMENT_ASSET, computeSha256 };
