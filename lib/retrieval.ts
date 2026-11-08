import { query } from './db';
import { ChunkRecord } from './documents';
import { getEmbeddingProvider, EmbeddingProvider } from './embedding';
import { ELIGIBILITY_SQL_PREDICATE } from './eligibility';

/**
 * Minimum fraction of the significant query terms that must appear in a chunk
 * for it to be considered relevant when full-text ranking does not fire.
 */
const MIN_TERM_COVERAGE = 0.34;

/**
 * RRF constant: higher values emphasize top-ranked results more strongly.
 * k = 60 is a conventional starting point.
 */
const RRF_K = 60;

/**
 * Default number of candidates to retrieve from each retrieval path before
 * fusion. Bounded to keep queries performant as the corpus grows.
 */
const DEFAULT_CANDIDATE_LIMIT = 25;

export interface SearchOptions {
  limit?: number;
  minTermCoverage?: number;
  /** Force FTS-only retrieval (skip semantic path). */
  ftsOnly?: boolean;
  /** Force semantic-only retrieval (skip FTS path). */
  semanticOnly?: boolean;
}

/**
 * Result of a single retrieval path, ranked by that path's own scoring.
 */
interface RankedCandidate {
  chunk: ChunkRecord;
  rank: number; // 1-based rank within this path
  score: number; // raw score from this path
}

/**
 * Full-text search retrieval path. Returns ranked candidates.
 * Applies the same eligibility predicate as the semantic path.
 */
async function ftsRetrieval(
  cleanQuery: string,
  limit: number,
  minCoverage: number
): Promise<RankedCandidate[]> {
  const sql = `
    WITH query_terms AS (
      SELECT ARRAY(
        SELECT lower(w)
        FROM unnest(string_to_array($1, ' ')) AS w
        WHERE length(w) > 2
      ) AS terms
    ),
    scored_chunks AS (
      SELECT
        c.id,
        c.document_id,
        c.publisher_id,
        c.chunk_index,
        c.content,
        c.content_hash,
        c.token_count,
        d.title AS document_title,
        d.price_per_query_usdc,
        p.wallet_address AS publisher_wallet,
        p.name AS publisher_name,
        ts_rank_cd(c.search_vector, plainto_tsquery('english', $1)) AS rank_score,
        CASE
          WHEN c.content ILIKE '%' || $1 || '%' THEN 1.0
          ELSE 0.0
        END AS exact_match_score,
        CASE
          WHEN COALESCE(array_length(qt.terms, 1), 0) = 0 THEN 0.0
          ELSE (
            SELECT count(*)::float
            FROM unnest(qt.terms) AS t
            WHERE c.content ILIKE '%' || t || '%'
          ) / array_length(qt.terms, 1)
        END AS term_coverage
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      JOIN publishers p ON c.publisher_id = p.id
      CROSS JOIN query_terms qt
      WHERE ${ELIGIBILITY_SQL_PREDICATE}
    )
    SELECT *
    FROM scored_chunks
    WHERE rank_score > 0
       OR exact_match_score > 0
       OR term_coverage >= $2
    ORDER BY (rank_score * 2.0 + exact_match_score + term_coverage) DESC, chunk_index ASC, document_id ASC, id ASC
    LIMIT $3;
  `;

  const res = await query(sql, [cleanQuery, minCoverage, limit]);

  return res.rows.map((row: any, i: number) => ({
    chunk: {
      id: row.id,
      document_id: row.document_id,
      publisher_id: row.publisher_id,
      chunk_index: row.chunk_index,
      content: row.content,
      content_hash: row.content_hash,
      token_count: row.token_count,
      document_title: row.document_title,
      price_per_query_usdc: row.price_per_query_usdc,
      publisher_wallet: row.publisher_wallet,
      publisher_name: row.publisher_name,
    },
    rank: i + 1,
    score: Number(row.rank_score ?? 0) * 2 + Number(row.exact_match_score ?? 0) + Number(row.term_coverage ?? 0),
  }));
}

