import crypto from 'crypto';
import { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { ChunkRecord } from './documents';
import { computeSha256 } from './chunker';
import { config } from './config';
import { ELIGIBILITY_SQL_PREDICATE, IneligibleSourceError } from './eligibility';
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

/**
 * Loads the authoritative chunk/document/publisher records for the requested
 * chunk IDs inside an active transaction, applying the full eligibility
 * predicate and row-locking the records for the duration of quote creation.
 *
 * Row locks are taken in a deterministic order (chunk_id) to reduce deadlock
 * risk when multiple quote creations run concurrently against overlapping
 * sources. The locks are held until the transaction commits or rolls back,
 * so a concurrent revocation, price change, or content edit either blocks
 * until the quote is committed, or is rejected if it committed first.
 *
 * @param chunkIds Requested chunk IDs (duplicates are removed; empty array is valid).
 * @throws IneligibleSourceError if any requested chunk is missing or ineligible.
 */
export async function loadEligibleChunksForQuote(
  client: PoolClient,
  chunkIds: string[]
): Promise<ChunkRecord[]> {
  if (chunkIds.length === 0) return [];

  // Deduplicate while preserving first-seen order so duplicate IDs are rejected
  // deterministically downstream (the quote must price each chunk once).
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const id of chunkIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `
    SELECT c.id, c.document_id, c.publisher_id, c.chunk_index, c.content,
           c.content_hash, c.token_count,
           d.title AS document_title, d.price_per_query_usdc,
           p.wallet_address AS publisher_wallet, p.name AS publisher_name
    FROM document_chunks c
    JOIN documents d ON c.document_id = d.id AND c.publisher_id = d.publisher_id
    JOIN publishers p ON c.publisher_id = p.id
    WHERE c.id IN (${placeholders})
      AND ${ELIGIBILITY_SQL_PREDICATE}
    ORDER BY c.id
    FOR SHARE OF c, d, p
  `;

  const res = await client.query<ChunkRecord>(sql, uniqueIds);

  const found = new Set(res.rows.map((r) => r.id));
  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new IneligibleSourceError(missing);
  }

  return res.rows;
}

/**
 * Internal transaction workflow shared by production quote creation and
 * concurrency integration tests. Performs all authoritative source validation,
 * eligibility, pricing, quote insertion, and source snapshot insertion inside
 * a single PostgreSQL transaction with FOR SHARE row locks.
 *
 * If `pauseBeforeInsert` is set (test-only), the transaction pauses after
 * acquiring FOR SHARE locks and before inserting quote/snapshot rows. The
 * hook receives a `release` function; the transaction continues when
 * `release()` is called.
 */
