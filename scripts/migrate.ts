import { query, pool } from '../lib/db';

async function migrate() {
  console.log('Starting CiteRail database migration...');

  await query(`
    CREATE TABLE IF NOT EXISTS publishers (
      id VARCHAR(64) PRIMARY KEY,
      wallet_address VARCHAR(44) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE INDEX IF NOT EXISTS idx_chunks_search ON document_chunks USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_pub ON document_chunks(publisher_id);

    CREATE TABLE IF NOT EXISTS payment_quotes (
      id VARCHAR(64) PRIMARY KEY,
      quote_nonce VARCHAR(64) UNIQUE NOT NULL,
      query_text TEXT NOT NULL,
      matched_chunk_ids JSONB NOT NULL,
      publisher_breakdown JSONB NOT NULL,
      total_price_usdc NUMERIC(10, 6) NOT NULL,
      memo_expected VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_quotes_nonce ON payment_quotes(quote_nonce);
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON payment_quotes(status);

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

    CREATE INDEX IF NOT EXISTS idx_receipts_sig ON settlement_receipts(tx_signature);
    CREATE INDEX IF NOT EXISTS idx_receipts_quote ON settlement_receipts(quote_id);

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

    CREATE INDEX IF NOT EXISTS idx_query_exec_receipt ON query_executions(receipt_id);
  `);

  console.log('Database tables, constraints, and indexes created successfully.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
