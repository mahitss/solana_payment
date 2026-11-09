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
import { searchWithDiagnostics, type RetrievalDiagnostics } from '../lib/retrieval';
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
  /**
   * Retrieval-method execution diagnostics. Distinguishes which paths actually
   * ran so FTS fallback is never mislabelled as hybrid, and semantic metrics
   * are never claimed when semantic retrieval did not execute.
   */
  diagnostics: {
    label: string;
    semanticAvailable: boolean;
    semanticSkipped: boolean;
    /** Queries where semantic was expected but did not execute (fallback/unavailable). */
    semanticFailures: number;
    /** Queries where FTS was expected but failed. */
    ftsFailures: number;
    /** Queries that threw during retrieval. */
    queryFailures: number;
    /** True only when every query executed the intended paths without failure. */
    complete: boolean;
    modelDigest: string | null;
    ftsOnly: boolean;
    semanticOnly: boolean;
    /** Retrieval paths that actually produced results, derived from execution. */
    pathsUsed: string[];
  };
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
  semanticOnly: boolean,
  ctx: {
    hasEmbeddings: boolean;
    modelDigest: string | null;
  }
): Promise<EvalResult> {
  const perQuery: EvalResult['perQuery'] = [];
  let totalRecall5 = 0;
  let totalRecall10 = 0;
  let totalMRR10 = 0;
  let totalNDCG10 = 0;
  let emptyCount = 0;
  let totalLatency = 0;
  // Actual execution counts across all queries.
  let ftsFailures = 0;
  let semanticFailures = 0;
  let queryFailures = 0;
  // Actual paths used (derived from per-query diagnostics, not intended options).
  const actualPathsUsed = new Set<string>();

  const semanticAvailable = ctx.hasEmbeddings;
  const semanticSkipped = !semanticAvailable;

  for (const q of queries) {
    const relevantIds = new Set(q.relevantChunkIds);

    const start = Date.now();
    let results: any[];
    let diag: RetrievalDiagnostics | null = null;
    try {
      const out = await searchWithDiagnostics(q.query, {
        limit: 10,
        minTermCoverage: 0,
        ftsOnly,
        semanticOnly,
      });
      results = out.results;
      diag = out.diagnostics;
    } catch (err) {
      console.error(
        `Error running ${method} for query "${q.query}":`,
        err instanceof Error ? err.message : String(err)
      );
      results = [];
      queryFailures++;
    }
    const latencyMs = Date.now() - start;

    // Aggregate actual execution diagnostics.
    if (diag) {
      for (const p of diag.pathsUsed) actualPathsUsed.add(p);
      if (diag.ftsFailed) ftsFailures++;
      if (semanticOnly && !diag.semanticExecuted) {
        semanticFailures++;
      }
      if (!ftsOnly && !semanticOnly && !diag.semanticExecuted) {
        semanticFailures++;
      }
    }

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
  const pathsUsed = Array.from(actualPathsUsed);
  let label: string;
  if (ftsOnly) {
    label = ftsFailures === 0 && queryFailures === 0 ? 'FTS-only' : 'FTS-only — INCOMPLETE';
  } else if (semanticOnly) {
    label = semanticFailures === 0 && queryFailures === 0 ? 'Semantic-only' : 'Semantic-only — INCOMPLETE';
  } else if (semanticAvailable && ftsFailures === 0 && semanticFailures === 0 && queryFailures === 0) {
    label = 'Hybrid (FTS + semantic)';
  } else if (semanticAvailable) {
    label = 'Hybrid — INCOMPLETE';
  } else {
    label = 'NOT EVALUATED';
  }

  const complete =
    label === 'FTS-only' ||
    label === 'Semantic-only' ||
    label === 'Hybrid (FTS + semantic)';

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
    diagnostics: {
      label,
      semanticAvailable,
      semanticSkipped,
      semanticFailures,
      ftsFailures,
      queryFailures,
      complete,
      modelDigest: ctx.modelDigest,
      ftsOnly,
      semanticOnly,
      pathsUsed,
    },
  };
}

/**
 * Pure decision logic: are all three evaluation methods complete enough to
 * compare hybrid vs FTS? Returns true only when:
 *   - FTS-only is complete (no FTS or query failures),
 *   - semantic-only is complete (no semantic or query failures, or no provider),
 *   - hybrid is complete (no FTS/semantic/query failures AND both paths used).
 */
