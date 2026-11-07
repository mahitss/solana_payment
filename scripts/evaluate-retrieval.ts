/**
 * Retrieval evaluation framework for CiteRail.
 *
 * Compares three retrieval methods on a labelled evaluation dataset:
 *   1. Full-text search (FTS) only
 *   2. Semantic (vector) only
 *   3. Hybrid (FTS + semantic via RRF)
 *
 * Metrics: Recall@5, Recall@10, MRR@10, nDCG@10, empty-result count, latency.
 *
 * Usage:
 *   npx tsx scripts/evaluate-retrieval.ts
 *
 * Requires DATABASE_URL and an embedding provider for semantic/hybrid paths.
 */

import { query, pool } from '../lib/db';
import { searchKnowledgeCollections } from '../lib/retrieval';
import { getEmbeddingProvider } from '../lib/embedding';

interface EvalQuery {
  id: string;
  query: string;
  relevantChunkIds: string[];
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

// Default evaluation dataset: small, reproducible set of test queries.
// Each query has known relevant chunk IDs that must be populated by the
// operator before running meaningful evaluation.
const DEFAULT_QUERIES: EvalQuery[] = [
  {
    id: 'eval_001',
    query: 'Turbine block propagation protocol',
    relevantChunkIds: [],
  },
  {
    id: 'eval_002',
    query: 'Settlement verification payment',
    relevantChunkIds: [],
  },
  {
    id: 'eval_003',
    query: 'Document royalty allocation pricing',
    relevantChunkIds: [],
  },
];

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
    avgLatencyMs: Number((totalLatency / n).toFixed(2)),
    perQuery,
  };
}

async function main() {
  console.log('=== CiteRail Retrieval Evaluation ===');
  console.log('');

  const provider = getEmbeddingProvider();
  const hasEmbeddings = provider !== null;
  console.log(`Embedding provider: ${hasEmbeddings ? provider!.providerId : 'none (FTS-only)'}`);
  console.log(`Model: ${hasEmbeddings ? provider!.modelId : 'N/A'}`);
  console.log(`Dimensions: ${hasEmbeddings ? provider!.dimensions : 'N/A'}`);
  console.log('');

  // Check if evaluation dataset has relevant chunk IDs populated.
  const hasRelevantIds = DEFAULT_QUERIES.some((q) => q.relevantChunkIds.length > 0);
  if (!hasRelevantIds) {
    console.log(
      'NOTE: No relevant chunk IDs are defined in the evaluation dataset. ' +
        'Recall/MRR/nDCG metrics will be 0. Populate DEFAULT_QUERIES with ' +
        'known relevant chunk IDs before running meaningful evaluation.'
    );
    console.log('');
  }

  // Run FTS-only evaluation.
  console.log('Running FTS-only evaluation...');
  const ftsResult = await evaluateMethod('FTS-only', DEFAULT_QUERIES, true, false);

  // Run semantic-only evaluation (if provider available).
  let semanticResult: EvalResult | null = null;
  if (hasEmbeddings) {
    console.log('Running semantic-only evaluation...');
    semanticResult = await evaluateMethod('Semantic-only', DEFAULT_QUERIES, false, true);
  }

  // Run hybrid evaluation.
  console.log('Running hybrid evaluation...');
  const hybridResult = await evaluateMethod('Hybrid (FTS + semantic)', DEFAULT_QUERIES, false, false);

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

  // Comparison summary.
  console.log('=== Comparison Summary ===');
  if (semanticResult) {
    const hybridVsFtsRecall5 =
      hybridResult.recallAt5 - ftsResult.recallAt5;
    const hybridVsFtsMRR =
      hybridResult.mrrAt10 - ftsResult.mrrAt10;
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
    console.log('Semantic evaluation skipped (no embedding provider).');
  }

  console.log('');
  console.log('Per-query details:');
  for (const entry of hybridResult.perQuery) {
    console.log(
      `  ${entry.queryId} "${entry.query}": R@5=${entry.recallAt5} R@10=${entry.recallAt10} MRR@10=${entry.mrrAt10} nDCG@10=${entry.ndcgAt10} lat=${entry.latencyMs}ms`
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