export async function runQuoteTransaction(
  client: PoolClient,
  queryText: string,
  matchedChunks: ChunkRecord[],
  buyerWallet: string | null,
  expirySeconds: number,
  pauseBeforeInsert?: (release: () => void) => void
): Promise<{
  quoteRow: any;
  publisherBreakdown: PublisherPaymentBreakdown[];
  totalBaseUnits: bigint;
  totalPriceUsdc: string;
}> {
  const requestedIds = matchedChunks.map((c) => c.id);

  // Reject duplicate chunk IDs up front: a chunk must be priced once per quote.
  const uniqueRequestedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const id of requestedIds) {
    if (seenIds.has(id)) {
      throw new IneligibleSourceError([id]);
    }
    seenIds.add(id);
    uniqueRequestedIds.push(id);
  }

  const quoteId = `q_${crypto.randomUUID()}`;
  const quoteNonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

  let publisherBreakdown: PublisherPaymentBreakdown[] = [];
  let totalBaseUnits: bigint = BigInt(0);
  let totalPriceUsdc: string = '0.000000';

  // 1. Load authoritative chunk/document/publisher records, applying the
  //    full eligibility predicate and locking the rows for this transaction.
  const authoritative = await loadEligibleChunksForQuote(
    client,
    uniqueRequestedIds
  );
  const byId = new Map(authoritative.map((c) => [c.id, c]));

  // 2. Confirm every requested chunk was returned eligible.
  const missing = uniqueRequestedIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new IneligibleSourceError(missing);
  }

  // 3. Build the publisher payment breakdown from canonical DB values,
  //    preserving the requested chunk order.
  const breakdownMap = new Map<string, PublisherPaymentBreakdown>();
  const orderedAuthoritative: ChunkRecord[] = [];
  for (const id of uniqueRequestedIds) {
    orderedAuthoritative.push(byId.get(id)!);
  }

  for (const chunk of orderedAuthoritative) {
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

    const docContribution = entry.documents.find(
      (d) => d.document_id === chunk.document_id
    );
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

  publisherBreakdown = Array.from(breakdownMap.values());

  // All money is summed in integer base units so the total can never drift
  // from the sum of its parts.
  totalBaseUnits = publisherBreakdown.reduce(
    (sum: bigint, p) => sum + p.amount_base_units,
    BigInt(0)
  );
  totalPriceUsdc = fromBaseUnits(totalBaseUnits);

  // Digest over the canonical chunk hashes that were priced.
  const sourceDigest = computeSourceDigest(
    orderedAuthoritative.map((c) => c.content_hash)
  );
  const memoExpected = buildMemoPayload({
    quoteId,
    quoteNonce,
    sourceDigest,
  });

  // Test-only pause: freeze after FOR SHARE locks are acquired, before
  // inserting quote/snapshot rows. The transaction holds its locks while
  // paused, allowing concurrency tests to observe real PostgreSQL blocking.
  if (pauseBeforeInsert) {
    await new Promise<void>((resolve) => {
      pauseBeforeInsert(resolve);
    });
  }

  // 4. Insert the quote inside the same transaction.
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
    JSON.stringify(uniqueRequestedIds),
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

  // 5. Insert immutable source snapshots inside the same transaction.
  //    Content, hash, and price all come from the canonical DB record.
  const sourceInsertSql = `
    INSERT INTO payment_quote_sources (
      id, quote_id, ordinal, chunk_id, document_id, publisher_id,
      publisher_wallet, document_title, source_content, source_sha256,
      document_price_base_units
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `;

  let ordinal = 0;
  for (const chunk of orderedAuthoritative) {
    // Recalculate SHA-256 from current DB content and reject if it doesn't
    // match the stored content_hash.
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

  return {
    quoteRow: res.rows[0],
    publisherBreakdown,
    totalBaseUnits,
    totalPriceUsdc,
  };
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

  // matchedChunks is used only to identify the requested chunk IDs and to
  // preserve their intended ordering. All authoritative data (price, wallet,
  // publisher identity, document title, content, hashes) is loaded from the
  // database inside the transaction below. Caller-supplied metadata is never
  // trusted as a source of truth for pricing or allocation.

  const result = await withTransaction(async (client) => {
    return runQuoteTransaction(
      client,
      queryText,
      matchedChunks,
      buyerWallet,
      expirySeconds
    );
  });

  return {
    id: result.quoteRow.id,
    quote_nonce: result.quoteRow.quote_nonce,
    query_text: result.quoteRow.query_text,
    matched_chunk_ids: result.quoteRow.matched_chunk_ids,
    publisher_breakdown: result.publisherBreakdown,
    total_price_usdc: result.totalPriceUsdc,
    total_base_units: result.totalBaseUnits,
    memo_expected: result.quoteRow.memo_expected,
    buyer_wallet: result.quoteRow.buyer_wallet,
    expires_at: result.quoteRow.expires_at,
    status: result.quoteRow.status,
    created_at: result.quoteRow.created_at,
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

/**
 * Validates that an ordered set of quote source snapshots matches a quote's
 * matched_chunk_ids exactly. Applied both before initial settlement and before
 * answer generation on redeemed-quote retries.
 *
 * Checks:
 *   - Snapshot count equals matched chunk count.
 *   - Chunk IDs match the quote in exact order.
 *   - Ordinals are contiguous and begin at zero.
 *   - Chunk IDs are unique (no duplicates).
 *   - Content hashes match actual content (recalculated SHA-256).
 *   - Combined digest matches the quote memo.
 *
 * Never uses live document chunks as a fallback; only immutable snapshots are
 * accepted.
 *
 * Throws an Error describing the first failure found.
 */
export function validateQuoteSnapshotSet(
  quote: PaymentQuote,
  snapshots: Array<{
    ordinal: number;
    chunk_id: string;
    source_content: string;
    source_sha256: string;
  }>
): void {
  const matchedIds = quote.matched_chunk_ids;

  // Snapshot count must equal matched chunk count.
  if (snapshots.length !== matchedIds.length) {
    throw new Error(
      `Snapshot chunk count ${snapshots.length} does not match matched chunk count ${matchedIds.length}.`
    );
  }

  // Chunk IDs must match the quote in exact order.
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].chunk_id !== matchedIds[i]) {
      throw new Error(
        `Snapshot chunk order mismatch at position ${i}: expected ${matchedIds[i]}, got ${snapshots[i].chunk_id}.`
      );
    }
  }

  // Chunk IDs must be unique.
  const uniqueIds = new Set(snapshots.map((s) => s.chunk_id));
  if (uniqueIds.size !== snapshots.length) {
    throw new Error('Duplicate snapshot chunk IDs detected.');
  }

  // Ordinals must be contiguous and begin at zero.
  const ordinals = snapshots.map((s) => s.ordinal).sort((a, b) => a - b);
  for (let i = 0; i < ordinals.length; i++) {
    if (ordinals[i] !== i) {
      throw new Error(
        `Snapshot ordinal order is inconsistent: expected ${i} at position ${i}, got ${ordinals[i]}.`
      );
    }
  }

  // Each snapshot's SHA-256 hash must match recalculated content hash.
  for (const snapshot of snapshots) {
    const recalculatedHash = computeSha256(snapshot.source_content);
    if (recalculatedHash !== snapshot.source_sha256) {
      throw new Error(
        `Source integrity check failed for chunk ${snapshot.chunk_id}: content has been modified.`
      );
    }
  }

  // Combined source digest must match the memo digest.
  const recalculatedDigest = computeSourceDigest(
    snapshots.map((s) => s.source_sha256)
  );
  const memoDigest = quote.memo_expected.split(':').pop() || '';
  if (recalculatedDigest !== memoDigest) {
    throw new Error(
      'Source digest mismatch: purchased content does not match the quoted sources.'
    );
  }
}

/** Re-exported for convenience so callers do not need two imports. */
export { SETTLEMENT_ASSET, computeSha256 };