export function areEvaluationMethodsComparable(
  fts: EvalResult,
  semantic: EvalResult | null,
  hybrid: EvalResult
): boolean {
  const ftsComplete = fts.diagnostics.complete;
  const semanticComplete =
    semantic !== null && semantic.diagnostics.complete;
  const hybridComplete =
    hybrid.diagnostics.complete &&
    hybrid.diagnostics.pathsUsed.includes('fts') &&
    hybrid.diagnostics.pathsUsed.includes('semantic');
  return ftsComplete && semanticComplete && hybridComplete;
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
  const modelDigest = provider ? provider.modelDigest : null;
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
  const ftsResult = await evaluateMethod('FTS-only', dataset, true, false, {
    hasEmbeddings,
    modelDigest,
  });

  // Run semantic-only evaluation only when a provider is actually available.
  let semanticResult: EvalResult | null = null;
  if (hasEmbeddings) {
    console.log('Running semantic-only evaluation...');
    semanticResult = await evaluateMethod(
      'Semantic-only',
      dataset,
      false,
      true,
      { hasEmbeddings, modelDigest }
    );
  } else {
    console.log(
      'Semantic evaluation was NOT performed: no embedding provider is configured or available.'
    );
  }

  // Hybrid evaluation only runs when semantic retrieval is available. When no
  // embedding provider exists, retrieval silently degrades to FTS, so a hybrid
  // run would be an FTS-only result mislabelled as hybrid. Skip it and report
  // honestly instead.
  let hybridResult: EvalResult;
  if (hasEmbeddings) {
    console.log('Running hybrid evaluation...');
    hybridResult = await evaluateMethod('Hybrid (FTS + semantic)', dataset, false, false, {
      hasEmbeddings,
      modelDigest,
    });
  } else {
    console.log(
      'Hybrid evaluation was NOT performed: no embedding provider is configured or available.'
    );
    hybridResult = {
      method: 'Hybrid (FTS + semantic)',
      totalQueries: validation.labelledQueryCount,
      recallAt5: 0,
      recallAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      emptyResults: validation.labelledQueryCount,
      avgLatencyMs: 0,
      perQuery: dataset.map((q) => ({
        queryId: q.id,
        query: q.query,
        retrievedIds: [],
        recallAt5: 0,
        recallAt10: 0,
        mrrAt10: 0,
        ndcgAt10: 0,
        latencyMs: 0,
      })),
      diagnostics: {
        label: 'Hybrid — skipped (semantic unavailable)',
        semanticAvailable: false,
        semanticSkipped: true,
        semanticFailures: validation.labelledQueryCount,
        ftsFailures: 0,
        queryFailures: 0,
        complete: false,
        modelDigest: null,
        ftsOnly: false,
        semanticOnly: false,
        pathsUsed: [],
      },
    };
  }

  console.log('');
  console.log('=== Evaluation Results ===');
  console.log('');

  const printResult = (r: EvalResult) => {
    const d = r.diagnostics;
    console.log(`Method: ${r.method}`);
    console.log(`  Label: ${d.label}`);
    console.log(`  Queries: ${r.totalQueries}`);
    console.log(`  Paths used: ${d.pathsUsed.join(', ') || '(none)'}`);
    console.log(`  Semantic available: ${d.semanticAvailable}`);
    console.log(`  Semantic skipped: ${d.semanticSkipped}`);
    console.log(`  Semantic failures: ${d.semanticFailures}`);
    console.log(`  FTS failures: ${d.ftsFailures}`);
    console.log(`  Query failures: ${d.queryFailures}`);
    console.log(`  Complete: ${d.complete}`);
    if (d.modelDigest) {
      console.log(`  Model digest: ${d.modelDigest}`);
    }
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

  // Comparison summary — only ever stated when all three methods are complete:
  // FTS-only must be complete (valid baseline), semantic-only must be complete
  // (semantic path executed for every query), and hybrid must be complete
  // (both FTS and semantic executed for every query).
  console.log('=== Comparison Summary ===');
  const comparable = areEvaluationMethodsComparable(
    ftsResult,
    semanticResult,
    hybridResult
  );
  if (comparable) {
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
    const reasons: string[] = [];
    if (!ftsResult.diagnostics.complete) {
      reasons.push(
        `FTS baseline incomplete (${ftsResult.diagnostics.ftsFailures} FTS failure(s), ${ftsResult.diagnostics.queryFailures} query failure(s))`
      );
    }
    if (!semanticResult || !semanticResult.diagnostics.complete) {
      const semFailures = semanticResult
        ? semanticResult.diagnostics.semanticFailures
        : 'N/A (no provider)';
      reasons.push(
        `Semantic-only incomplete (${semFailures} semantic failure(s))`
      );
    }
    if (
      !hybridResult.diagnostics.complete ||
      !hybridResult.diagnostics.pathsUsed.includes('fts') ||
      !hybridResult.diagnostics.pathsUsed.includes('semantic')
    ) {
      reasons.push(
        `Hybrid incomplete (${hybridResult.diagnostics.ftsFailures} FTS failure(s), ${hybridResult.diagnostics.semanticFailures} semantic failure(s))`
      );
    }
    console.log(
      'Hybrid comparison NOT made: ' + reasons.join('; ') + '. No hybrid metrics are reported as successful.'
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
