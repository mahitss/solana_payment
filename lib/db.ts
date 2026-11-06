import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { config } from './config';

dotenv.config();

/**
 * SSL is only required for hosted Postgres (Neon, Supabase, RDS...). A local
 * Postgres instance typically has no TLS configured, so forcing it on would
 * break local development. Certificate verification stays enabled wherever TLS
 * is actually used - the previous `rejectUnauthorized: false` weakened every
 * connection, including remote ones.
 */
function buildSslConfig(): false | { rejectUnauthorized: boolean } {
  const connectionString = process.env.DATABASE_URL || '';
  const isRemote = /@[^/]*\.(?:com|io|tech|net|org|dev|app|cloud)\//i.test(connectionString);
  const explicitlyRequired = /sslmode=require/i.test(connectionString);

  if (!isRemote && !explicitlyRequired) {
    return false;
  }

  // `sslmode=no-verify` is the only case where we relax verification, and it
  // must be requested explicitly by the operator.
  const insecure = /sslmode=no-verify/i.test(connectionString);
  return { rejectUnauthorized: !insecure };
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: buildSslConfig(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on
 * any thrown error. The client is always released.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it is the best we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}
