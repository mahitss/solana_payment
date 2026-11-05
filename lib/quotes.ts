import { query } from './db';
import { ChunkRecord } from './documents';
import { computeSha256 } from './chunker';
import crypto from 'crypto';

export interface PublisherPaymentBreakdown {
  publisher_id: string;
  publisher_wallet: string;
  publisher_name: string;
  document_title: string;
  chunk_ids: string[];
  amount_usdc: number;
  amount_base_units: number; // 6 decimals for USDC
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
  expires_at: string;
  status: 'PENDING' | 'REDEEMED' | 'EXPIRED';
  created_at: string;
}

export async function createPaymentQuote(
  queryText: string,
  matchedChunks: ChunkRecord[],
  expirySeconds: number = 300
): Promise<PaymentQuote> {
  if (matchedChunks.length === 0) {
    throw new Error('Cannot create quote with zero matched chunks.');
  }

  const quoteId = `q_${crypto.randomUUID()}`;
  const quoteNonce = crypto.randomBytes(16).toString('hex');

  // Group chunks by publisher
  const breakdownMap = new Map<string, PublisherPaymentBreakdown>();
  for (const chunk of matchedChunks) {
    let entry = breakdownMap.get(chunk.publisher_id);
    if (!entry) {
      const price = parseFloat(chunk.price_per_query_usdc) || 0.05;
      entry = {
        publisher_id: chunk.publisher_id,
        publisher_wallet: chunk.publisher_wallet,
        publisher_name: chunk.publisher_name,
        document_title: chunk.document_title,
        chunk_ids: [],
        amount_usdc: price,
        amount_base_units: Math.round(price * 1_000_000),
      };
      breakdownMap.set(chunk.publisher_id, entry);
    }
    entry.chunk_ids.push(chunk.id);
  }

  const publisherBreakdown = Array.from(breakdownMap.values());
  const totalPriceUsdc = publisherBreakdown.reduce((sum, p) => sum + p.amount_usdc, 0);
  const totalBaseUnits = Math.round(totalPriceUsdc * 1_000_000);

  // Compute Merkle / concatenated hash of the source chunks
  const chunkHashesConcat = matchedChunks.map((c) => c.content_hash).join(':');
  const sourceDigest = computeSha256(chunkHashesConcat).slice(0, 16);

  // Strict Memo formatting: CITERAIL:QUOTE:<quote_id>:<sourceDigest>
  const memoExpected = `CITERAIL:${quoteId}:${sourceDigest}`;

  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

  const insertSql = `
    INSERT INTO payment_quotes (
      id, quote_nonce, query_text, matched_chunk_ids, publisher_breakdown,
      total_price_usdc, memo_expected, expires_at, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
    RETURNING *;
  `;

  const res = await query(insertSql, [
    quoteId,
    quoteNonce,
    queryText,
    JSON.stringify(matchedChunks.map((c) => c.id)),
    JSON.stringify(publisherBreakdown),
    totalPriceUsdc.toFixed(6),
    memoExpected,
    expiresAt,
  ]);

  const row = res.rows[0];

  return {
    id: row.id,
    quote_nonce: row.quote_nonce,
    query_text: row.query_text,
    matched_chunk_ids: row.matched_chunk_ids,
    publisher_breakdown: publisherBreakdown,
    total_price_usdc: parseFloat(row.total_price_usdc),
    total_base_units: totalBaseUnits,
    memo_expected: row.memo_expected,
    expires_at: row.expires_at,
    status: row.status,
    created_at: row.created_at,
  };
}

export async function getQuote(quoteId: string): Promise<PaymentQuote | null> {
  const res = await query('SELECT * FROM payment_quotes WHERE id = $1', [quoteId]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const breakdown: PublisherPaymentBreakdown[] = typeof row.publisher_breakdown === 'string'
    ? JSON.parse(row.publisher_breakdown)
    : row.publisher_breakdown;

  const totalUsdc = parseFloat(row.total_price_usdc);

  return {
    id: row.id,
    quote_nonce: row.quote_nonce,
    query_text: row.query_text,
    matched_chunk_ids: typeof row.matched_chunk_ids === 'string' ? JSON.parse(row.matched_chunk_ids) : row.matched_chunk_ids,
    publisher_breakdown: breakdown,
    total_price_usdc: totalUsdc,
    total_base_units: Math.round(totalUsdc * 1_000_000),
    memo_expected: row.memo_expected,
    expires_at: row.expires_at,
    status: row.status,
    created_at: row.created_at,
  };
}
