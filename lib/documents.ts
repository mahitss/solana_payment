import crypto from 'crypto';
import { query, withTransaction } from './db';
import { getOrCreatePublisher } from './publishers';
import { chunkText, computeSha256, parseMarkdown, parsePdfBuffer } from './chunker';

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

  return withTransaction(async (client) => {
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
        id, publisher_id, title, file_type, content_hash, license_type, price_per_query_usdc, total_chunks
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      created_at: docRes.rows[0].created_at,
    };
  });
}

export async function listAllDocuments(limit = 100): Promise<DocumentRecord[]> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    ORDER BY d.created_at DESC
    LIMIT $1;
  `;
  const res = await query(sql, [limit]);
  return res.rows;
}

export async function getDocumentById(id: string): Promise<DocumentRecord | null> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    WHERE d.id = $1
  `;
  const res = await query(sql, [id]);
  return res.rows[0] || null;
}

export async function listDocumentsByPublisher(
  publisherId: string
): Promise<DocumentRecord[]> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    WHERE d.publisher_id = $1
    ORDER BY d.created_at DESC
  `;
  const res = await query(sql, [publisherId]);
  return res.rows;
}
