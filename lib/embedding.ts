/**
 * Provider-independent embedding interface for CiteRail semantic retrieval.
 *
 * This module is intentionally separate from the existing AI answer-generation
 * provider (lib/ai/provider.ts). Embeddings are used only for retrieval
 * candidate ranking; no publisher source text is sent to any external provider
 * by default.
 *
 * Model identity: every provider instance exposes a validated, immutable
 * model digest. The digest is resolved from the provider itself (for Ollama,
 * the digest of the exact configured model from GET /api/tags) and is bound
 * to the provider instance for its whole lifetime. Embedding writes and
 * semantic retrieval always use the same provider/model/digest identity, so a
 * model update can never silently make old vectors appear to belong to the
 * new model. When a genuine fingerprint cannot be established, provider
 * resolution fails closed and retrieval stays on full-text search.
 */

import { config } from './config';

/**
 * Normalized digest prefix. Every stored digest is normalized to this form so
 * provider quirks (sha256- vs sha256- vs bare hex) cannot create phantom
 * model versions.
 */
export const DIGEST_PREFIX = 'sha256:';

/**
 * Result of embedding a single text.
 */
export interface EmbeddingResult {
  /** The embedding vector. */
  vector: number[];
  /** The model identifier actually used. */
  modelId: string;
  /** The validated immutable model digest actually used. */
  modelDigest: string;
  /** Provider identifier (e.g. "ollama"). */
  provider: string;
}

/**
 * Abstract embedding provider. Implementations must be deterministic for the
 * same input text so that re-embedding a chunk produces the same vector.
 *
 * Every instance must be constructed with a verified model digest: an
 * EmbeddingProvider without a genuine, validated fingerprint refuses to
 * exist. Callers therefore cannot accidentally index into an unidentified
 * model version.
 */
export interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  /** Validated immutable model fingerprint (normalized to `sha256:<hex64>`). */
  readonly modelDigest: string;

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
 * Validation error thrown when an embedding response is malformed or the
 * model identity cannot be verified.
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

const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Normalizes a provider-reported model digest to `sha256:<64 lowercase hex>`.
 *
 * Accepted input forms (Ollama has used each of these shape across versions):
 *   - "sha256:<hex64>"
 *   - "sha256-<hex64>"
 *   - "<hex64>"
 *
 * Anything else (missing, empty, wrong length, non-hex, opaque identifiers)
 * is rejected: a fabricated or mutable alias is never a valid model identity.
 */
export function normalizeModelDigest(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new EmbeddingProviderError(
      'Model digest is missing from the provider response',
      'MODEL_DIGEST_MALFORMED'
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EmbeddingProviderError(
      'Model digest is empty',
      'MODEL_DIGEST_MALFORMED'
    );
  }
  let hex: string;
  if (trimmed.startsWith('sha256:')) {
    hex = trimmed.slice('sha256:'.length);
  } else if (trimmed.startsWith('sha256-')) {
    hex = trimmed.slice('sha256-'.length);
  } else {
    hex = trimmed;
  }
  hex = hex.toLowerCase();
  if (!HEX_64_RE.test(hex)) {
    throw new EmbeddingProviderError(
      `Model digest "${raw}" is not a valid sha256 fingerprint (64 hex characters required)`,
      'MODEL_DIGEST_MALFORMED'
    );
  }
  return `${'sha256:' + hex}`;
}

/**
 * Resolves the digest of the exact configured model from Ollama's
 * `GET /api/tags` endpoint.
 *
 * Matching rules (precise, no guessing):
 *   - A configured model WITH a tag (e.g. "embeddinggemma:q8") must match an
 *     entry name exactly; otherwise the model is not found.
 *   - A configured model WITHOUT a tag (e.g. "embeddinggemma") resolves the
 *     same way Ollama resolves it: to "<name>:latest" when that tag exists
 *     exactly once and no other "<name>:*" tag is present.
 *   - Multiple "<name>:*" tags without an exact name match are ambiguous and
 *     rejected rather than guessed.
 *
 * Errors (all fail closed):
 *   - MODEL_DIGEST_UNAVAILABLE: endpoint unreachable or non-2xx response.
 *   - MODEL_NOT_FOUND: configured model name does not match any entry.
 *   - MODEL_DIGEST_MALFORMED: response shape invalid or digest not sha256.
 *   - MODEL_AMBIGUOUS: untagged model name is ambiguous among known tags.
 *
 * `fetchImpl` can be injected for tests; defaults to the global fetch.
 */
