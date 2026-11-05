import { query } from './db';
import { ChunkRecord } from './documents';

export async function searchKnowledgeCollections(
  userQuery: string,
  limit: number = 4
): Promise<ChunkRecord[]> {
  const cleanQuery = userQuery.trim();
  if (!cleanQuery) {
    return [];
  }

  // Two-tiered search: Full-text search with ts_rank_cd, falling back to ILIKE substring matching
  const sql = `
    WITH ranked_chunks AS (
      SELECT 
        c.id,
        c.document_id,
        c.publisher_id,
        c.chunk_index,
        c.content,
        c.content_hash,
        c.token_count,
        d.title as document_title,
        d.price_per_query_usdc,
        p.wallet_address as publisher_wallet,
        p.name as publisher_name,
        ts_rank_cd(c.search_vector, plainto_tsquery('english', $1)) as rank_score,
        CASE 
          WHEN c.content ILIKE '%' || $1 || '%' THEN 1.0
          ELSE 0.0
        END as exact_match_score
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      JOIN publishers p ON c.publisher_id = p.id
    )
    SELECT *
    FROM ranked_chunks
    WHERE rank_score > 0.001 OR exact_match_score > 0 OR content ILIKE ANY(
      ARRAY(SELECT '%' || word || '%' FROM unnest(string_to_array($1, ' ')) word WHERE length(word) > 2)
    )
    ORDER BY (rank_score * 2.0 + exact_match_score) DESC, chunk_index ASC
    LIMIT $2;
  `;

  try {
    const res = await query<ChunkRecord>(sql, [cleanQuery, limit]);
    
    // If exact query returned no rows, fall back to matching individual significant keywords
    if (res.rows.length === 0) {
      const fallbackSql = `
        SELECT 
          c.id,
          c.document_id,
          c.publisher_id,
          c.chunk_index,
          c.content,
          c.content_hash,
          c.token_count,
          d.title as document_title,
          d.price_per_query_usdc,
          p.wallet_address as publisher_wallet,
          p.name as publisher_name,
          0.1 as score
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        JOIN publishers p ON c.publisher_id = p.id
        ORDER BY c.created_at DESC
        LIMIT $1;
      `;
      const fallbackRes = await query<ChunkRecord>(fallbackSql, [limit]);
      return fallbackRes.rows;
    }

    return res.rows;
  } catch (err) {
    console.error('Error executing searchKnowledgeCollections:', err);
    throw err;
  }
}
