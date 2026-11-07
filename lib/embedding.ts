/**
 * Provider-independent embedding interface for CiteRail semantic retrieval.
 *
 * This module is intentionally separate from the existing AI answer-generation
 * provider (lib/ai/provider.ts). Embeddings are used only for retrieval
 * candidate ranking; no publisher source text is sent to any external provider
 * by default.
 */

import { config } from './config';

/**
 * Result of embedding a single text.
 */
export interface EmbeddingResult {
  /** The embedding vector. */
  vector: number[];
  /** The model identifier actually used. */
  modelId: string;
  /** The model digest/fingerprint when available from the provider. */
  modelDigest?: string;
  /** Provider identifier (e.g. "ollama"). */
  provider: string;
}

/**
 * Abstract embedding provider. Implementations must be deterministic for the
 * same input text so that re-embedding a chunk produces the same vector.
 */
export interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;

  /**
   * Embed multiple texts in a single batch request when the provider supports
   * it. Returns one vector per input text in the same order.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;

  /**
   * Embed a single query text. The format must be consistent with
   * embedDocuments so that query and document vectors live in the same space.
   */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Validation error thrown when an embedding response is malformed.
 */
export class EmbeddingProviderError extends Error {
  code: string;
  constructor(message: string, code: string = 'EMBEDDING_PROVIDER_ERROR') {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.code = code;
  }
}

/**
 * Validates a single embedding vector.
 *
 * - Length must match expected dimensions.
 * - Every element must be a finite number (no NaN or Infinity).
 */
function validateVector(
  vector: unknown,
  expectedDimensions: number,
  context: string
): number[] {
  if (!Array.isArray(vector)) {
    throw new EmbeddingProviderError(
      `${context}: embedding vector is not an array`,
      'INVALID_VECTOR_STRUCTURE'
    );
  }
  if (vector.length !== expectedDimensions) {
    throw new EmbeddingProviderError(
      `${context}: expected ${expectedDimensions} dimensions, got ${vector.length}`,
      'INVALID_VECTOR_DIMENSIONS'
    );
  }
  const result: number[] = [];
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EmbeddingProviderError(
        `${context}: element ${i} is not a finite number: ${String(value)}`,
        'INVALID_VECTOR_VALUE'
      );
    }
    result.push(value);
  }
  return result;
}

/**
 * Ollama embedding provider using the `/api/embed` endpoint.
 *
 * Ollama's `/api/embed` accepts `{"model": "...", "input": ["text1", ...]}`
 * and returns `{"embeddings": [[...], ...]}`. No document/query instruction
 * prefix is required for embeddinggemma; the same format is used for both
 * documents and queries so they share the same vector space.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'ollama';
  readonly modelId: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  private static readonly MAX_BATCH_SIZE = 64;
  private static readonly MAX_CONCURRENT = 4;

  constructor(baseUrl: string, modelId: string, dimensions: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  /**
   * Calls Ollama `/api/embed` with bounded concurrency and retries.
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    const concurrency = OllamaEmbeddingProvider.MAX_CONCURRENT;

    // Process in bounded batches to avoid unbounded concurrent requests.
    for (let i = 0; i < texts.length; i += OllamaEmbeddingProvider.MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + OllamaEmbeddingProvider.MAX_BATCH_SIZE);
      const batchVectors = await this.embedBatchWithRetry(batch);
      results.push(...batchVectors);
    }

    return results;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    const maxRetries = 3;
    const baseDelayMs = 500;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.embedBatchOnce(texts);
      } catch (err: any) {
        if (attempt === maxRetries) throw err;
        // Only retry on transient/connection errors, not on validation errors.
        if (
          err instanceof EmbeddingProviderError &&
          (err.code === 'MODEL_NOT_FOUND' ||
            err.code === 'INVALID_VECTOR_STRUCTURE' ||
            err.code === 'INVALID_VECTOR_DIMENSIONS' ||
            err.code === 'INVALID_VECTOR_VALUE')
        ) {
          throw err;
        }
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new EmbeddingProviderError(
      'Ollama embedding batch failed after retries',
      'EMBEDDING_BATCH_FAILED'
    );
  }

  private async embedBatchOnce(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.aiRequestTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          input: texts,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 404 || errorText.includes('model not found')) {
          throw new EmbeddingProviderError(
            `Ollama model not found: ${this.modelId}`,
            'MODEL_NOT_FOUND'
          );
        }
        throw new EmbeddingProviderError(
          `Ollama embed request failed with status ${response.status}: ${errorText}`,
          'OLLAMA_REQUEST_FAILED'
        );
      }

      const body = (await response.json()) as any;
      if (!body || !Array.isArray(body.embeddings)) {
        throw new EmbeddingProviderError(
          'Ollama embed response missing embeddings array',
          'INVALID_RESPONSE_STRUCTURE'
        );
      }

      if (body.embeddings.length !== texts.length) {
        throw new EmbeddingProviderError(
          `Ollama returned ${body.embeddings.length} embeddings for ${texts.length} inputs`,
          'INVALID_VECTOR_COUNT'
        );
      }

      const vectors: number[][] = [];
      for (let i = 0; i < body.embeddings.length; i++) {
        vectors.push(
          validateVector(
            body.embeddings[i],
            this.dimensions,
            `Ollama embedding ${i}`
          )
        );
      }

      return vectors;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new EmbeddingProviderError(
          `Ollama embed request timed out after ${config.aiRequestTimeoutMs}ms`,
          'EMBEDDING_TIMEOUT'
        );
      }
      throw err;
    }
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Filter out empty strings but preserve positions for consistent indexing.
    const nonEmptyTexts = texts.filter((t) => t.trim().length > 0);
    if (nonEmptyTexts.length === 0) return [];
    return this.embedBatch(nonEmptyTexts);
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new EmbeddingProviderError(
        'Query text is empty',
        'EMPTY_QUERY_TEXT'
      );
    }
    const vectors = await this.embedBatch([text]);
    return vectors[0];
  }
}

/**
 * Factory for creating the configured embedding provider.
 *
 * Reads EMBEDDING_PROVIDER (default "ollama") and related env vars.
 * Returns null when no embedding provider is configured, in which case
 * retrieval falls back to full-text search only.
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
  const provider = (process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase();

  if (provider !== 'ollama') {
    console.warn(
      `[embedding] Unknown embedding provider "${provider}"; falling back to FTS-only retrieval.`
    );
    return null;
  }

  const baseUrl = process.env.OLLAMA_EMBEDDING_BASE_URL || config.ollamaBaseUrl;
  const modelId = process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma';
  const dimensions = Number.parseInt(
    process.env.EMBEDDING_DIMENSIONS || '768',
    10
  );

  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be a positive integer, received "${process.env.EMBEDDING_DIMENSIONS}"`
    );
  }

  console.info(
    `[embedding] Using Ollama provider: baseUrl=${baseUrl} model=${modelId} dimensions=${dimensions}`
  );
  return new OllamaEmbeddingProvider(baseUrl, modelId, dimensions);
}

/**
 * Singleton provider instance. Lazily initialized.
 */
let embeddingProviderInstance: EmbeddingProvider | null | undefined = undefined;

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingProviderInstance === undefined) {
    embeddingProviderInstance = createEmbeddingProvider();
  }
  return embeddingProviderInstance;
}