/**
 * Semantic retrieval path using pgvector cosine distance.
 * Returns ranked candidates ordered by similarity (most similar first).
 * Applies the same eligibility predicate as the FTS path.
 *
 * Only embeddings whose (provider, model_id, dimensions, model_digest) tuple
 * matches the verified identity of the CURRENT provider instance are
 * considered. Legacy rows with unknown digests can never silently satisfy
 * semantic retrieval.
 */
async function semanticRetrieval(
  provider: EmbeddingProvider,
  queryVector: number[],
  limit: number
): Promise<RankedCandidate[]> {
  const sql = `
    SELECT
      c.id,
      c.document_id,
      c.publisher_id,
      c.chunk_index,
      c.content,
      c.content_hash,
      c.token_count,
      d.title AS document_title,
      d.price_per_query_usdc,
      p.wallet_address AS publisher_wallet,
      p.name AS publisher_name,
      e.embedding <=> $1::vector AS cosine_distance
    FROM document_chunk_embeddings e
    JOIN document_chunks c ON e.chunk_id = c.id
    JOIN documents d ON c.document_id = d.id
    JOIN publishers p ON c.publisher_id = p.id
    WHERE ${ELIGIBILITY_SQL_PREDICATE}
      AND e.provider = $2
      AND e.model_id = $3
      AND e.dimensions = $4
      AND e.model_digest = $5
      AND e.source_hash = c.content_hash
    ORDER BY e.embedding <=> $1::vector, c.chunk_index ASC, d.id ASC, c.id ASC
    LIMIT $6;
  `;

  const vectorText = `[${queryVector.join(',')}]`;

  const res = await query(sql, [
    vectorText,
    provider.providerId,
    provider.modelId,
    provider.dimensions,
    provider.modelDigest,
    limit,
  ]);

  return res.rows.map((row: any, i: number) => ({
    chunk: {
      id: row.id,
      document_id: row.document_id,
      publisher_id: row.publisher_id,
      chunk_index: row.chunk_index,
      content: row.content,
      content_hash: row.content_hash,
      token_count: row.token_count,
      document_title: row.document_title,
      price_per_query_usdc: row.price_per_query_usdc,
      publisher_wallet: row.publisher_wallet,
      publisher_name: row.publisher_name,
    },
    rank: i + 1,
    // Convert cosine distance to a similarity score (1 - distance).
    // Lower distance = higher similarity.
    score: 1 - Number(row.cosine_distance ?? 1),
  }));
}

/**
 * Reciprocal Rank Fusion: combine ranked candidates from multiple paths.
 *
 * score(d) = Σ 1 / (k + rank_i(d))
 *
 * A chunk appearing in multiple paths gets a boosted score.
 */
function rrfFuse(
  paths: RankedCandidate[][],
  k: number = RRF_K
): Map<string, { chunk: ChunkRecord; fusedScore: number; pathCount: number }> {
  const fused = new Map<
    string,
    { chunk: ChunkRecord; fusedScore: number; pathCount: number }
  >();

  for (const path of paths) {
    for (const candidate of path) {
      const existing = fused.get(candidate.chunk.id);
      const contribution = 1 / (k + candidate.rank);
      if (existing) {
        existing.fusedScore += contribution;
        existing.pathCount += 1;
      } else {
        fused.set(candidate.chunk.id, {
          chunk: candidate.chunk,
          fusedScore: contribution,
          pathCount: 1,
        });
      }
    }
  }

  return fused;
}

/**
 * Execution diagnostics for a single retrieval call. Evaluation uses these to
 * report honestly which paths actually ran, so an FTS fallback is never
 * mislabelled as a hybrid result.
 */
export interface RetrievalDiagnostics {
  /** The FTS path executed (or was skipped by semanticOnly). */
  ftsExecuted: boolean;
  /** The semantic path produced a query embedding and executed a search. */
  semanticExecuted: boolean;
  /** Semantic was attempted but failed; results are FTS-only. */
  semanticFallback: boolean;
  /** No embedding provider is configured/available at all. */
  semanticUnavailable: boolean;
}

/**
 * Hybrid retrieval with explicit execution diagnostics.
 *
 * Behaviour is identical to `searchKnowledgeCollections` (graceful FTS
 * fallback preserved for production), but the caller additionally learns
 * which retrieval paths actually executed so evaluation reporting can stay
 * truthful.
 */
