import { query, pool, withTransaction } from '../lib/db';

/**
 * Idempotent schema migration for CiteRail.
 *
 * Safe to run repeatedly: every statement is guarded with IF NOT EXISTS (or is
 * a conditional ALTER), so re-running against an existing database is a no-op
 * apart from backfilling new columns.
 */
async function migrate() {
  console.log('Starting CiteRail database migration...');

  await withTransaction(async (client) => {
    // ------------------------------------------------------------------
    // Publishers
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS publishers (
        id VARCHAR(64) PRIMARY KEY,
        wallet_address VARCHAR(44) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Proof-of-ownership timestamp. NULL means the wallet has never signed the
    // authentication challenge, so the publisher identity is unverified.
    await client.query(`
      ALTER TABLE publishers ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;
    `);

    // ------------------------------------------------------------------
    // Authentication challenges (single-use, signed by the wallet)
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id VARCHAR(64) PRIMARY KEY,
        wallet_address VARCHAR(44) NOT NULL,
        nonce VARCHAR(64) UNIQUE NOT NULL,
        message TEXT NOT NULL,
        issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_challenges_wallet ON auth_challenges(wallet_address);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);
    `);

    // ------------------------------------------------------------------
    // Documents
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(64) PRIMARY KEY,
        publisher_id VARCHAR(64) REFERENCES publishers(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        file_type VARCHAR(10) NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        license_type VARCHAR(50) NOT NULL DEFAULT 'query_royalty_v1',
        price_per_query_usdc NUMERIC(10, 6) NOT NULL DEFAULT 0.050000,
        total_chunks INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Prevent a publisher from re-uploading byte-identical content, which
    // would otherwise flood the corpus and dilute retrieval quality.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_publisher_hash
        ON documents(publisher_id, content_hash);
    `);

    // ------------------------------------------------------------------
    // Document chunks
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id VARCHAR(64) PRIMARY KEY,
        document_id VARCHAR(64) REFERENCES documents(id) ON DELETE CASCADE,
        publisher_id VARCHAR(64) REFERENCES publishers(id) ON DELETE CASCADE,
        chunk_index INT NOT NULL,
        content TEXT NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        token_count INT NOT NULL,
        search_vector TSVECTOR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_search ON document_chunks USING gin(search_vector);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_pub ON document_chunks(publisher_id);
    `);

    // ------------------------------------------------------------------
    // Payment quotes
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_quotes (
        id VARCHAR(64) PRIMARY KEY,
        quote_nonce VARCHAR(64) UNIQUE NOT NULL,
        query_text TEXT NOT NULL,
        matched_chunk_ids JSONB NOT NULL,
        publisher_breakdown JSONB NOT NULL,
        total_price_usdc NUMERIC(10, 6) NOT NULL,
        memo_expected VARCHAR(255) NOT NULL,
        buyer_wallet VARCHAR(44),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Backfill buyer_wallet for quotes created before this column existed.
    await client.query(`
      ALTER TABLE payment_quotes
        ADD COLUMN IF NOT EXISTS buyer_wallet VARCHAR(44);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quotes_buyer ON payment_quotes(buyer_wallet);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quotes_nonce ON payment_quotes(quote_nonce);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quotes_status ON payment_quotes(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quotes_expires ON payment_quotes(expires_at);
    `);

    // ------------------------------------------------------------------
    // Quote source snapshots (immutable)
    //
    // Stores an immutable snapshot of every source chunk priced in a quote.
    // This prevents time-of-check/time-of-use attacks where live chunks are
    // modified between quote creation and settlement. Snapshots are write-once
    // and never exposed through public APIs.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_quote_sources (
        id VARCHAR(64) PRIMARY KEY,
        quote_id VARCHAR(64) NOT NULL REFERENCES payment_quotes(id) ON DELETE CASCADE,
        ordinal INT NOT NULL,
        chunk_id VARCHAR(64) NOT NULL,
        document_id VARCHAR(64) NOT NULL,
        publisher_id VARCHAR(64) NOT NULL,
        publisher_wallet VARCHAR(44) NOT NULL,
        document_title VARCHAR(255) NOT NULL,
        source_content TEXT NOT NULL,
        source_sha256 VARCHAR(64) NOT NULL,
        document_price_base_units BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_sources_quote_ordinal
        ON payment_quote_sources(quote_id, ordinal);
    `);
    // Replace the old global unique index on chunk_id with a composite one
    // scoped to (quote_id, chunk_id), so the same source chunk can be priced
    // in multiple quotes.
    await client.query(`
      DROP INDEX IF EXISTS idx_quote_sources_chunk;
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_sources_quote_chunk
        ON payment_quote_sources(quote_id, chunk_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_quote_sources_quote
        ON payment_quote_sources(quote_id);
    `);

    // ------------------------------------------------------------------
    // Settlement receipts
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS settlement_receipts (
        id VARCHAR(64) PRIMARY KEY,
        quote_id VARCHAR(64) REFERENCES payment_quotes(id),
        tx_signature VARCHAR(90) UNIQUE NOT NULL,
        payer_wallet VARCHAR(44) NOT NULL,
        total_amount_usdc NUMERIC(10, 6) NOT NULL,
        solana_slot BIGINT NOT NULL,
        block_time TIMESTAMP WITH TIME ZONE NOT NULL,
        memo_verified BOOLEAN NOT NULL DEFAULT true,
        breakdown JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_sig ON settlement_receipts(tx_signature);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_quote ON settlement_receipts(quote_id);
    `);

    // Which asset actually moved on-chain, and in which units. The previous
    // schema conflated USDC base units with lamports, which made it impossible
    // to tell a real USDC settlement from a native SOL one after the fact.
    await client.query(`
      ALTER TABLE settlement_receipts
        ADD COLUMN IF NOT EXISTS settlement_asset VARCHAR(16) NOT NULL DEFAULT 'USDC';
    `);
    await client.query(`
      ALTER TABLE settlement_receipts
        ADD COLUMN IF NOT EXISTS settlement_amount_base_units BIGINT NOT NULL DEFAULT 0;
    `);

    // ------------------------------------------------------------------
    // Normalised settlement payouts
    //
    // The per-publisher split used to live only inside a JSONB blob on the
    // receipt, which made per-publisher royalty accounting a full-table scan
    // in application code. This table makes it indexable.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS settlement_payouts (
        id VARCHAR(64) PRIMARY KEY,
        receipt_id VARCHAR(64) NOT NULL REFERENCES settlement_receipts(id) ON DELETE CASCADE,
        quote_id VARCHAR(64) NOT NULL,
        publisher_id VARCHAR(64) REFERENCES publishers(id) ON DELETE SET NULL,
        publisher_wallet VARCHAR(44) NOT NULL,
        publisher_name VARCHAR(100),
        document_ids TEXT[],
        document_allocations JSONB,
        amount_base_units BIGINT NOT NULL,
        amount_usdc NUMERIC(12, 6) NOT NULL,
        asset VARCHAR(16) NOT NULL DEFAULT 'USDC',
        tx_signature VARCHAR(90) NOT NULL,
        block_time TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Backfill document_ids for existing payouts that lack the column.
    await client.query(`
      ALTER TABLE settlement_payouts
        ADD COLUMN IF NOT EXISTS document_ids TEXT[];
    `);
    await client.query(`
      ALTER TABLE settlement_payouts
        ADD COLUMN IF NOT EXISTS document_allocations JSONB;
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_receipt_wallet
        ON settlement_payouts(receipt_id, publisher_wallet);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payouts_publisher ON settlement_payouts(publisher_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payouts_wallet ON settlement_payouts(publisher_wallet);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payouts_created ON settlement_payouts(created_at DESC);
    `);

    // ------------------------------------------------------------------
    // Query executions
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS query_executions (
        id VARCHAR(64) PRIMARY KEY,
        receipt_id VARCHAR(64) REFERENCES settlement_receipts(id),
        query_text TEXT NOT NULL,
        ai_provider VARCHAR(50) NOT NULL,
        ai_model VARCHAR(50) NOT NULL,
        generated_answer TEXT NOT NULL,
        citations JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_query_exec_receipt ON query_executions(receipt_id);
    `);

    // Backfill payouts for receipts that were settled before this table
    // existed, so historical revenue is not lost.
    // Non-fatal: historical backfill must not block schema migration.
    try {
      const backfill = await client.query(`
        INSERT INTO settlement_payouts (
          id, receipt_id, quote_id, publisher_id, publisher_wallet, publisher_name,
          amount_base_units, amount_usdc, asset, tx_signature, block_time
        )
        SELECT
          'pay_' || substr(md5(r.id || (elem->>'publisher_wallet')), 1, 32),
          r.id,
          r.quote_id,
          p.id,
          elem->>'publisher_wallet',
          elem->>'publisher_name',
          COALESCE((elem->>'received_amount')::bigint, 0),
          COALESCE(((elem->>'received_amount')::numeric / 1000000), 0),
          COALESCE(r.settlement_asset, 'USDC'),
          r.tx_signature,
          r.block_time
        FROM settlement_receipts r
        CROSS JOIN LATERAL jsonb_array_elements(r.breakdown::jsonb) AS elem
        LEFT JOIN publishers p ON p.wallet_address = elem->>'publisher_wallet'
        WHERE elem->>'publisher_wallet' IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM settlement_payouts sp
            WHERE sp.receipt_id = r.id
              AND sp.publisher_wallet = elem->>'publisher_wallet'
          )
        ON CONFLICT DO NOTHING;
      `);
      console.log(
        `  backfilled ${backfill.rowCount ?? 0} historical settlement payout(s)`
      );
    } catch (backfillErr) {
      console.warn(
        `  backfill skipped: ${backfillErr instanceof Error ? backfillErr.message : String(backfillErr)}`
      );
    }
  });

  // Verify the schema is actually usable before reporting success.
  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`
  );
  console.log('Tables present:', tables.rows.map((t) => t.table_name).join(', '));
  console.log('Database tables, constraints, and indexes created successfully.');
}

migrate()
  .then(async () => {
    await pool.end();
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
