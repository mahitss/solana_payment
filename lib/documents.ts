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
  /** Embedding generation status: 'pending', 'completed', 'failed', or 'skipped'. */
  embeddingStatus: string;
  /** Number of chunks with valid embeddings. */
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
  const publisher = await getOrCreatePublisher(params.publisherWallet, params.publisherName);

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

  const docId = `doc_${crypto.randomUUID()}`;
  const docHash = computeSha256(extractedText);
  const chunks = chunkText(extractedText);

  if (chunks.length === 0) {
    throw new Error('Document produced no indexable chunks.');
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
  const license = params.licenseType || 'query_royalty_v1';

  // Reject unsupported license types before any database write.
  if (!isSupportedLicenseType(license)) {
    throw new Error(
      `Unsupported license type "${license}". Supported types: ${getSupportedLicenseTypes().join(', ')}.`
    );
  }

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
  const embeddingProvider = getEmbeddingProvider();
  let embeddingStatus = 'skipped';
  let embeddingCount = 0;

  if (embeddingProvider) {
    try {
      const texts = docResult.chunkInserts.map((c) => c.content);
      const vectors = await embeddingProvider.embedDocuments(texts);

      // Stage 3: Persist valid embeddings in a separate bounded transaction.
      const persisted = await withTransaction(async (client) => {
        const insertEmbeddingSql = `
          INSERT INTO document_chunk_embeddings (
            id, chunk_id, document_id, provider, model_id, model_digest,
            dimensions, source_hash, embedding
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (chunk_id, provider, model_id, model_digest) DO UPDATE SET
            document_id = EXCLUDED.document_id,
            model_digest = EXCLUDED.model_digest,
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
            '', // model_digest: Ollama embed API does not return a digest
            embeddingProvider.dimensions,
            chunk.contentHash,
            JSON.stringify(vector),
          ]);
          count++;
        }
        return count;
      });

      embeddingCount = persisted;
      embeddingStatus = embeddingCount === docResult.chunkInserts.length ? 'completed' : 'partial';
    } catch (embedErr) {
      // Embedding failure must not fail document ingestion. FTS remains
      // fully functional. The missing/stale embedding state is recoverable
      // by the backfill script.
      console.error(
        `[documents] Embedding generation failed for document ${docId}:`,
        embedErr instanceof Error ? embedErr.message : String(embedErr)
      );
      embeddingStatus = 'failed';
    }
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
    embeddingStatus,
    embeddingCount,
  };
}

export async function listAllDocuments(limit = 100): Promise<DocumentRecord[]> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name,
      COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) AS embedding_count,
      CASE
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = 0 THEN 'skipped'
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = d.total_chunks THEN 'completed'
        ELSE 'partial'
      END AS embedding_status
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    LEFT JOIN document_chunk_embeddings e
      ON e.document_id = d.id
      AND e.source_hash = d.content_hash
    GROUP BY d.id, p.wallet_address, p.name
    ORDER BY d.created_at DESC
    LIMIT $1;
  `;
  const res = await query(sql, [limit]);
  return res.rows.map((row: any) => ({
    ...row,
    embeddingStatus: row.embedding_status,
    embeddingCount: Number(row.embedding_count ?? 0),
  }));
}

export async function getDocumentById(id: string): Promise<DocumentRecord | null> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name,
      COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) AS embedding_count,
      CASE
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = 0 THEN 'skipped'
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = d.total_chunks THEN 'completed'
        ELSE 'partial'
      END AS embedding_status
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    LEFT JOIN document_chunk_embeddings e
      ON e.document_id = d.id
      AND e.source_hash = d.content_hash
    WHERE d.id = $1
    GROUP BY d.id, p.wallet_address, p.name
  `;
  const res = await query(sql, [id]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    ...row,
    embeddingStatus: row.embedding_status,
    embeddingCount: Number(row.embedding_count ?? 0),
  };
}

export async function listDocumentsByPublisher(
  publisherId: string
): Promise<DocumentRecord[]> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name,
      COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) AS embedding_count,
      CASE
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = 0 THEN 'skipped'
        WHEN COUNT(e.id) FILTER (WHERE e.source_hash = d.content_hash) = d.total_chunks THEN 'completed'
        ELSE 'partial'
      END AS embedding_status
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    LEFT JOIN document_chunk_embeddings e
      ON e.document_id = d.id
      AND e.source_hash = d.content_hash
    WHERE d.publisher_id = $1
    GROUP BY d.id, p.wallet_address, p.name
    ORDER BY d.created_at DESC
  `;
  const res = await query(sql, [publisherId]);
  return res.rows.map((row: any) => ({
    ...row,
    embeddingStatus: row.embedding_status,
    embeddingCount: Number(row.embedding_count ?? 0),
  }));
}
