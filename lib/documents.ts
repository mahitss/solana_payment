import crypto from 'crypto';
import { query, withTransaction } from './db';
import { getOrCreatePublisher } from './publishers';
import { chunkText, computeSha256, parseMarkdown, parsePdfBuffer } from './chunker';
import { getEmbeddingProvider } from './embedding';
import { isSupportedLicenseType, getSupportedLicenseTypes } from './eligibility';

export interface DocumentRecord {
  id: string;
  publisher_id: string;
  publisher_wallet: string;
  publisher_name: string;
  title: string;
  file_type: 'pdf' | 'md';
  content_hash: string;
  license_type: string;
  price_per_query_usdc: string;
  total_chunks: number;
  created_at: string;
  /**
   * Derived current embedding state. One of:
   *   'completed' | 'partial' | 'stale' | 'outdated' | 'pending' |
   *   'skipped' | 'failed'
   * - completed: every chunk has a valid, hash-matching current-version embedding.
   * - partial: some but not all chunks have current-version embeddings.
   * - stale: current-version embeddings exist but none match current content hashes.
   * - outdated: only other model-version embeddings exist (no current version).
   * - pending: no embedding attempt recorded yet.
   * - skipped / failed: persisted attempt outcome (see embeddingAttempt).
   */
  embeddingStatus: string;
  /**
   * Persisted outcome of the most recent ingestion embedding attempt:
   * 'pending' | 'skipped' | 'completed' | 'partial' | 'failed'.
   */
  embeddingAttempt: string;
  /** Number of chunks with valid current-version embeddings. */
  embeddingCount: number;
}

export interface ChunkRecord {
  id: string;
  document_id: string;
  publisher_id: string;
  publisher_wallet: string;
  publisher_name: string;
  document_title: string;
  price_per_query_usdc: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count: number;
  score?: number;
}

/** Minimum and maximum accepted per-query price, in whole USDC. */
const MIN_PRICE_USDC = 0.000001;
const MAX_PRICE_USDC = 1000;

export class DuplicateDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateDocumentError';
  }
}