export async function resolveOllamaModelDigest(
  baseUrl: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 10_000
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let bodyText: string;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    bodyText = await response.text();
  } catch (err) {
    if (timedOut || (err as any)?.name === 'AbortError') {
      throw new EmbeddingProviderError(
        `Resolving model digest timed out after ${timeoutMs}ms`,
        'MODEL_DIGEST_UNAVAILABLE'
      );
    }
    throw new EmbeddingProviderError(
      `Resolving model digest failed: ${err instanceof Error ? err.message : String(err)}`,
      'MODEL_DIGEST_UNAVAILABLE'
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new EmbeddingProviderError(
      `Model digest lookup failed with status ${response.status}`,
      'MODEL_DIGEST_UNAVAILABLE'
    );
  }

  let tagsBody: any;
  try {
    tagsBody = JSON.parse(bodyText);
  } catch {
    throw new EmbeddingProviderError(
      'Model digest lookup response is not valid JSON',
      'MODEL_DIGEST_MALFORMED'
    );
  }
  if (!tagsBody || !Array.isArray(tagsBody.models)) {
    throw new EmbeddingProviderError(
      'Model digest lookup response is missing a models array',
      'MODEL_DIGEST_MALFORMED'
    );
  }

  type TagEntry = { name: string; digest: string };
  const entries: TagEntry[] = [];
  for (const m of tagsBody.models) {
    if (!m || typeof m.name !== 'string' || !m.name.trim()) {
      throw new EmbeddingProviderError(
        'Model digest lookup response contains a model entry without a name',
        'MODEL_DIGEST_MALFORMED'
      );
    }
    if (m.digest === undefined || m.digest === null) {
      throw new EmbeddingProviderError(
        `Model "${m.name}" is listed without a digest`,
        'MODEL_DIGEST_MALFORMED'
      );
    }
    // normalizeModelDigest throws MODEL_DIGEST_MALFORMED when malformed.
    entries.push({
      name: m.name,
      digest: normalizeModelDigest(m.digest),
    });
  }

  const exact = entries.find((e) => e.name === modelId);
  if (exact) return exact.digest;

  const colonIndex = modelId.indexOf(':');
  if (colonIndex !== -1) {
    throw new EmbeddingProviderError(
      `Configured embedding model "${modelId}" is not available on the endpoint`,
      'MODEL_NOT_FOUND'
    );
  }

  const prefixed = `${modelId}:`;
  const candidates = entries.filter((e) => e.name.startsWith(prefixed));
  if (candidates.length === 0) {
    throw new EmbeddingProviderError(
      `Configured embedding model "${modelId}" is not available on the endpoint`,
      'MODEL_NOT_FOUND'
    );
  }
  const latest = candidates.find((e) => e.name === `${modelId}:latest`);
  if (candidates.length > 1 || !latest) {
    throw new EmbeddingProviderError(
      `Configured embedding model "${modelId}" is ambiguous across tags (${candidates
        .map((c) => c.name)
        .join(', ')}); configure the exact tag.`,
      'MODEL_AMBIGUOUS'
    );
  }
  return latest.digest;
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
  /** Validated immutable model fingerprint bound at construction time. */
  readonly modelDigest: string;

  private readonly baseUrl: string;

  private static readonly MAX_BATCH_SIZE = 64;
  private static readonly HEX_DIGEST_RE = /^[0-9a-f]{64}$/;

  constructor(
    baseUrl: string,
    modelId: string,
    dimensions: number,
    modelDigest: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.modelId = modelId;
    this.dimensions = dimensions;
    let normalized: string;
    if (typeof modelDigest !== 'string' || !modelDigest.trim()) {
      throw new EmbeddingProviderError(
        'Embedding provider construction refused: model digest is empty',
        'MODEL_DIGEST_MALFORMED'
      );
    }
    try {
      normalized = normalizeModelDigest(modelDigest);
    } catch (err) {
      throw new EmbeddingProviderError(
        `Embedding provider construction refused: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'MODEL_DIGEST_MALFORMED'
      );
    }
    // Double-check the normalization produced a genuine sha256 fingerprint.
    const hex = normalized.slice(DIGEST_PREFIX.length);
    if (!OllamaEmbeddingProvider.HEX_DIGEST_RE.test(hex)) {
      throw new EmbeddingProviderError(
        'Embedding provider construction refused: normalized digest is not sha256 hex',
        'MODEL_DIGEST_MALFORMED'
      );
    }
    this.modelDigest = normalized;
  }

  /**
   * Revalidates the configured model identity immediately before an embedding
   * batch by re-resolving the digest from Ollama `/api/tags`.
   *
   * Ollama's `/api/embed` accepts a model name, not an immutable digest, so a
   * model tag rotation can change the underlying model between the provider's
   * construction and a later embedding batch. Revalidating here prevents
   * vectors from being written or read under a stale digest: if the resolved
   * digest differs from the bound `modelDigest`, we fail closed with
   * `MODEL_IDENTITY_CHANGED` rather than attributing embeddings to the wrong
   * model version.
   *
   * Network/lookup failures surface as `MODEL_DIGEST_UNAVAILABLE` and are not
   * cached, consistent with `getEmbeddingProvider`.
   */
  async revalidateModelDigest(fetchImpl: typeof fetch = fetch): Promise<void> {
    const fresh = await resolveOllamaModelDigest(
      this.baseUrl,
      this.modelId,
      fetchImpl
    );
    if (fresh !== this.modelDigest) {
      throw new EmbeddingProviderError(
        `Model identity changed for "${this.modelId}": recorded digest ` +
          `${this.modelDigest}, endpoint now reports ${fresh}. ` +
          'Refusing to embed under a drifted model identity.',
        'MODEL_IDENTITY_CHANGED'
      );
    }
  }

  /**
   * Calls Ollama `/api/embed` with bounded batching and retries.
   * Batches are processed sequentially to preserve result ordering.
   *
   * Model identity is revalidated before AND after every individual
   * inference request inside `embedBatchOnce`, so a tag rotation between
   * requests (or between retries) is always detected before vectors are
   * returned.
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Process in bounded batches sequentially to preserve result ordering.
    // No concurrent requests: ordering guarantees and avoids unbounded parallelism.
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
        // Only retry on transient/connectivity failures. Permanent
        // configuration, identity, and validation errors are never retried.
        if (
          err instanceof EmbeddingProviderError &&
          (err.code === 'MODEL_NOT_FOUND' ||
            err.code === 'MODEL_IDENTITY_CHANGED' ||
            err.code === 'INVALID_VECTOR_STRUCTURE' ||
            err.code === 'INVALID_VECTOR_DIMENSIONS' ||
            err.code === 'INVALID_VECTOR_VALUE' ||
            err.code === 'INVALID_VECTOR_COUNT' ||
            err.code === 'INVALID_RESPONSE_STRUCTURE')
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

  /**
   * Single-request embedding call with ONE clean timeout lifecycle:
   *
   * - A single AbortController timer covers connecting, response headers,
   *   body reading, and JSON parsing.
   * - The abort signal terminates the in-flight body when a response stalls.
   * - The timer is always cleared in the finally path: no orphaned timeout
   *   promises and no leaked timers after success, failure, or timeout.
   * - Invalid JSON and wrong vector counts stay explicit validation errors,
   *   never reclassified as timeouts.
   */
  private async embedBatchOnce(texts: string[]): Promise<number[][]> {
    // Pre-request identity validation: confirm the model digest has not
    // drifted before issuing this inference request.
    await this.revalidateModelDigest();

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.aiRequestTimeoutMs);

    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          input: texts,
        }),
        signal: controller.signal,
      });
      // Body reading happens while the timeout is still live; a stalled
      // response body is aborted (and treated as a timeout) by the controller.
      bodyText = await response.text();
    } catch (err: any) {
      if (timedOut || err?.name === 'AbortError') {
        throw new EmbeddingProviderError(
          `Ollama embed request timed out after ${config.aiRequestTimeoutMs}ms`,
          'EMBEDDING_TIMEOUT'
        );
      }
      throw new EmbeddingProviderError(
        `Ollama embed request failed: ${err instanceof Error ? err.message : String(err)}`,
        'OLLAMA_REQUEST_FAILED'
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 404 || bodyText.includes('model not found')) {
        throw new EmbeddingProviderError(
          `Ollama model not found: ${this.modelId}`,
          'MODEL_NOT_FOUND'
        );
      }
      throw new EmbeddingProviderError(
        `Ollama embed request failed with status ${response.status}: ${bodyText}`,
        'OLLAMA_REQUEST_FAILED'
      );
    }

    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new EmbeddingProviderError(
        'Ollama embed response is not valid JSON',
        'INVALID_RESPONSE_STRUCTURE'
      );
    }

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

    // Post-response identity validation: confirm the model digest is still
    // unchanged after the inference response. This catches tag rotation that
    // occurred between the pre-request check and the response.
    await this.revalidateModelDigest();

    return vectors;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    // Preserve exact positional mapping: one vector per input, same order.
    // Reject empty-string input explicitly rather than silently dropping it.
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i] || !texts[i].trim()) {
        throw new EmbeddingProviderError(
          `embedDocuments: input at index ${i} is empty or whitespace-only`,
          'EMPTY_INPUT_TEXT'
        );
      }
    }
    if (texts.length === 0) return [];
    return this.embedBatch(texts);
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
 * Creates an Ollama provider whose model identity has been verified against
 * the endpoint's own /api/tags listing. Refuses to construct anything when
 * the digest cannot be verified.
 *
 * `fetchImpl` can be injected for tests; defaults to the global fetch.
 */
export async function createOllamaEmbeddingProvider(
  baseUrl: string,
  modelId: string,
  dimensions: number,
  fetchImpl: typeof fetch = fetch
): Promise<OllamaEmbeddingProvider> {
  const digest = await resolveOllamaModelDigest(baseUrl, modelId, fetchImpl);
  return new OllamaEmbeddingProvider(baseUrl, modelId, dimensions, digest);
}

/**
 * Factory for creating the configured embedding provider.
 *
 * Reads EMBEDDING_PROVIDER (default "ollama") and related env vars.
 * Returns null for deliberately disabled/unknown provider selections.
 * Throws an EmbeddingProviderError when an ollama configuration is present
 * but the model identity cannot be verified (fail closed). Callers in
 * retrieval/ingestion catch that error, report it accurately, and keep
 * full-text search fully operational.
 *
 * A fetchImpl can be injected for tests; defaults to the global fetch.
 */
export async function resolveEmbeddingProvider(
  fetchImpl?: typeof fetch
): Promise<EmbeddingProvider | null> {
  const provider = config.embeddingProvider.toLowerCase();

  if (provider === 'none') {
    console.info(
      '[embedding] Embedding provider disabled (EMBEDDING_PROVIDER=none); FTS-only retrieval active.'
    );
    return null;
  }

  if (provider !== 'ollama') {
    console.warn(
      `[embedding] Unknown embedding provider "${provider}"; falling back to FTS-only retrieval.`
    );
    return null;
  }

  // Use the dedicated embedding base URL. Never fall back to the answer-generation
  // OLLAMA_BASE_URL, which could point to an external endpoint unsuitable for
  // publisher content.
  const baseUrl = config.ollamaEmbeddingBaseUrl;
  const modelId = config.ollamaEmbeddingModel;
  const dimensions = config.embeddingDimensions;

  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new EmbeddingProviderError(
      `EMBEDDING_DIMENSIONS must be a positive integer, received "${config.embeddingDimensions}"`,
      'INVALID_EMBEDDING_CONFIG'
    );
  }

  console.info(
    `[embedding] Using Ollama provider: baseUrl=${baseUrl} model=${modelId} dimensions=${dimensions}`
  );
  return createOllamaEmbeddingProvider(baseUrl, modelId, dimensions, fetchImpl ?? fetch);
}

/**
 * Singleton provider state.
 *
 * `resolvedProvider` caches only settled results (provider instance or null).
 * A rejected resolution is NOT cached: the next caller retries resolution,
 * which keeps a temporarily unavailable endpoint from permanently disabling
 * semantic retrieval for the process lifetime.
 */
let resolvedProvider: EmbeddingProvider | null | undefined = undefined;
let pendingResolution: Promise<EmbeddingProvider | null> | undefined = undefined;

/**
 * Test-only dependency injection. When set to a function it replaces provider
 * resolution entirely (may return a provider, null, or throw, e.g. to
 * simulate an initialization failure without any network access). Set to
 * undefined to restore normal resolution.
 */
let providerOverrideFn: (() => EmbeddingProvider | null | Promise<EmbeddingProvider | null>) | undefined =
  undefined;

export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (providerOverrideFn) {
    return providerOverrideFn();
  }
  if (resolvedProvider !== undefined) {
    return resolvedProvider;
  }
  if (!pendingResolution) {
    pendingResolution = resolveEmbeddingProvider();
  }
  try {
    const provider = await pendingResolution;
    resolvedProvider = provider;
    return provider;
  } catch (err) {
    // Explicit initialization failure. Clear the cached rejection so the next
    // caller retries rather than being stuck on a stale failure.
    pendingResolution = undefined;
    throw err;
  }
}

/**
 * Resets the singleton provider instance and cache. Used by tests to simulate
 * different configurations without relying on environment variable ordering.
 */
export function resetEmbeddingProvider(): void {
  resolvedProvider = undefined;
  pendingResolution = undefined;
  providerOverrideFn = undefined;
}

/**
 * Sets a test-only provider override without dropping the whole reset
 * contract. Calling with `null` restores normal resolution behavior.
 */
export function setEmbeddingProviderOverride(
  fn: (() => EmbeddingProvider | null | Promise<EmbeddingProvider | null>) | null
): void {
  providerOverrideFn = fn ?? undefined;
}
