/**
 * Retrieval evaluation framework for CiteRail.
 *
 * Compares retrieval methods on a labelled evaluation dataset:
 *   1. Full-text search (FTS) only
 *   2. Semantic (vector) only   — only when an embedding provider is available
 *   3. Hybrid (FTS + semantic via RRF)
 *
 * Metrics: Recall@5, Recall@10, MRR@10, nDCG@10, empty-result count, latency.
 * Latency is recorded separately from retrieval quality: quality metrics are
 * only ever computed from real, non-empty, verifiable labels.
 *
 * If labels are missing, empty, or reference chunk IDs that do not exist in
 * the corpus, the script prints
 *   RETRIEVAL QUALITY: NOT EVALUATED
 * and never fabricates zero-valued Recall/MRR/nDCG numbers or claims about
 * hybrid retrieval outperforming FTS.
 *
 * Dataset sources:
 *   - Operator-supplied JSON file via the RETRIEVAL_EVAL_DATASET environment
 *     variable, with the schema:
 *       { "queries": [ { "id": "eval_001", "query": "...",
 *                        "relevantChunkIds": ["chk_..."] }, ... ] }
 *
 * Usage:
 *   npx tsx scripts/evaluate-retrieval.ts
 */

import fs from 'fs';
import { query, pool } from '../lib/db';
import { searchKnowledgeCollections } from '../lib/retrieval';
import { getEmbeddingProvider } from '../lib/embedding';

export interface EvalQuery {
  id: string;
  query: string;
  relevantChunkIds: string[];
}

export interface DatasetValidation {
  valid: boolean;
  problems: string[];
  labelledQueryCount: number;
}

export const NOT_EVALUATED_HEADER = 'RETRIEVAL QUALITY: NOT EVALUATED';

/**
 * Validates that an evaluation dataset contains REAL labelled relevance
 * judgements:
 *   - at least one labelled query,
 *   - every query has at least one relevant chunk ID,
 *   - every referenced chunk ID exists in the evaluation corpus.
 * Importantly, a query is not "evaluated" if its query text is missing.
 */
export function validateEvaluationDataset(
  queries: EvalQuery[],
  corpusChunkIds: Set<string>
): DatasetValidation {
  const problems: string[] = [];

  if (!Array.isArray(queries) || queries.length === 0) {
    return {
      valid: false,
      problems: ['Evaluation dataset is empty.'],
      labelledQueryCount: 0,
    };
  }

  let labelledQueryCount = 0;
  for (const q of queries) {
    if (!q || typeof q.query !== 'string' || !q.query.trim()) {
      problems.push(`Query ${q?.id ?? '<missing id>'} has no query text.`);
      continue;
    }
    if (!Array.isArray(q.relevantChunkIds) || q.relevantChunkIds.length === 0) {
      problems.push(
        `Query ${q.id} has no labelled relevantChunkIds; it cannot produce quality metrics.`
      );
      continue;
    }
    labelledQueryCount++;
    for (const chunkId of q.relevantChunkIds) {
      if (!corpusChunkIds.has(chunkId)) {
        problems.push(
          `Query ${q.id} references chunk ${chunkId} which does not exist in the corpus.`
        );
      }
    }
  }

  if (queries.every((q) => !q || !Array.isArray(q.relevantChunkIds) || q.relevantChunkIds.length === 0)) {
    problems.push(
      'No queries carry labelled relevant chunk IDs. Quality metrics cannot be measured.'
    );
  }

  return {
    valid: problems.length === 0,
    problems,
    labelledQueryCount,
  };
}

/**
 * Renders the standard NOT EVALUATED banner with the concrete reasons.
 */
export function renderNotEvaluated(problems: string[]): string {
  const lines = [NOT_EVALUATED_HEADER];
  lines.push(
    'Labelled evaluation data is missing or invalid, so no Recall, MRR, or ' +
      'nDCG values are reported and no retrieval-quality claims are made.'
  );
  for (const p of problems) {
    lines.push(`  - ${p}`);
  }
  lines.push(
    "Populate an operator dataset (RETRIEVAL_EVAL_DATASET) with verified, " +
      'existing chunk IDs to enable quality evaluation.'
  );
  return lines.join('\n');
}

/**
 * Loads the evaluation dataset. When RETRIEVAL_EVAL_DATASET points at a JSON
 * file, that operator-supplied dataset is used; otherwise an empty dataset is
 * returned (which always validates as NOT EVALUATED rather than inventing
 * labels).
 */