export async function ingestDocument(params: {
  publisherWallet: string;
  publisherName?: string;
  title: string;
  fileType: 'pdf' | 'md';
  rawBuffer?: Buffer;
  rawText?: string;
  pricePerQueryUsdc?: number;
  licenseType?: string;
}): Promise<DocumentRecord> {
  // ----------------------------------------------------------------
  // Validate everything that would otherwise trigger a database write
  // BEFORE touching getOrCreatePublisher (which inserts or updates a
  // publisher row). Unsupported or malformed licensing must be rejected
  // without creating, modifying, or validating any database record.
  // ----------------------------------------------------------------
  let extractedText = '';
  if (params.fileType === 'pdf') {
    if (!params.rawBuffer) {
      throw new Error('PDF ingestion requires rawBuffer.');
    }
    extractedText = await parsePdfBuffer(params.rawBuffer);
  } else {
    extractedText = parseMarkdown(
      params.rawText || (params.rawBuffer ? params.rawBuffer.toString('utf8') : '')
    );
  }

  if (!extractedText.trim()) {
    throw new Error('Document content is empty or could not be parsed.');
  }

  const requestedPrice =
    params.pricePerQueryUsdc !== undefined ? params.pricePerQueryUsdc : 0.05;

  if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
    throw new Error('Price per query must be a positive number.');
  }
  if (requestedPrice < MIN_PRICE_USDC || requestedPrice > MAX_PRICE_USDC) {
    throw new Error(
      `Price per query must be between ${MIN_PRICE_USDC} and ${MAX_PRICE_USDC} USDC.`
    );
  }
  const price = requestedPrice;

  // License normalization: an intentionally omitted license keeps the
  // documented default; an explicitly supplied value must be a supported,
  // non-empty license type.
  let license: string;
  if (params.licenseType === undefined || params.licenseType === null) {
    license = 'query_royalty_v1';
  } else {
    const trimmed = params.licenseType.trim();
    if (!trimmed) {
      throw new Error(
        'License type must not be empty. Supported types: ' +
          getSupportedLicenseTypes().join(', ') +
          '.'
      );
    }
    license = trimmed;
    if (!isSupportedLicenseType(license)) {
      throw new Error(
        `Unsupported license type "${license}". Supported types: ${getSupportedLicenseTypes().join(', ')}.`
      );
    }
  }

  const chunks = chunkText(extractedText);
  if (chunks.length === 0) {
    throw new Error('Document produced no indexable chunks.');
  }

  const docId = `doc_${crypto.randomUUID()}`;
  const docHash = computeSha256(extractedText);

  const publisher = await getOrCreatePublisher(params.publisherWallet, params.publisherName);

  // Stage 1: Persist document and chunks in a single database transaction.
  const docResult = await withTransaction(async (client) => {
    // Reject byte-identical re-uploads by the same publisher. Without this a
    // publisher can flood the corpus with copies of one document, diluting
    // retrieval quality for every other publisher.
    const duplicate = await client.query(
      `SELECT id, title FROM documents
       WHERE publisher_id = $1 AND content_hash = $2`,
      [publisher.id, docHash]
    );
    if (duplicate.rows.length > 0) {
      throw new DuplicateDocumentError(
        `This document has already been published by this wallet as "${duplicate.rows[0].title}". ` +
          'Each distinct document may only be published once.'
      );
    }

    const insertDocSql = `
      INSERT INTO documents (
        id, publisher_id, title, file_type, content_hash, license_type, price_per_query_usdc, total_chunks, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
      RETURNING *
    `;
    const docRes = await client.query(insertDocSql, [
      docId,
      publisher.id,
      params.title.trim(),
      params.fileType,
      docHash,
      license,
      price,
      chunks.length,
    ]);

    const chunkInserts: Array<{
      id: string;
      content: string;
      contentHash: string;
      tokenCount: number;
    }> = [];

    for (const chunk of chunks) {
      const chunkId = `chk_${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO document_chunks (
          id, document_id, publisher_id, chunk_index, content, content_hash, token_count, search_vector
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, to_tsvector('english', $5)
        )`,
        [
          chunkId,
          docId,
          publisher.id,
          chunk.chunk_index,
          chunk.content,
          chunk.content_hash,
          chunk.token_count,
        ]
      );
      chunkInserts.push({
        id: chunkId,
        content: chunk.content,
        contentHash: chunk.content_hash,
        tokenCount: chunk.token_count,
      });
    }

    return { docRes, chunkInserts };
  });

  // Stage 2: Generate embeddings OUTSIDE the database transaction. This
  // prevents holding a PostgreSQL connection open during model inference,
  // retries, and timeouts. Embedding failure does not roll back the ingested
  // document or its FTS entries.
  //
  // Provider initialization lives inside the failure handler: an invalid
  // embedding configuration must not crash ingestion after the document was
  // already persisted, and must never be misreported as a skipped success.
  let embeddingAttempt = 'pending';
  let embeddingCount = 0;

  const persistAttempt = async (status: string, persistCount: number) => {
    embeddingAttempt = status;
    embeddingCount = persistCount;
    try {
      await query(
        'UPDATE documents SET embedding_status = $1 WHERE id = $2',
        [status, docId]
      );
    } catch (updateErr) {
      // Status persistence is best-effort; never fail ingestion for it.
      console.error(
        `[documents] Failed to persist embedding status for ${docId}:`,
        updateErr instanceof Error ? updateErr.message : String(updateErr)
      );
    }
  };

  try {
    const embeddingProvider = await getEmbeddingProvider();

    if (!embeddingProvider) {
      // Provider deliberately disabled (EMBEDDING_PROVIDER=none) or unknown.
      // No network request was attempted; the document stays FTS-only.
      await persistAttempt('skipped', 0);
    } else {
      try {
        const texts = docResult.chunkInserts.map((c) => c.content);
        const vectors = await embeddingProvider.embedDocuments(texts);

        // Stage 3: Persist valid embeddings in a separate bounded transaction.
        // model_digest is the provider's VERIFIED immutable fingerprint, so
        // different model revisions can never silently overwrite each other.
        const persisted = await withTransaction(async (client) => {
          const insertEmbeddingSql = `
            INSERT INTO document_chunk_embeddings (
              id, chunk_id, document_id, provider, model_id, model_digest,
              dimensions, source_hash, embedding
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (chunk_id, provider, model_id, model_digest) DO UPDATE SET
              document_id = EXCLUDED.document_id,
              dimensions = EXCLUDED.dimensions,
              source_hash = EXCLUDED.source_hash,
              embedding = EXCLUDED.embedding,
              created_at = CURRENT_TIMESTAMP
          `;

          let count = 0;
          for (let i = 0; i < docResult.chunkInserts.length; i++) {
            const chunk = docResult.chunkInserts[i];
            const vector = vectors[i];
            if (!vector) continue;

            await client.query(insertEmbeddingSql, [
              `emb_${crypto.randomUUID()}`,
              chunk.id,
              docId,
              embeddingProvider.providerId,
              embeddingProvider.modelId,
              embeddingProvider.modelDigest,
              embeddingProvider.dimensions,
              chunk.contentHash,
              JSON.stringify(vector),
            ]);
            count++;
          }
          return count;
        });

        embeddingCount = persisted;
        await persistAttempt(
          embeddingCount === docResult.chunkInserts.length ? 'completed' : 'partial',
          persisted
        );
      } catch (embedErr) {
        // Embedding failure must not fail document ingestion. FTS remains
        // fully functional. The missing/stale embedding state is recoverable
        // by the backfill script.
        console.error(
          `[documents] Embedding generation failed for document ${docId}:`,
          embedErr instanceof Error ? embedErr.message : String(embedErr)
        );
        await persistAttempt('failed', embeddingCount);
      }
    }
  } catch (initErr) {
    // Provider initialization failed (invalid configuration, unverifiable
    // model identity, endpoint unreachable). The document itself is already
    // persisted and FTS-functional; report the embedding attempt honestly.
    console.error(
      `[documents] Embedding provider initialization failed for document ${docId}:`,
      initErr instanceof Error ? initErr.message : String(initErr)
    );
    await persistAttempt('failed', 0);
  }

  return {
    id: docId,
    publisher_id: publisher.id,
    publisher_wallet: publisher.wallet_address,
    publisher_name: publisher.name,
    title: params.title.trim(),
    file_type: params.fileType,
    content_hash: docHash,
    license_type: license,
    price_per_query_usdc: price.toFixed(6),
    total_chunks: chunks.length,
    created_at: docResult.docRes.rows[0].created_at,
    // Returned derived state: a just-processed document is reported from the
    // persisted attempt because no consistent derived snapshot exists yet.
    embeddingStatus: embeddingAttempt === 'pending' ? 'pending' : embeddingAttempt,
    embeddingAttempt,
    embeddingCount,
  };
}

