import { query } from './db';
import { ChunkRecord } from './documents';

/**
 * Minimum fraction of the significant query terms that must appear in a chunk
 * for it to be considered relevant when full-text ranking does not fire.
 *
 * The previous implementation had no relevance floor at all: it matched any
 * single word longer than two characters, and when that still found nothing it
 * fell back to returning the most recently uploaded chunks regardless of
 * relevance. Because a quote was then created from those chunks and the
 * consumer was charged for them, unrelated content was being billed.
 */
const MIN_TERM_COVERAGE = 0.34;

export interface SearchOptions {
  limit?: number;
  minTermCoverage?: number;
}

export async function searchKnowledgeCollections(
  userQuery: string,
  limitOrOptions: number | SearchOptions = 4
): Promise<ChunkRecord[]> {
  const options: SearchOptions =
    typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions }
      : limitOrOptions;

  const limit = Math.min(Math.max(options.limit ?? 4, 1), 25);
  const minCoverage = options.minTermCoverage ?? MIN_TERM_COVERAGE;

  const cleanQuery = userQuery.trim();
  if (!cleanQuery) {
    return [];
  }

  /*
   * Scoring combines three signals:
   *   rank_score        - PostgreSQL full-text relevance (ts_rank_cd)
   *   exact_match_score - the full query string appears verbatim
   *   term_coverage     - fraction of significant query terms present
   *
   * A chunk is only returned when it has real relevance, so the consumer is
   * never charged for content that does not answer their question.
   */
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
    )
    SELECT *
    FROM scored_chunks
    WHERE rank_score > 0
       OR exact_match_score > 0
       OR term_coverage >= $3
    ORDER BY (rank_score * 2.0 + exact_match_score + term_coverage) DESC, chunk_index ASC
    LIMIT $2;
  `;

  try {
    const res = await query<ChunkRecord>(sql, [cleanQuery, limit, minCoverage]);

    return res.rows.map((row: any) => ({
      ...row,
      score: Number(row.rank_score ?? 0) * 2 + Number(row.exact_match_score ?? 0) + Number(row.term_coverage ?? 0),
    }));
  } catch (err) {
    console.error('Error executing searchKnowledgeCollections:', err);
    throw err;
  }
}
