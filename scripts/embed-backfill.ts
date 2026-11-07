/**
 * Embedding backfill script for CiteRail.
 *
 * Identifies chunks missing valid embeddings, identifies stale embeddings by
 * content-hash mismatch, and (re)generates them using the configured embedding
 * provider. Safe to rerun: idempotent, no duplicate rows, bounded concurrency.
 *
 * Usage:
 *   npx tsx scripts/embed-backfill.ts [--dry-run] [--batch-size N]
 *
 * Requires DATABASE_URL and an embedding provider (Ollama by default).
 */

import { randomUUID } from 'crypto';
import { query, pool, withTransaction } from '../lib/db';
import { getEmbeddingProvider } from '../lib/embedding';

interface ChunkToEmbed {
  id: string;
  document_id: string;
  content: string;
  content_hash: string;
}

interface BackfillStats {
  totalChunks: number;
  missingEmbeddings: number;
  staleEmbeddings: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

const DEFAULT_BATCH_SIZE = 32;

function parseArgs(argv: string[]): { dryRun: boolean; batchSize: number } {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--batch-size' && i + 1 < argv.length) {
      batchSize = Number.parseInt(argv[i + 1], 10);
      i++;
      if (!Number.isFinite(batchSize) || batchSize <= 0) {
        console.error(`Invalid batch size: ${argv[i]}`);
        process.exit(1);
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return { dryRun, batchSize };
}

/**
 * Find chunks that need (re)embedding:
 * - Chunks with no embedding row for the configured provider/model.
 * - Chunks whose embedding source_hash differs from current content_hash.
 */
async function findChunksNeedingEmbedding(
  providerId: string,
  modelId: string,
  dimensions: number
): Promise<ChunkToEmbed[]> {
  const sql = `
    SELECT c.id, c.document_id, c.content, c.content_hash
    FROM document_chunks c
    WHERE NOT EXISTS (
      SELECT 1
      FROM document_chunk_embeddings e
      WHERE e.chunk_id = c.id
        AND e.provider = $1
        AND e.model_id = $2
        AND e.dimensions = $3
        AND e.source_hash = c.content_hash
    )
    ORDER BY c.document_id, c.chunk_index
  `;

  const res = await query<ChunkToEmbed>(sql, [providerId, modelId, dimensions]);
  return res.rows;
}

/**
 * Insert or update embeddings for a batch of chunks within a transaction.
 */
async function upsertEmbeddings(
  client: any,
  chunks: ChunkToEmbed[],
  vectors: number[][],
  providerId: string,
  modelId: string,
  dimensions: number
): Promise<number> {
  const insertSql = `
    INSERT INTO document_chunk_embeddings (
      id, chunk_id, document_id, provider, model_id, model_digest,
      dimensions, source_hash, embedding
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (chunk_id, provider, model_id) DO UPDATE SET
      document_id = EXCLUDED.document_id,
      model_digest = EXCLUDED.model_digest,
      dimensions = EXCLUDED.dimensions,
      source_hash = EXCLUDED.source_hash,
      embedding = EXCLUDED.embedding,
      created_at = CURRENT_TIMESTAMP
  `;

  let count = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vector = vectors[i];
    if (!vector) continue;

    await client.query(insertSql, [
      `emb_${randomUUID()}`,
      chunk.id,
      chunk.document_id,
      providerId,
      modelId,
      null,
      dimensions,
      chunk.content_hash,
      JSON.stringify(vector),
    ]);
    count++;
  }
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dryRun, batchSize } = args;

  const provider = getEmbeddingProvider();
  if (!provider) {
    console.error(
      'No embedding provider configured. Set EMBEDDING_PROVIDER=ollama and ' +
        'ensure OLLAMA_EMBEDDING_BASE_URL and OLLAMA_EMBEDDING_MODEL are set.'
    );
    process.exit(1);
  }

  console.log('=== CiteRail Embedding Backfill ===');
  console.log(`Provider: ${provider.providerId}`);
  console.log(`Model: ${provider.modelId}`);
  console.log(`Dimensions: ${provider.dimensions}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Find chunks needing (re)embedding.
  const chunks = await findChunksNeedingEmbedding(
    provider.providerId,
    provider.modelId,
    provider.dimensions
  );

  const stats: BackfillStats = {
    totalChunks: 0,
    missingEmbeddings: chunks.length,
    staleEmbeddings: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: dryRun ? chunks.length : 0,
  };

  // Count total chunks for reporting.
  const totalRes = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM document_chunks'
  );
  stats.totalChunks = Number(totalRes.rows[0].count);

  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(`Chunks needing (re)embedding: ${stats.missingEmbeddings}`);
  console.log('');

  if (chunks.length === 0) {
    console.log('All chunks have valid embeddings. Nothing to do.');
    await pool.end();
    return;
  }

  if (dryRun) {
    console.log('Dry run: would process the following chunks:');
    for (const chunk of chunks.slice(0, 10)) {
      console.log(`  ${chunk.id} (doc ${chunk.document_id}): ${chunk.content.slice(0, 60)}...`);
    }
    if (chunks.length > 10) {
      console.log(`  ... and ${chunks.length - 10} more`);
    }
    await pool.end();
    return;
  }

  // Process in bounded batches.
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.content);

    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(chunks.length / batchSize)} (${batch.length} chunks)...`
    );

    let vectors: number[][];
    try {
      vectors = await provider.embedDocuments(texts);
    } catch (embedErr) {
      console.error(
        `  Embedding generation failed for batch:`,
        embedErr instanceof Error ? embedErr.message : String(embedErr)
      );
      stats.failed += batch.length;
      stats.processed += batch.length;
      continue;
    }

    if (vectors.length !== batch.length) {
      console.error(
        `  Provider returned ${vectors.length} vectors for ${batch.length} chunks; skipping batch.`
      );
      stats.failed += batch.length;
      stats.processed += batch.length;
      continue;
    }

    try {
      const persisted = await withTransaction(async (client) => {
        return upsertEmbeddings(
          client,
          batch,
          vectors,
          provider.providerId,
          provider.modelId,
          provider.dimensions
        );
      });
      stats.succeeded += persisted;
      stats.processed += batch.length;
      console.log(`  Persisted ${persisted} embeddings.`);
    } catch (dbErr) {
      console.error(
        `  Database write failed:`,
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      );
      stats.failed += batch.length;
      stats.processed += batch.length;
    }
  }

  console.log('');
  console.log('=== Backfill Results ===');
  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Succeeded: ${stats.succeeded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Skipped (dry-run): ${stats.skipped}`);
  console.log('');

  await pool.end();

  if (stats.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
