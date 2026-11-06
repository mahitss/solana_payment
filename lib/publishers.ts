import { query } from './db';
import { isValidSolanaAddress } from './auth';

export interface Publisher {
  id: string;
  wallet_address: string;
  name: string;
  email: string | null;
  /** Set once the wallet has signed an authentication challenge. */
  verified_at: string | null;
  created_at: string;
}

export { isValidSolanaAddress };

/**
 * Registers a publisher, or returns the existing record for that wallet.
 *
 * The caller is responsible for having proved wallet ownership (see
 * `lib/auth.ts`); this function no longer trusts a wallet address supplied
 * by an anonymous request.
 */
export async function getOrCreatePublisher(
  walletAddress: string,
  name?: string,
  email?: string
): Promise<Publisher> {
  const cleanAddress = walletAddress.trim();
  if (!isValidSolanaAddress(cleanAddress)) {
    throw new Error(`Invalid Solana public key: ${walletAddress}`);
  }

  const existing = await query<Publisher>(
    'SELECT * FROM publishers WHERE wallet_address = $1',
    [cleanAddress]
  );

  if (existing.rows.length > 0) {
    const publisher = existing.rows[0];

    // Keep the display profile current without ever changing the wallet.
    const nextName = name?.trim();
    const nextEmail = email?.trim();
    const nameChanged = nextName && nextName !== publisher.name;
    const emailChanged = nextEmail && nextEmail !== publisher.email;

    if (nameChanged || emailChanged) {
      const updated = await query<Publisher>(
        `UPDATE publishers
         SET name = COALESCE($2, name), email = COALESCE($3, email)
         WHERE id = $1
         RETURNING *`,
        [publisher.id, nameChanged ? nextName : null, emailChanged ? nextEmail : null]
      );
      return updated.rows[0];
    }

    return publisher;
  }

  const id = `pub_${crypto.randomUUID()}`;
  const displayName =
    (name && name.trim()) ||
    `Publisher ${cleanAddress.slice(0, 4)}..${cleanAddress.slice(-4)}`;
  const displayEmail = email?.trim() || null;

  const result = await query<Publisher>(
    `INSERT INTO publishers (id, wallet_address, name, email)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, cleanAddress, displayName, displayEmail]
  );

  return result.rows[0];
}

export async function getPublisherByWallet(
  walletAddress: string
): Promise<Publisher | null> {
  const res = await query<Publisher>(
    'SELECT * FROM publishers WHERE wallet_address = $1',
    [walletAddress.trim()]
  );
  return res.rows[0] || null;
}

export async function getPublisherById(id: string): Promise<Publisher | null> {
  const res = await query<Publisher>('SELECT * FROM publishers WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function listAllPublishers(): Promise<Publisher[]> {
  const res = await query<Publisher>(
    'SELECT * FROM publishers ORDER BY created_at DESC'
  );
  return res.rows;
}
