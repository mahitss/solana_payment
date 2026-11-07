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

export const SUPPORTED_LICENSE_TYPES = new Set(['query_royalty_v1']);

export const PUBLISHER_STATUS_ACTIVE = 'active';
export const PUBLISHER_STATUS_REVOKED = 'revoked';

export function isSupportedLicenseType(licenseType: string | null | undefined): boolean {
  if (!licenseType) return false;
  return SUPPORTED_LICENSE_TYPES.has(licenseType);
}

export function isPublisherEligible(status: string | null | undefined, verifiedAt: string | null | undefined): boolean {
  if (status !== PUBLISHER_STATUS_ACTIVE) return false;
  if (!verifiedAt) return false;
  return true;
}

/**
 * SQL predicate fragment for license eligibility. This exact text must be
 * used in both the FTS and semantic retrieval queries so they cannot drift
 * apart. It references table aliases:
 *   - p for publishers (status, verified_at)
 *   - d for documents (license_type)
 */
export const ELIGIBILITY_SQL_PREDICATE = `
  p.status = '${PUBLISHER_STATUS_ACTIVE}'
  AND p.verified_at IS NOT NULL
  AND d.license_type = 'query_royalty_v1'
`;

/**
 * Returns the supported license types as a sorted array.
 */
export function getSupportedLicenseTypes(): string[] {
  return Array.from(SUPPORTED_LICENSE_TYPES).sort();
}