export async function searchWithDiagnostics(
  userQuery: string,
  limitOrOptions: number | SearchOptions = 4
): Promise<{ results: ChunkRecord[]; diagnostics: RetrievalDiagnostics }> {
  const options: SearchOptions =
    typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions;

  const limit = Math.min(Math.max(options.limit ?? 4, 1), 25);
  const minCoverage = options.minTermCoverage ?? MIN_TERM_COVERAGE;
  const ftsOnly = options.ftsOnly === true;
  const semanticOnly = options.semanticOnly === true;

  const cleanQuery = userQuery.trim();
  if (!cleanQuery) {
    return {
      results: [],
      diagnostics: {
        ftsExecuted: false,
        semanticExecuted: false,
        semanticFallback: false,
        semanticUnavailable: !ftsOnly,
      },
    };
  }

  const candidateLimit = DEFAULT_CANDIDATE_LIMIT;

  const diagnostics: RetrievalDiagnostics = {
    ftsExecuted: false,
    semanticExecuted: false,
    semanticFallback: false,
    semanticUnavailable: false,
  };

  // Path 1: Full-text retrieval (always runs unless semanticOnly).
  let ftsCandidates: RankedCandidate[] = [];
  if (!semanticOnly) {
    try {
      ftsCandidates = await ftsRetrieval(cleanQuery, candidateLimit, minCoverage);
      diagnostics.ftsExecuted = true;
    } catch (err) {
      console.error('FTS retrieval failed:', err);
    }
  }

  // Path 2: Semantic retrieval (runs unless ftsOnly; degrades gracefully).
  // Provider initialization itself lives inside the failure handler: an
  // invalid embedding configuration (or an unresolvable model identity) must
  // never prevent the FTS path from operating.
  let semanticCandidates: RankedCandidate[] = [];
  if (!ftsOnly) {
    try {
      const provider = await getEmbeddingProvider();
      if (provider) {
        const queryVector = await provider.embedQuery(cleanQuery);
        semanticCandidates = await semanticRetrieval(provider, queryVector, candidateLimit);
        diagnostics.semanticExecuted = true;
      } else {
        diagnostics.semanticUnavailable = true;
      }
    } catch (err) {
      // Embedding failure is non-fatal: FTS results are still returned, but
      // the diagnostics record that the semantic path fell back.
      diagnostics.semanticFallback = true;
      console.error(
        'Semantic retrieval failed, falling back to FTS:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // Fuse results using RRF.
  const paths: RankedCandidate[][] = [];
  if (!semanticOnly) paths.push(ftsCandidates);
  if (!ftsOnly) paths.push(semanticCandidates);

  const fused = rrfFuse(paths, RRF_K);

  // Sort by fused score descending, then fully deterministic tie-breaking:
  // chunk_index ascending, then document_id ascending, then chunk_id
  // ascending. Repeated runs over equal-scoring candidates always produce
  // identical ordering.
  const sorted = Array.from(fused.values()).sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) {
      return b.fusedScore - a.fusedScore;
    }
    if (a.chunk.chunk_index !== b.chunk.chunk_index) {
      return a.chunk.chunk_index - b.chunk.chunk_index;
    }
    const docCompare = a.chunk.document_id.localeCompare(b.chunk.document_id);
    if (docCompare !== 0) return docCompare;
    return a.chunk.id.localeCompare(b.chunk.id);
  });

  // Take the top `limit` results.
  const top = sorted.slice(0, limit);

  return {
    results: top.map((entry) => ({
      ...entry.chunk,
      score: entry.fusedScore,
    })),
    diagnostics,
  };
}

/**
 * Hybrid retrieval: combine FTS and semantic candidate rankings using RRF.
 *
 * If the embedding provider is unavailable, falls back to FTS-only.
 * If semantic returns no candidates, FTS results are still returned.
 */
export async function searchKnowledgeCollections(
  userQuery: string,
  limitOrOptions: number | SearchOptions = 4
): Promise<ChunkRecord[]> {
  const { results } = await searchWithDiagnostics(userQuery, limitOrOptions);
  return results;
}
