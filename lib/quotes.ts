import crypto from 'crypto';
import { query, withTransaction } from './db';
import { ChunkRecord } from './documents';
import { computeSha256 } from './chunker';
import { config } from './config';
import {
  SETTLEMENT_ASSET,
  buildMemoPayload,
  computeSourceDigest,
  formatUsdc,
  fromBaseUnits,
  MAX_PRICE_USDC,
  parseNumericPrice,
  USDC_BASE_UNIT,
} from './protocol';

export interface DocumentContribution {
  document_id: string;
  document_title: string;
  chunk_ids: string[];
  /** Price for this document, in USDC base units (6 dp). */
  amount_base_units: bigint;
  /** Price for this document, as a fixed 6-decimal USDC string. */
  amount_usdc: string;
}

export interface PublisherPaymentBreakdown {
  publisher_id: string;
  publisher_wallet: string;
  publisher_name: string;
  /** One contribution per distinct document from this publisher. */
  documents: DocumentContribution[];
  /** Aggregated price across all documents from this publisher, in USDC base units (6 dp). */
  amount_base_units: bigint;
  /** Aggregated price across all documents from this publisher, as a fixed 6-decimal USDC string. */
  amount_usdc: string;
}

export interface PaymentQuote {
  id: string;
  quote_nonce: string;
  query_text: string;
  matched_chunk_ids: string[];
  publisher_breakdown: PublisherPaymentBreakdown[];
  /** Total price as a fixed 6-decimal USDC string. */
  total_price_usdc: string;
  /** Total price in USDC base units (6 dp), as BigInt. */
  total_base_units: bigint;
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
      const baseUnits = parseNumericPrice(chunk.price_per_query_usdc);
      if (baseUnits > MAX_PRICE_USDC) {
        throw new Error(
          `Price for document ${chunk.document_id} exceeds maximum of ${
            MAX_PRICE_USDC / USDC_BASE_UNIT
          } USDC.`
        );
      }

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
        amount_base_units: baseUnits,
        amount_usdc: fromBaseUnits(baseUnits),
      };
      breakdownMap.set(key, entry);
      continue;
    }

    // Find or create a document contribution within this publisher entry.
    const docContribution = entry.documents.find((d) => d.document_id === chunk.document_id);
    if (!docContribution) {
      const baseUnits = parseNumericPrice(chunk.price_per_query_usdc);
      if (baseUnits > MAX_PRICE_USDC) {
        throw new Error(
          `Price for document ${chunk.document_id} exceeds maximum of ${
            MAX_PRICE_USDC / USDC_BASE_UNIT
          } USDC.`
        );
      }
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
    (sum: bigint, p) => sum + p.amount_base_units,
    BigInt(0)
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

  const quoteRow = await withTransaction(async (client) => {
    const insertSql = `
      INSERT INTO payment_quotes (
        id, quote_nonce, query_text, matched_chunk_ids, publisher_breakdown,
        total_price_usdc, memo_expected, buyer_wallet, expires_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
      RETURNING *;
    `;

    const res = await client.query(insertSql, [
      quoteId,
      quoteNonce,
      queryText,
      JSON.stringify(matchedChunks.map((c) => c.id)),
      JSON.stringify(
        publisherBreakdown.map((p) => ({
          ...p,
          amount_base_units: p.amount_base_units.toString(),
          documents: p.documents.map((d) => ({
            ...d,
            amount_base_units: d.amount_base_units.toString(),
          })),
        }))
      ),
      formatUsdc(totalBaseUnits),
      memoExpected,
      buyerWallet,
      expiresAt,
    ]);

    // Insert immutable source snapshots for every priced chunk.
    // Snapshots are write-once: they capture the exact content that was quoted
    // and are never exposed through public APIs.
    const sourceInsertSql = `
      INSERT INTO payment_quote_sources (
        id, quote_id, ordinal, chunk_id, document_id, publisher_id,
        publisher_wallet, document_title, source_content, source_sha256,
        document_price_base_units
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    let ordinal = 0;
    for (const chunk of matchedChunks) {
      // Recalculate SHA-256 from actual content and reject if it doesn't match
      // the stored content_hash. This prevents a publisher from smuggling
      // modified content by providing a false hash.
      const recalculatedHash = computeSha256(chunk.content);
      if (recalculatedHash !== chunk.content_hash) {
        throw new Error(
          `Source integrity check failed for chunk ${chunk.id}: content hash mismatch. Stored hash ${chunk.content_hash} does not match recomputed hash ${recalculatedHash}.`
        );
      }

      await client.query(sourceInsertSql, [
        `src_${crypto.randomUUID()}`,
        quoteId,
        ordinal++,
        chunk.id,
        chunk.document_id,
        chunk.publisher_id,
        chunk.publisher_wallet,
        chunk.document_title,
        chunk.content,
        recalculatedHash,
        BigInt(parseNumericPrice(chunk.price_per_query_usdc)),
      ]);
    }

    return res.rows[0];
  });

  return {
    id: quoteRow.id,
    quote_nonce: quoteRow.quote_nonce,
    query_text: quoteRow.query_text,
    matched_chunk_ids: quoteRow.matched_chunk_ids,
    publisher_breakdown: publisherBreakdown,
    total_price_usdc: totalPriceUsdc,
    total_base_units: totalBaseUnits,
    memo_expected: quoteRow.memo_expected,
    buyer_wallet: quoteRow.buyer_wallet,
    expires_at: quoteRow.expires_at,
    status: quoteRow.status,
    created_at: quoteRow.created_at,
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
    (sum: bigint, p) => sum + BigInt(p.amount_base_units),
    BigInt(0)
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
 * Fetches the immutable source snapshots for a quote, ordered by ordinal.
 * Used during settlement to verify source integrity without touching mutable
 * live chunks.
 */
export async function getQuoteSources(quoteId: string): Promise<Array<{
  ordinal: number;
  chunk_id: string;
  document_id: string;
  publisher_id: string;
  publisher_wallet: string;
  document_title: string;
  source_content: string;
  source_sha256: string;
  document_price_base_units: string;
}>> {
  const res = await query(
    `SELECT ordinal, chunk_id, document_id, publisher_id, publisher_wallet,
            document_title, source_content, source_sha256,
            document_price_base_units::text
     FROM payment_quote_sources
     WHERE quote_id = $1
     ORDER BY ordinal ASC`,
    [quoteId]
  );
  return res.rows;
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
