import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { query } from './db';
import { config } from './config';

/**
 * Wallet-based authentication ("Sign-In With Solana" style).
 *
 * The publisher identity in CiteRail is a Solana address, so proving ownership
 * of that address is the only meaningful way to authenticate a publisher. The
 * flow is:
 *
 *   1. POST /api/auth/challenge { wallet }   -> nonce + canonical message
 *   2. client signs the message with the wallet
 *   3. POST /api/auth/verify { wallet, message, signature } -> session token
 *
 * The session token is an HMAC-SHA256 signed envelope; no external JWT library
 * and no server-side session storage is required.
 */

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = 'UNAUTHORIZED', status = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates that `address` is a well-formed base58 Solana public key.
 *
 * Unlike the previous implementation this deliberately does NOT require the key
 * to be on-curve: program-derived addresses (PDAs) are legitimate recipients
 * and must be able to register as publishers.
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  try {
    const key = new PublicKey(trimmed);
    return key.toBytes().length === 32;
  } catch {
    return false;
  }
}

/** Returns true when the address is a normal (on-curve) wallet address. */
export function isOnCurveSolanaAddress(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address.trim()).toBytes());
  } catch {
    return false;
  }
}

/** Canonical, human-readable authentication message. */
export function buildAuthMessage(params: {
  wallet: string;
  nonce: string;
  issuedAt: string;
  domain: string;
}): string {
  return [
    'CiteRail Authentication',
    '',
    `Wallet: ${params.wallet}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Domain: ${params.domain}`,
    '',
    'Signing this message proves wallet ownership. It does not trigger a',
    'blockchain transaction and does not cost any SOL.',
  ].join('\n');
}

/**
 * Verifies an Ed25519 signature produced by a Solana wallet.
 *
 * @param message   The exact UTF-8 bytes that were signed.
 * @param signature Base64-encoded 64-byte detached signature.
 * @param wallet    The base58 public key expected to have signed.
 */
export function verifyWalletSignature(
  message: string,
  signature: string,
  wallet: string
): boolean {
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;

  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = new PublicKey(wallet.trim()).toBytes();
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== 32) return false;

  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]);
    const keyObject = crypto.createPublicKey({
      key: spki,
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      keyObject,
      sigBytes
    );
  } catch {
    return false;
  }
}

/** Creates a single-use authentication challenge for a wallet. */
export async function createAuthChallenge(
  wallet: string,
  domain: string
): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const cleanWallet = wallet.trim();
  if (!isValidSolanaAddress(cleanWallet)) {
    throw new AuthError('Invalid Solana wallet address.', 'INVALID_WALLET', 400);
  }

  const nonce = crypto.randomBytes(24).toString('hex');
  const issuedAt = new Date().toISOString();
  const message = buildAuthMessage({ wallet: cleanWallet, nonce, issuedAt, domain });
  const expiresAt = new Date(
    Date.now() + config.challengeTtlSeconds * 1000
  ).toISOString();

  await query(
    `INSERT INTO auth_challenges (id, wallet_address, nonce, message, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      `chl_${crypto.randomUUID()}`,
      cleanWallet,
      nonce,
      message,
      issuedAt,
      expiresAt,
    ]
  );

  return { nonce, message, expiresAt };
}

export interface AuthenticatedSession {
  wallet: string;
  expiresAt: number;
}

/** Issues a signed session token for a verified wallet. */
export function issueSessionToken(wallet: string): {
  token: string;
  expiresAt: number;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const payload = JSON.stringify({ w: wallet, e: expiresAt });

  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getAuthSecret())
    .update(encoded)
    .digest('base64url');

  return { token: `${encoded}.${signature}`, expiresAt };
}

/** Verifies a session token and returns the bound wallet. */
export function verifySessionToken(token: string): AuthenticatedSession | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expected = crypto
    .createHmac('sha256', getAuthSecret())
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof payload.w !== 'string' || typeof payload.e !== 'number') {
      return null;
    }
    if (payload.e * 1000 < Date.now()) return null;
    return { wallet: payload.w, expiresAt: payload.e };
  } catch {
    return null;
  }
}

/** Extracts a bearer token from an incoming request. */
export function getBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Requires a valid session token on a request.
 *
 * @throws AuthError when the request is unauthenticated or the token is invalid.
 */
export function requireAuth(req: Request): AuthenticatedSession {
  const token = getBearerToken(req);
  if (!token) {
    throw new AuthError(
      'Authentication required. Sign in with your wallet and send the session token as: Authorization: Bearer <token>.',
      'MISSING_TOKEN'
    );
  }
  const session = verifySessionToken(token);
  if (!session) {
    throw new AuthError('Invalid or expired session token.', 'INVALID_TOKEN');
  }
  return session;
}

/**
 * Resolves the auth secret lazily so that importing this module never throws
 * during `next build`.
 */
function getAuthSecret(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getAuthSecret: resolve } = require('./config');
  return resolve();
}

/**
 * Marks a publisher wallet as cryptographically verified.
 * Used after a successful wallet-ownership proof.
 */
export async function markPublisherVerified(wallet: string): Promise<void> {
  await query(
    `UPDATE publishers SET verified_at = COALESCE(verified_at, NOW()) WHERE wallet_address = $1`,
    [wallet.trim()]
  );
}