/**
 * Shared SQL skeleton for document listing with per-document embedding
 * aggregates computed at CHUNK level:
 *
 * - all_rows:          any embedding rows on the document's chunks
 * - hash_match_any:    any-version rows whose source_hash matches the chunk content hash
 * - valid_current:     current-version rows matching the chunk hash
 * - stale_current:     current-version rows whose hash no longer matches (content drifted)
 * - outdated_versions: embeddings of the current model produced by a DIFFERENT
 *   model digest, i.e. an older model revision
 *
 * Tokens %P/%M/%D are replaced with the caller's parameter indices for the
 * current provider identity (provider_id, model_id, model_digest). When no
 * current provider is configured, a sentinel value ("__none__") is supplied,
 * which makes all version-specific filters evaluate false.
 */
const DOCUMENT_AGGREGATE_SQL = `
  SELECT d.*,
    p.wallet_address AS publisher_wallet,
    p.name AS publisher_name,
    d.embedding_status AS embedding_attempt,
    COALESCE(a.all_rows, 0) AS all_rows,
    COALESCE(a.hash_match_any, 0) AS hash_match_any,
    COALESCE(a.valid_current, 0) AS valid_current,
    COALESCE(a.stale_current, 0) AS stale_current,
    COALESCE(a.outdated_versions, 0) AS outdated_versions
  FROM documents d
  JOIN publishers p ON d.publisher_id = p.id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(e.id)::int AS all_rows,
      COUNT(*) FILTER (WHERE e.source_hash = c.content_hash)::int AS hash_match_any,
      COUNT(*) FILTER (WHERE e.provider = %P AND e.model_id = %M AND e.model_digest = %D AND e.source_hash = c.content_hash)::int AS valid_current,
      COUNT(*) FILTER (WHERE e.provider = %P AND e.model_id = %M AND e.model_digest = %D AND e.source_hash <> c.content_hash)::int AS stale_current,
      COUNT(*) FILTER (WHERE e.provider = %P AND e.model_id = %M AND e.model_digest <> %D)::int AS outdated_versions
    FROM document_chunks c
    LEFT JOIN document_chunk_embeddings e ON e.chunk_id = c.id
    WHERE c.document_id = d.id
  ) a ON TRUE
`;


/** Sentinel identity making every version-specific filter inert. */
const NO_PROVIDER_FILTER = ['__none__', '__none__', '__none__'] as const;

/**
 * Derives the honest current embedding status from persisted attempt state
 * plus version-aware aggregates. See DocumentRecord for the meaning of each
 * status value.
 */
