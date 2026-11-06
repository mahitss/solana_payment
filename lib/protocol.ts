import crypto from 'crypto';

/**
 * Protocol-level constants shared by the quote builder and the on-chain
 * verifier.
 *
 * The memo format used to be constructed in two places with two different
 * shapes (`CITERAIL:<id>:<digest>` in the implementation versus
 * `CITERAIL:QUOTE:<id>:<digest>` in the protocol documentation). Building it
 * from a single function here makes that class of drift impossible.
 */

/** The settlement asset. CiteRail settles exclusively in SPL USDC. */
export const SETTLEMENT_ASSET = 'USDC' as const;

/** USDC uses 6 decimals. */
export const USDC_DECIMALS = 6;

/** 1 USDC expressed in base units. */
export const USDC_BASE_UNIT = 10 ** USDC_DECIMALS;

/** Memo program prefix. */
export const MEMO_PREFIX = 'CITERAIL:QUOTE:';

/**
 * Builds the canonical memo payload that binds a payment transaction to a
 * quote and to the exact set of source chunks that were priced.
 *
 * Format: `CITERAIL:QUOTE:<quote_id>:<quote_nonce>:<source_digest>`
 *
 * The nonce contributes fresh entropy per quote, so the memo cannot be
 * replayed from a previously observed transaction even if a quote id were
 * somehow reused.
 */
export function buildMemoPayload(params: {
  quoteId: string;
  quoteNonce: string;
  sourceDigest: string;
}): string {
  return `${MEMO_PREFIX}${params.quoteId}:${params.quoteNonce}:${params.sourceDigest}`;
}

/**
 * Computes a stable digest over the exact chunk hashes that were priced.
 * The chunks are sorted by id first so the digest does not depend on the order
 * in which the retrieval layer happened to return them.
 */
export function computeSourceDigest(chunkHashes: string[]): string {
  const sorted = [...chunkHashes].sort();
  return crypto.createHash('sha256').update(sorted.join(':'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Converts a decimal USDC amount into integer base units.
 * All money in CiteRail is handled as integers to avoid floating-point drift.
 */
export function toBaseUnits(amountUsdc: number): number {
  if (!Number.isFinite(amountUsdc)) {
    throw new Error(`Invalid USDC amount: ${amountUsdc}`);
  }
  return Math.round(amountUsdc * USDC_BASE_UNIT);
}

/** Converts integer base units back into a decimal USDC amount. */
export function fromBaseUnits(baseUnits: number): number {
  return baseUnits / USDC_BASE_UNIT;
}

/** Formats integer base units as a fixed 6-decimal USDC string. */
export function formatUsdc(baseUnits: number): string {
  return (baseUnits / USDC_BASE_UNIT).toFixed(USDC_DECIMALS);
}
