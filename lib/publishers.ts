import { query } from './db';
import { PublicKey } from '@solana/web3.js';
import crypto from 'crypto';

export interface Publisher {
  id: string;
  wallet_address: string;
  name: string;
  email: string | null;
  created_at: string;
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const pubkey = new PublicKey(address);
    return PublicKey.isOnCurve(pubkey.toBuffer());
  } catch {
    return false;
  }
}

export async function getOrCreatePublisher(walletAddress: string, name?: string, email?: string): Promise<Publisher> {
  const cleanAddress = walletAddress.trim();
  if (!isValidSolanaAddress(cleanAddress)) {
    throw new Error(`Invalid Solana public key: ${walletAddress}`);
  }

  const existing = await query<Publisher>(
    'SELECT * FROM publishers WHERE wallet_address = $1',
    [cleanAddress]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const id = `pub_${crypto.randomUUID()}`;
  const displayName = (name && name.trim()) || `Publisher ${cleanAddress.slice(0, 4)}..${cleanAddress.slice(-4)}`;
  const displayEmail = email?.trim() || null;

  const result = await query<Publisher>(
    `INSERT INTO publishers (id, wallet_address, name, email)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, cleanAddress, displayName, displayEmail]
  );

  return result.rows[0];
}

export async function getPublisherByWallet(walletAddress: string): Promise<Publisher | null> {
  const res = await query<Publisher>(
    'SELECT * FROM publishers WHERE wallet_address = $1',
    [walletAddress.trim()]
  );
  return res.rows[0] || null;
}

export async function listAllPublishers(): Promise<Publisher[]> {
  const res = await query<Publisher>(
    'SELECT * FROM publishers ORDER BY created_at DESC'
  );
  return res.rows;
}