function deriveEmbeddingState(
  row: {
    total_chunks: number;
    embedding_attempt: string | null;
    all_rows: number | string;
    hash_match_any: number | string;
    valid_current: number | string;
    stale_current: number | string;
    outdated_versions: number | string;
  },
  providerKnown: boolean
): { status: string; count: number } {
  const total = Number(row.total_chunks ?? 0);
  const validCurrent = Number(row.valid_current ?? 0);
  const staleCurrent = Number(row.stale_current ?? 0);
  const outdated = Number(row.outdated_versions ?? 0);
  const allRows = Number(row.all_rows ?? 0);
  const hashMatchAny = Number(row.hash_match_any ?? 0);
  const attempt = row.embedding_attempt || 'pending';
  const attemptStatus =
    attempt === 'pending' || attempt === 'skipped' || attempt === 'failed'
      ? attempt
      : 'pending';

  if (providerKnown) {
    if (total > 0 && validCurrent === total) return { status: 'completed', count: validCurrent };
    if (validCurrent > 0) return { status: 'partial', count: validCurrent };
    if (staleCurrent > 0) return { status: 'stale', count: 0 };
    if (outdated > 0) return { status: 'outdated', count: 0 };
    return { status: attemptStatus, count: 0 };
  }

  // No current embedding provider configured. Any-version hash-matching
  // embeddings are still usable context, but there is no "current model
  // version", so counts reflect any-version hash matches.
  if (total > 0 && hashMatchAny === total) return { status: 'completed', count: hashMatchAny };
  if (hashMatchAny > 0) return { status: 'partial', count: hashMatchAny };
  if (allRows > 0) return { status: 'stale', count: 0 };
  return { status: attemptStatus, count: 0 };
}

/**
 * Resolves the current embedding provider identity filter parameters without
 * ever throwing: an empty/failed identity only disables version-specific
 * counting, never the listing itself.
 */
async function resolveIdentityFilter(): Promise<[hasCurrent: boolean, filter: string[]]> {
  try {
    const provider = await getEmbeddingProvider();
    if (provider) {
      return [
        true,
        [provider.providerId, provider.modelId, provider.modelDigest],
      ];
    }
    return [false, [...NO_PROVIDER_FILTER]];
  } catch (err) {
    // Initialization failure must not break document listing.
    console.error(
      '[documents] Embedding provider unavailable while listing documents:',
      err instanceof Error ? err.message : String(err)
    );
    return [false, [...NO_PROVIDER_FILTER]];
  }
}

export async function listAllDocuments(limit = 100): Promise<DocumentRecord[]> {
  const [providerKnown, filter] = await resolveIdentityFilter();
  const sql = DOCUMENT_AGGREGATE_SQL.replace(/%P/g, '$2').replace(/%M/g, '$3').replace(/%D/g, '$4');
  const res = await query(`${sql} ORDER BY d.created_at DESC LIMIT $1`, [
    limit,
    ...filter,
  ]);
  return res.rows.map((row: any) => {
    const { status, count } = deriveEmbeddingState(row, providerKnown);
    return {
      ...row,
      embeddingStatus: status,
      embeddingAttempt: String(row.embedding_attempt || 'pending'),
      embeddingCount: count,
    };
  });
}

export async function getDocumentById(id: string): Promise<DocumentRecord | null> {
  const [providerKnown, filter] = await resolveIdentityFilter();
  const sql = DOCUMENT_AGGREGATE_SQL.replace(/%P/g, '$1').replace(/%M/g, '$2').replace(/%D/g, '$3');
  const res = await query(`${sql} WHERE d.id = $4`, [ ...filter, id ]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const { status, count } = deriveEmbeddingState(row, providerKnown);
  return {
    ...row,
    embeddingStatus: status,
    embeddingAttempt: String(row.embedding_attempt || 'pending'),
    embeddingCount: count,
  };
}

export async function listDocumentsByPublisher(
  publisherId: string
): Promise<DocumentRecord[]> {
  const [providerKnown, filter] = await resolveIdentityFilter();
  const sql = DOCUMENT_AGGREGATE_SQL.replace(/%P/g, '$2').replace(/%M/g, '$3').replace(/%D/g, '$4');
  const res = await query(`${sql} WHERE d.publisher_id = $1 ORDER BY d.created_at DESC`, [
    publisherId,
    ...filter,
  ]);
  return res.rows.map((row: any) => {
    const { status, count } = deriveEmbeddingState(row, providerKnown);
    return {
      ...row,
      embeddingStatus: status,
      embeddingAttempt: String(row.embedding_attempt || 'pending'),
      embeddingCount: count,
    };
  });
}
