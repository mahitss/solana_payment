/**
 * Explicit license eligibility policy for CiteRail retrieval.
 *
 * This module defines the single source of truth for which documents and
 * publishers are eligible for retrieval and quote creation. Both the FTS and
 * semantic retrieval paths must apply the same predicate so they cannot drift
 * apart.
 *
 * Supported license types:
 *   - 'query_royalty_v1' — the only currently supported license type.
 *
 * Publisher statuses:
 *   - 'active' — publisher has passed wallet ownership verification.
 *   - 'revoked' — publisher access has been explicitly revoked.
 *
 * A publisher is eligible for retrieval only when:
 *   1. status = 'active' (not revoked), AND
 *   2. verified_at IS NOT NULL (wallet ownership verified), AND
 *   3. The document's license_type is in the supported set.
 */

import { query } from './db';

export const SUPPORTED_LICENSE_TYPES = new Set(['query_royalty_v1']);

export const PUBLISHER_STATUS_ACTIVE = 'active';
export const PUBLISHER_STATUS_REVOKED = 'revoked';
export const DOCUMENT_STATUS_ACTIVE = 'active';
export const DOCUMENT_STATUS_REVOKED = 'revoked';

export function isSupportedLicenseType(licenseType: string | null | undefined): boolean {
  if (!licenseType) return false;
  return SUPPORTED_LICENSE_TYPES.has(licenseType);
}

export function isPublisherEligible(status: string | null | undefined, verifiedAt: string | null | undefined): boolean {
  if (status !== PUBLISHER_STATUS_ACTIVE) return false;
  if (!verifiedAt) return false;
  return true;
}

export function isDocumentEligible(status: string | null | undefined): boolean {
  return status === DOCUMENT_STATUS_ACTIVE;
}

/**
 * SQL predicate fragment for retrieval eligibility. This exact text must be
 * used in both the FTS and semantic retrieval queries (and anywhere else
 * chunks are selected for retrieval or pricing) so the checks cannot drift
 * apart. It references table aliases:
 *   - p for publishers (status, verified_at)
 *   - d for documents (status, license_type)
 *
 * A chunk is eligible only when:
 *   1. The publisher is active and wallet-verified, AND
 *   2. The document has not been revoked, AND
 *   3. The document's license_type is in the supported set.
 */
export const ELIGIBILITY_SQL_PREDICATE = `
  p.status = '${PUBLISHER_STATUS_ACTIVE}'
  AND p.verified_at IS NOT NULL
  AND d.status = '${DOCUMENT_STATUS_ACTIVE}'
  AND d.license_type = 'query_royalty_v1'
`;

/**
 * Returns the supported license types as a sorted array.
 */
export function getSupportedLicenseTypes(): string[] {
  return Array.from(SUPPORTED_LICENSE_TYPES).sort();
}

/**
 * Error thrown when a chunk referenced at pricing time is no longer eligible
 * in the database (document revoked, publisher revoked/unverified, or license
 * unsupported/missing).
 */
export class IneligibleSourceError extends Error {
  code: string;
  chunkIds: string[];

  constructor(chunkIds: string[]) {
    super(
      `Source chunk(s) are no longer eligible for pricing: ${chunkIds.join(', ')}. ` +
        'The document or its publisher may have been revoked, or the license is unsupported.'
    );
    this.name = 'IneligibleSourceError';
    this.code = 'INELIGIBLE_SOURCE_CHUNK';
    this.chunkIds = chunkIds;
  }
}

/**
 * Revalidates the CURRENT database eligibility of the given chunk IDs.
 *
 * Retrieval is a point-in-time snapshot: a chunk that was retrieved a moment
 * ago may have been revoked since. Quote creation must therefore re-apply the
 * exact same eligibility predicate against the live database before pricing,
 * or a previously-retrieved chunk could bypass a later revocation and receive
 * a new royalty allocation.
 *
 * Throws `IneligibleSourceError` if any chunk is missing from the eligible
 * set. Returns normally when every chunk passes.
 */
export async function assertChunksEligible(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;

  const placeholders = chunkIds.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `
    SELECT c.id
    FROM document_chunks c
    JOIN documents d ON c.document_id = d.id
    JOIN publishers p ON c.publisher_id = p.id
    WHERE c.id IN (${placeholders})
      AND ${ELIGIBILITY_SQL_PREDICATE}
  `;

  const res = await query<{ id: string }>(sql, chunkIds);
  const found = new Set(res.rows.map((r) => r.id));
  const missing = chunkIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new IneligibleSourceError(missing);
  }
}