export function loadEvaluationDataset(
  envVar: string | undefined = process.env.RETRIEVAL_EVAL_DATASET
): EvalQuery[] {
  if (envVar && envVar.trim()) {
    const path = envVar.trim();
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queries)) {
      throw new Error(
        `Evaluation dataset at ${path} must be JSON of shape { "queries": [...] }`
      );
    }
    return parsed.queries as EvalQuery[];
  }
  return [];
}

interface EvalResult {
  method: string;
  totalQueries: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  emptyResults: number;
  avgLatencyMs: number;
  perQuery: Array<{
    queryId: string;
    query: string;
    retrievedIds: string[];
    recallAt5: number;
    recallAt10: number;
    mrrAt10: number;
    ndcgAt10: number;
    latencyMs: number;
  }>;
}

function reciprocalRank(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    if (relevantIds.has(rankedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcg(
  rankedIds: string[],
  relevantIds: Set<string>,
  k: number
): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    if (relevantIds.has(rankedIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG: all relevant items at the top.
  let idcg = 0;
  const relevantCount = Math.min(k, relevantIds.size);
  for (let i = 0; i < relevantCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

function recall(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 0;
  let found = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    if (relevantIds.has(rankedIds[i])) found++;
  }
  return found / relevantIds.size;
}

async function evaluateMethod(
  method: string,
  queries: EvalQuery[],
  ftsOnly: boolean,
  semanticOnly: boolean
): Promise<EvalResult> {
  const perQuery: EvalResult['perQuery'] = [];
  let totalRecall5 = 0;
  let totalRecall10 = 0;
  let totalMRR10 = 0;
  let totalNDCG10 = 0;
  let emptyCount = 0;
  let totalLatency = 0;

  for (const q of queries) {
    const relevantIds = new Set(q.relevantChunkIds);

    const start = Date.now();
    let results: any[];
    try {
      results = await searchKnowledgeCollections(q.query, {
        limit: 10,
        minTermCoverage: 0,
        ftsOnly,
        semanticOnly,
      });
    } catch (err) {
      console.error(
        `Error running ${method} for query "${q.query}":`,
        err instanceof Error ? err.message : String(err)
      );
      results = [];
    }
    const latencyMs = Date.now() - start;

    const retrievedIds = results.map((r) => r.id);
    const r5 = recall(retrievedIds, relevantIds, 5);
    const r10 = recall(retrievedIds, relevantIds, 10);
    const mrr = reciprocalRank(retrievedIds, relevantIds, 10);
    const ndcg10 = ndcg(retrievedIds, relevantIds, 10);

    totalRecall5 += r5;
    totalRecall10 += r10;
    totalMRR10 += mrr;
    totalNDCG10 += ndcg10;
    totalLatency += latencyMs;
    if (results.length === 0) emptyCount++;

    perQuery.push({
      queryId: q.id,
      query: q.query,
      retrievedIds,
      recallAt5: Number(r5.toFixed(4)),
      recallAt10: Number(r10.toFixed(4)),
      mrrAt10: Number(mrr.toFixed(4)),
      ndcgAt10: Number(ndcg10.toFixed(4)),
      latencyMs,
    });
  }

  const n = queries.length;
  return {
    method,
    totalQueries: n,
    recallAt5: Number((totalRecall5 / n).toFixed(4)),
    recallAt10: Number((totalRecall10 / n).toFixed(4)),
    mrrAt10: Number((totalMRR10 / n).toFixed(4)),
    ndcgAt10: Number((totalNDCG10 / n).toFixed(4)),
    emptyResults: emptyCount,
    avgLatencyMs: n > 0 ? Number((totalLatency / n).toFixed(2)) : 0,
    perQuery,
  };
}

async function main() {
  console.log('=== CiteRail Retrieval Evaluation ===');
  console.log('');

  // Provider availability: an initialization failure is caught so that the
  // report explicitly marks the SEMANTIC evaluation as not performed instead
  // of crashing.
  let provider: Awaited<ReturnType<typeof getEmbeddingProvider>> = null;
  try {
    provider = await getEmbeddingProvider();
  } catch (err) {
    console.error(
      'Embedding provider initialization failed:',
      err instanceof Error ? err.message : String(err)
    );
    provider = null;
  }
  const hasEmbeddings = provider !== null;
  console.log(
    `Embedding provider: ${
      provider ? `${provider.providerId} (model ${provider.modelId}, digest ${provider.modelDigest})` : 'none (FTS-only)'
    }`
  );
  console.log('');

  const dataset = loadEvaluationDataset();
  console.log(
    `Evaluation dataset: ${
      process.env.RETRIEVAL_EVAL_DATASET
        ? `operator-supplied (${process.env.RETRIEVAL_EVAL_DATASET.trim()})`
        : 'none supplied'
    }`
  );

  // Labelled chunk IDs must actually exist in the corpus being evaluated.
  const corpusRes = await query<{ id: string }>('SELECT id FROM document_chunks');
  const corpusChunkIds = new Set(corpusRes.rows.map((r) => r.id));

  const validation = validateEvaluationDataset(dataset, corpusChunkIds);
  if (!validation.valid) {
    console.log('');
    console.log(renderNotEvaluated(validation.problems));
    console.log('');
    await pool.end();
    return;
  }

  console.log(`Labelled queries: ${validation.labelledQueryCount}`);
  console.log('');

  // Run FTS-only evaluation.
  console.log('Running FTS-only evaluation...');
  const ftsResult = await evaluateMethod('FTS-only', dataset, true, false);

  // Run semantic-only evaluation only when a provider is actually available.
  let semanticResult: EvalResult | null = null;
  if (hasEmbeddings) {
    console.log('Running semantic-only evaluation...');
    semanticResult = await evaluateMethod('Semantic-only', dataset, false, true);
  } else {
    console.log(
      'Semantic evaluation was NOT performed: no embedding provider is configured or available.'
    );
  }

  // Hybrid evaluation uses the same corpus and the same labels as every other
  // run above, so the comparison is like-for-like.
  console.log('Running hybrid evaluation...');
  const hybridResult = await evaluateMethod('Hybrid (FTS + semantic)', dataset, false, false);

  console.log('');
  console.log('=== Evaluation Results ===');
  console.log('');

  const printResult = (r: EvalResult) => {
    console.log(`Method: ${r.method}`);
    console.log(`  Queries: ${r.totalQueries}`);
    console.log(`  Recall@5:  ${r.recallAt5}`);
    console.log(`  Recall@10: ${r.recallAt10}`);
    console.log(`  MRR@10:    ${r.mrrAt10}`);
    console.log(`  nDCG@10:   ${r.ndcgAt10}`);
    console.log(`  Empty:     ${r.emptyResults}`);
    console.log(`  Avg Latency: ${r.avgLatencyMs} ms`);
    console.log('');
  };

  printResult(ftsResult);
  if (semanticResult) printResult(semanticResult);
  printResult(hybridResult);

  // Comparison summary — only ever stated when a semantic run actually took
  // place and the labels stayed identical across methods.
  console.log('=== Comparison Summary ===');
  if (semanticResult) {
    const hybridVsFtsRecall5 = hybridResult.recallAt5 - ftsResult.recallAt5;
    const hybridVsFtsMRR = hybridResult.mrrAt10 - ftsResult.mrrAt10;
    console.log(
      `Hybrid vs FTS Recall@5 delta: ${hybridVsFtsRecall5 > 0 ? '+' : ''}${hybridVsFtsRecall5}`
    );
    console.log(
      `Hybrid vs FTS MRR@10 delta: ${hybridVsFtsMRR > 0 ? '+' : ''}${hybridVsFtsMRR}`
    );
    if (hybridVsFtsRecall5 > 0 || hybridVsFtsMRR > 0) {
      console.log('Hybrid retrieval shows improvement on this evaluation set.');
    } else {
      console.log(
        'Hybrid retrieval does not show measured improvement on this evaluation set.'
      );
    }
  } else {
    console.log(
      'Hybrid comparison NOT made: semantic evaluation was not performed (no embedding provider).'
    );
  }

  console.log('');
  console.log('Per-query details (latency recorded separately from quality):');
  for (const entry of hybridResult.perQuery) {
    console.log(
      `  ${entry.queryId} "${entry.query}": R@5=${entry.recallAt5} R@10=${entry.recallAt10} MRR@10=${entry.mrrAt10} nDCG@10=${entry.ndcgAt10} lat=${entry.latencyMs}ms`
    );
  }

  await pool.end();
}

// Only run main when executed directly (not when imported by tests).
const isMainModule =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMainModule) {
  main().catch((err) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
  });
}
