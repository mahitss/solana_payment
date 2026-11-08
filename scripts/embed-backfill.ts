/**
 * Embedding backfill script for CiteRail.
 *
 * Identifies chunks that are not covered by an embedding of the CURRENT,
 * verified model version, classifies them, and (re)generates them using the
 * configured embedding provider. Only chunks permitted by the retrieval
 * eligibility policy (active publisher, active document, supported license)
 * are processed.
 *
 * Classification (mutually exclusive, evaluated in order):
 *   - current   : a current-version embedding row matches the content hash (nothing to do)
 *   - stale     : a current-version embedding row exists but the chunk content
 *                 hash has drifted (content changed since embedding)
 *   - outdated  : only embedding rows from a DIFFERENT model digest exist
 *                 (older model revision; legacy empty-digest rows count here)
 *   - missing   : no embedding rows at all for this chunk
 *
 * Safety properties:
 *   - Embedding writes persist under the provider's VERIFIED immutable model
 *     digest; the conflict target is the four-column unique index
 *     (chunk_id, provider, model_id, model_digest).
 *   - Bounded batches; no database transaction is held open during model
 *     inference; each batch is persisted only after complete vector validation.
 *   - No raw publisher source content is ever logged (dry run included).
 *   - Re-running is idempotent: already-current chunks are skipped and
 *     upserts never duplicate rows.
 *
 * Usage:
 *   npx tsx scripts/embed-backfill.ts [--dry-run] [--batch-size N]
 *
 * Requires DATABASE_URL and an embedding provider whose model identity can
 * be verified (Ollama via the dedicated embedding endpoint).
 */

import { randomUUID } from 'crypto';
import { query, pool, withTransaction } from '../lib/db';
import {
  getEmbeddingProvider,
  EmbeddingProvider,
} from '../lib/embedding';
import { ELIGIBILITY_SQL_PREDICATE } from '../lib/eligibility';

export interface ChunkToEmbed {
  id: string;
  document_id: string;
  content: string;
  content_hash: string;
  category: 'missing' | 'stale' | 'outdated';
}

