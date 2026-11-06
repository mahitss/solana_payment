/**
 * Centralized environment configuration.
 *
 * Every value is resolved lazily so that a missing variable produces a clear,
 * actionable error at the point of use instead of an opaque module-load crash
 * (which would also break `next build` in a clean environment).
 */

import crypto from 'crypto';

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `See .env.example for the full set of supported variables.`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received "${raw}".`);
  }
  return parsed;
}

/**
 * Secret used to sign session tokens.
 *
 * In production this MUST be supplied explicitly. In development we derive an
 * ephemeral per-process secret so the app is usable out of the box, while
 * making it obvious that sessions do not survive a restart.
 */
let cachedAuthSecret: string | null = null;
export function getAuthSecret(): string {
  if (cachedAuthSecret) return cachedAuthSecret;

  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('AUTH_SECRET must be at least 32 characters long.');
    }
    cachedAuthSecret = fromEnv;
    return cachedAuthSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET is required in production. Generate one with: openssl rand -hex 32'
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    '[config] AUTH_SECRET not set - using an ephemeral development secret. ' +
      'Sessions will be invalidated on restart. Set AUTH_SECRET before deploying.'
  );
  cachedAuthSecret = crypto.randomBytes(32).toString('hex');
  return cachedAuthSecret;
}

export const config = {
  /** Postgres connection string. */
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },

  /** Solana RPC endpoint used server-side for verification. */
  get solanaRpcUrl(): string {
    return optional('NEXT_PUBLIC_SOLANA_RPC_URL', 'https://api.devnet.solana.com');
  },

  /** Solana cluster name, used for explorer links. */
  get solanaNetwork(): string {
    return optional('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
  },

  /** SPL mint address for the settlement asset (USDC on devnet). */
  get usdcMint(): string {
    return optional(
      'NEXT_PUBLIC_USDC_MINT',
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    );
  },

  /** Memo program used to bind a payment to its quote. */
  get memoProgramId(): string {
    return optional(
      'NEXT_PUBLIC_MEMO_PROGRAM_ID',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
    );
  },

  /** Quote validity window in seconds. */
  get quoteExpirySeconds(): number {
    return integer('QUOTE_EXPIRY_SECONDS', 300);
  },

  /** Maximum accepted upload size in bytes. */
  get maxUploadBytes(): number {
    return integer('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);
  },

  /** Maximum query length accepted by the quote endpoint. */
  get maxQueryLength(): number {
    return integer('MAX_QUERY_LENGTH', 2000);
  },

  /** Ollama base URL for the local inference provider. */
  get ollamaBaseUrl(): string {
    return optional('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
  },

  /** Ollama model name. */
  get ollamaModel(): string {
    return optional('OLLAMA_MODEL', 'gemma3:4b');
  },

  /** Gemini API key. Empty means the provider is unavailable. */
  get geminiApiKey(): string {
    return optional('GEMINI_API_KEY', '');
  },

  /** Gemini model name. */
  get geminiModel(): string {
    return optional('GEMINI_MODEL', 'gemini-2.0-flash');
  },

  /** Request timeout for outbound AI provider calls, in milliseconds. */
  get aiRequestTimeoutMs(): number {
    return integer('AI_REQUEST_TIMEOUT_MS', 60_000);
  },

  /** Session token lifetime in seconds. */
  get sessionTtlSeconds(): number {
    return integer('SESSION_TTL_SECONDS', 60 * 60 * 12);
  },

  /** Auth challenge lifetime in seconds. */
  get challengeTtlSeconds(): number {
    return integer('AUTH_CHALLENGE_TTL_SECONDS', 300);
  },
};

export type Config = typeof config;
