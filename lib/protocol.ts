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
export const USDC_BASE_UNIT = BigInt(10 ** USDC_DECIMALS);

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

/** Maximum accepted per-query price, in whole USDC. */
export const MAX_PRICE_USDC = BigInt(1000 * 1_000_000);

/** Minimum accepted per-query price, in USDC base units (1e-6 USDC). */
export const MIN_PRICE_BASE_UNITS = BigInt(1);

/**
 * Maximum number of decimal places accepted in a price string.
 * USDC has 6 decimals, so we accept at most 6 fractional digits.
 */
export const MAX_PRICE_DECIMAL_PLACES = USDC_DECIMALS;

/**
 * Parse a price string directly into BigInt USDC base units.
 *
 * The input must be a decimal string such as "0.05", "0.050000", or "50000".
 * At most 6 fractional digits are accepted. Invalid, negative, zero, or
 * excessive prices throw. No floating-point arithmetic is used anywhere.
 *
 * @throws {Error} when the price is invalid, non-finite, negative, zero,
 *   has more than 6 decimal places, or exceeds MAX_PRICE_USDC.
 */
export function parsePriceToBaseUnits(priceStr: string): bigint {
  const trimmed = priceStr.trim();
  if (!trimmed) {
    throw new Error('Invalid USDC amount: empty string.');
  }

  // Reject anything that is not a plain decimal number.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: "${priceStr}".`);
  }

  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;

  const [intPart, fracPart = ''] = unsigned.split('.');

  if (fracPart.length > MAX_PRICE_DECIMAL_PLACES) {
    throw new Error(
      `USDC amount "${priceStr}" has more than ${MAX_PRICE_DECIMAL_PLACES} decimal places.`
    );
  }

  // Pad the fractional part to exactly 6 digits, then combine with the
  // integer part to form the base-unit value as a pure integer string.
  const padded = fracPart.padEnd(USDC_DECIMALS, '0');
  const baseUnitsStr = intPart + padded;
  const baseUnits = BigInt(baseUnitsStr);

  if (isNegative) {
    throw new Error(`USDC amount must be positive: "${priceStr}".`);
  }
  if (baseUnits < MIN_PRICE_BASE_UNITS) {
    throw new Error(`USDC amount must be at least 0.000001: "${priceStr}".`);
  }
  if (baseUnits > MAX_PRICE_USDC) {
    throw new Error(
      `USDC amount exceeds maximum of ${MAX_PRICE_USDC / BigInt(1000000)} USDC: "${priceStr}".`
    );
  }

  return baseUnits;
}

/** Converts integer base units back into a decimal USDC string. */
export function fromBaseUnits(baseUnits: bigint): string {
  const abs = baseUnits < BigInt(0) ? -baseUnits : baseUnits;
  const intPart = (abs / USDC_BASE_UNIT).toString();
  const fracPart = (abs % USDC_BASE_UNIT).toString().padStart(USDC_DECIMALS, '0');
  const sign = baseUnits < BigInt(0) ? '-' : '';
  return `${sign}${intPart}.${fracPart}`;
}

/** Formats integer base units as a fixed 6-decimal USDC string. */
export function formatUsdc(baseUnits: bigint): string {
  return fromBaseUnits(baseUnits);
}

/** Parses a PostgreSQL NUMERIC price string into BigInt base units. */
export function parseNumericPrice(numericValue: unknown): bigint {
  if (numericValue === null || numericValue === undefined) {
    throw new Error('Invalid USDC amount: null or undefined.');
  }
  return parsePriceToBaseUnits(String(numericValue));
}