export interface BackfillStats {
  totalChunks: number;
  missingEmbeddings: number;
  staleEmbeddings: number;
  outdatedEmbeddings: number;
  eligibleChunks: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

const DEFAULT_BATCH_SIZE = 32;
/** First N chunk IDs included in dry-run output (ids only — never content). */
const DRY_RUN_SAMPLE_SIZE = 10;

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
 * Pure classifier for a single chunk's embedding state against the current
 * model identity. Exported for tests; the SQL below encodes the same rules.
 */
export function categorizeChunkEmbedding(agg: {
  currentVersionRows: number | string | bigint;
  currentVersionHashMatches: number | string | bigint;
  otherVersionRows: number | string | bigint;
}): 'current' | 'stale' | 'outdated' | 'missing' {
  const currentRows = Number(agg.currentVersionRows ?? 0);
  const currentMatches = Number(agg.currentVersionHashMatches ?? 0);
  const otherRows = Number(agg.otherVersionRows ?? 0);

  if (currentRows > 0) {
    // Current-version rows exist. Stale only when None of them match the
    // chunk's current content hash.
    return currentMatches > 0 ? 'current' : 'stale';
  }
  return otherRows > 0 ? 'outdated' : 'missing';
}

/**
 * Find chunks that need (re)embedding under the CURRENT model identity.
 *
 * Only chunks permitted by the eligibility policy are considered, so a
 * revoked publisher/document or unsupported license can never be re-embedded.
 * Legacy rows whose digest differs from the verified current digest (including
 * the historical empty-string legacy rows) never satisfy the current-match.
 */
export async function collectChunksForBackfill(provider: EmbeddingProvider): Promise<ChunkToEmbed[]> {
  const sql = `
    WITH per_chunk AS (
      SELECT
        c.id,
        c.document_id,
        c.content,
        c.content_hash,
        COUNT(*) FILTER (
          WHERE e.provider = $1 AND e.model_id = $2 AND e.model_digest = $3
        ) AS current_version_rows,
        COUNT(*) FILTER (
          WHERE e.provider = $1 AND e.model_id = $2 AND e.model_digest = $3
            AND e.source_hash = c.content_hash
        ) AS current_version_hash_matches,
        COUNT(*) FILTER (
          WHERE e.provider = $1 AND e.model_id = $2 AND e.model_digest <> $3
        ) AS other_version_rows
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      JOIN publishers p ON c.publisher_id = p.id
      LEFT JOIN document_chunk_embeddings e ON e.chunk_id = c.id
      WHERE ${ELIGIBILITY_SQL_PREDICATE}
      GROUP BY c.id, c.document_id, c.content, c.content_hash
    )
    SELECT id, document_id, content, content_hash,
           current_version_rows, current_version_hash_matches, other_version_rows
    FROM per_chunk
    WHERE NOT (
      current_version_rows > 0 AND current_version_hash_matches > 0
    )
    ORDER BY document_id, id
  `;

  const res = await query<{
    id: string;
    document_id: string;
    content: string;
    content_hash: string;
    current_version_rows: string;
    current_version_hash_matches: string;
    other_version_rows: string;
  }>(sql, [provider.providerId, provider.modelId, provider.modelDigest]);

  const toReturn: ChunkToEmbed[] = [];
  for (const row of res.rows) {
    const category = categorizeChunkEmbedding({
      currentVersionRows: row.current_version_rows,
      currentVersionHashMatches: row.current_version_hash_matches,
      otherVersionRows: row.other_version_rows,
    });
    if (category === 'missing' || category === 'stale' || category === 'outdated') {
      toReturn.push({
        id: row.id,
        document_id: row.document_id,
        content: row.content,
        content_hash: row.content_hash,
        category,
      });
    }
  }
  return toReturn;
}

export function renderDryRunSummary(chunks: ChunkToEmbed[]): string {
  const byCategory: Record<string, number> = {
    missing: 0,
    stale: 0,
    outdated: 0,
  };
  for (const c of chunks) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;

  let out = '';
  out += `Chunks needing embedding: ${chunks.length}\n`;
  out += `  missing: ${byCategory.missing}\n`;
  out += `  stale (content hash drift): ${byCategory.stale}\n`;
  out += `  outdated (other model version only): ${byCategory.outdated}\n`;
  out += `Sample (IDs only, chunk content is never logged):\n`;
  for (const c of chunks.slice(0, DRY_RUN_SAMPLE_SIZE)) {
    out += `  ${c.id} (doc ${c.document_id}, ${c.category}, hash ${c.content_hash.slice(0, 12)}…)\n`;
  }
  if (chunks.length > DRY_RUN_SAMPLE_SIZE) {
    out += `  ... and ${chunks.length - DRY_RUN_SAMPLE_SIZE} more\n`;
  }
  return out;
}

/**
 * Validates a vector batch and persists it in a single bounded transaction.
 *
 * Validation happens BEFORE any write: the provider contract guarantees one
 * vector per input in order, but this persistence path enforces it again so
 * a malformed batch never lands half-persisted. The conflict target matches
 * the four-column unique index exactly; a mismatch would be a programming
 * error, so the SQL uses the full composite key.
 */
export async function persistBackfillBatch(
  chunks: ChunkToEmbed[],
  vectors: number[][],
  provider: EmbeddingProvider
): Promise<number> {
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Provider returned ${vectors.length} vectors for ${chunks.length} chunks; rejecting batch.`
    );
  }

  // Full vector validation before opening the transaction.
  const validated: number[][] = vectors.map((v, i) => {
    if (
      !Array.isArray(v) ||
      v.length !== provider.dimensions ||
      !v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new Error(
        `Vector validation failed for chunk ${chunks[i].id}: expected ${provider.dimensions} finite dimensions.`
      );
    }
    return v;
  });

  const insertSql = `
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

  return withTransaction(async (client) => {
    let count = 0;
    for (let i = 0; i < chunks.length; i++) {
      await client.query(insertSql, [
        `emb_${randomUUID()}`,
        chunks[i].id,
        chunks[i].document_id,
        provider.providerId,
        provider.modelId,
        provider.modelDigest,
        provider.dimensions,
        chunks[i].content_hash,
        JSON.stringify(validated[i]),
      ]);
      count++;
    }
    return count;
  });
}

function emptyStats(): BackfillStats {
  return {
    totalChunks: 0,
    missingEmbeddings: 0,
    staleEmbeddings: 0,
    outdatedEmbeddings: 0,
    eligibleChunks: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
}

export function buildInitialStats(chunks: ChunkToEmbed[], totalChunks: number): BackfillStats {
  const stats = emptyStats();
  stats.totalChunks = totalChunks;
  stats.eligibleChunks = chunks.length;
  for (const c of chunks) {
    if (c.category === 'missing') stats.missingEmbeddings++;
    else if (c.category === 'stale') stats.staleEmbeddings++;
    else stats.outdatedEmbeddings++;
  }
  return stats;
}

export async function runBackfill(provider: EmbeddingProvider, batchSize: number, dryRun: boolean): Promise<BackfillStats> {
  const chunks = await collectChunksForBackfill(provider);

  const chunksRes = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM document_chunks'
  );
  const stats = buildInitialStats(chunks, Number(chunksRes.rows[0].count));

  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(
    `Eligible chunks not covered by the current model version: ${chunks.length} ` +
      `(missing: ${stats.missingEmbeddings}, stale: ${stats.staleEmbeddings}, outdated: ${stats.outdatedEmbeddings})`
  );
  console.log('');

  if (chunks.length === 0) return stats;

  if (dryRun) {
    process.stdout.write(renderDryRunSummary(chunks));
    stats.skipped = chunks.length;
    return stats;
  }

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.content);

    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(
        chunks.length / batchSize
      )} (${batch.length} chunks)...`
    );

    // Model inference happens OUTSIDE any database transaction.
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

    try {
      const persisted = await persistBackfillBatch(batch, vectors, provider);
      stats.succeeded += persisted;
      stats.processed += batch.length;
      console.log(`  Persisted ${persisted} embedding(s).`);
    } catch (dbErr) {
      console.error(
        `  Database write failed:`,
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      );
      stats.failed += batch.length;
      stats.processed += batch.length;
    }
  }

  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dryRun, batchSize } = args;

  let provider: EmbeddingProvider | null;
  try {
    provider = await getEmbeddingProvider();
  } catch (err) {
    console.error(
      'Embedding provider initialization failed. Model identity could not ' +
        'be verified; refusing to backfill with unverified embeddings.',
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
    return;
  }
  if (!provider) {
    console.error(
      'No embedding provider configured. Set EMBEDDING_PROVIDER=ollama and ' +
        'ensure OLLAMA_EMBEDDING_BASE_URL and OLLAMA_EMBEDDING_MODEL are set.'
    );
    process.exit(1);
    return;
  }

  console.log('=== CiteRail Embedding Backfill ===');
  console.log(`Provider: ${provider.providerId}`);
  console.log(`Model: ${provider.modelId}`);
  console.log(`Model digest: ${provider.modelDigest}`);
  console.log(`Dimensions: ${provider.dimensions}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  const stats = await runBackfill(provider, batchSize, dryRun);

  console.log('');
  console.log('=== Backfill Results ===');
  console.log(`Total chunks: ${stats.totalChunks}`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Succeeded: ${stats.succeeded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Skipped (dry-run): ${stats.skipped}`);
  console.log('');

  if (stats.failed > 0) {
    process.exit(1);
  }
}

// Only run main when executed directly (not when imported by tests).
const isMainModule =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMainModule) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
