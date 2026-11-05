import { query, pool } from './db';
import { getOrCreatePublisher } from './publishers';
import { chunkText, computeSha256, parseMarkdown, parsePdfBuffer } from './chunker';
import crypto from 'crypto';

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
    extractedText = parseMarkdown(params.rawText || (params.rawBuffer ? params.rawBuffer.toString('utf8') : ''));
  }

  if (!extractedText.trim()) {
    throw new Error('Document content is empty or could not be parsed.');
  }

  const docId = `doc_${crypto.randomUUID()}`;
  const docHash = computeSha256(extractedText);
  const chunks = chunkText(extractedText);
  const price = params.pricePerQueryUsdc !== undefined ? Math.max(0.000001, params.pricePerQueryUsdc) : 0.050000;
  const license = params.licenseType || 'query_royalty_v1';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    await client.query('COMMIT');

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
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listAllDocuments(): Promise<DocumentRecord[]> {
  const sql = `
    SELECT d.*, p.wallet_address as publisher_wallet, p.name as publisher_name
    FROM documents d
    JOIN publishers p ON d.publisher_id = p.id
    ORDER BY d.created_at DESC
  `;
  const res = await query(sql);
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
