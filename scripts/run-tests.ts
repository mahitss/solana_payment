import assert from 'assert';
import { chunkText, computeSha256 } from '../lib/chunker';
import { isValidSolanaAddress, getOrCreatePublisher } from '../lib/publishers';
import { ingestDocument } from '../lib/documents';
import { searchKnowledgeCollections } from '../lib/retrieval';
import { createPaymentQuote, getQuote } from '../lib/quotes';
import { verifySettlementTransaction, SolanaVerificationError } from '../lib/solana';
import { OllamaProvider, AIProviderUnavailableError } from '../lib/ai/provider';
import { query, pool } from '../lib/db';
import crypto from 'crypto';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log('\x1b[32mPASSED\x1b[0m');
    passed++;
  } catch (err: any) {
    console.log('\x1b[31mFAILED\x1b[0m');
    console.error('  Error:', err.message);
    if (err.stack) {
      console.error('  ', err.stack.split('\n').slice(1, 3).join('\n  '));
    }
    failed++;
  }
}

async function runSuite() {
  console.log('\n================ CITERAIL TEST SUITE ================\n');

  // Test 1: Document Chunking & Hashing
  await test('Chunking logic and SHA-256 hash calculation', async () => {
    const text = 'First paragraph with some words.\n\nSecond paragraph with more words for chunking testing.';
    const chunks = chunkText(text, 10, 2);
    assert(chunks.length >= 2, 'Should produce at least 2 chunks');
    assert(chunks[0].chunk_index === 0, 'First chunk index should be 0');
    assert(chunks[0].content_hash.length === 64, 'Chunk hash should be a 64-char sha256 hex');
    const expectedHash = computeSha256(chunks[0].content);
    assert.strictEqual(chunks[0].content_hash, expectedHash, 'Hash must match computeSha256');
  });

  // Test 2: Solana Wallet Address Validation
  await test('Solana address validation (base58 on-curve)', async () => {
    assert.strictEqual(isValidSolanaAddress('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK'), true);
    assert.strictEqual(isValidSolanaAddress('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), true);
    assert.strictEqual(isValidSolanaAddress('InvalidWalletAddress123'), false);
    assert.strictEqual(isValidSolanaAddress(''), false);
  });

  // Test 3: Payment Allocation & Quote Calculation
  await test('Payment quote pricing breakdown and memo binding format', async () => {
    const mockChunks: any[] = [
      {
        id: 'chk_1',
        document_id: 'doc_1',
        publisher_id: 'pub_1',
        publisher_wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        publisher_name: 'Solana Arch',
        document_title: 'Turbine Spec',
        price_per_query_usdc: '0.050000',
        chunk_index: 0,
        content: 'Turbine block propagation content',
        content_hash: computeSha256('Turbine block propagation content'),
        token_count: 50,
      },
      {
        id: 'chk_2',
        document_id: 'doc_2',
        publisher_id: 'pub_2',
        publisher_wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        publisher_name: 'CiteRail Core',
        document_title: 'Settlement Protocol',
        price_per_query_usdc: '0.050000',
        chunk_index: 0,
        content: 'Settlement verification content',
        content_hash: computeSha256('Settlement verification content'),
        token_count: 50,
      },
    ];

    const quote = await createPaymentQuote('Test query about Turbine and Settlement', mockChunks);
    assert(quote.id.startsWith('q_'), 'Quote ID must start with q_');
    assert.strictEqual(quote.total_price_usdc, 0.1, 'Total price should be 0.05 + 0.05 = 0.1 USDC');
    assert.strictEqual(quote.total_base_units, 100_000, 'Total base units should be 100,000 (0.100000 USDC)');
    assert(quote.memo_expected.startsWith(`CITERAIL:${quote.id}:`), 'Memo must start with CITERAIL:<quote_id>:');
    assert.strictEqual(quote.publisher_breakdown.length, 2, 'Should have 2 publisher breakdowns');
    assert.strictEqual(quote.status, 'PENDING', 'Quote status should be PENDING');
  });

  // Test 4: Replay Protection
  await test('Server-side replay protection rejects already-redeemed signatures', async () => {
    const fakeSig = 'fakeSig_' + crypto.randomBytes(32).toString('hex');
    const dummyQuote = await createPaymentQuote('Dummy query', [
      {
        id: 'chk_dummy',
        document_id: 'doc_dummy',
        publisher_id: 'pub_dummy',
        publisher_wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        publisher_name: 'Dummy',
        document_title: 'Dummy Doc',
        price_per_query_usdc: '0.050000',
        chunk_index: 0,
        content: 'Dummy chunk',
        content_hash: 'hash123',
        token_count: 10,
      },
    ]);

    // Insert fake receipt in database to simulate prior redemption
    await query(
      `INSERT INTO settlement_receipts (
        id, quote_id, tx_signature, payer_wallet, total_amount_usdc, solana_slot, block_time, memo_verified, breakdown
      ) VALUES ($1, $2, $3, $4, 0.05, 12345, NOW(), true, '[]')`,
      [`rcpt_${fakeSig.slice(0, 16)}`, dummyQuote.id, fakeSig, 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK']
    );

    let threw = false;
    try {
      await verifySettlementTransaction(fakeSig, dummyQuote);
    } catch (err: any) {
      threw = true;
      assert(err instanceof SolanaVerificationError, 'Should throw SolanaVerificationError');
      assert.strictEqual(err.code, 'REPLAY_DETECTED', 'Error code must be REPLAY_DETECTED');
    }
    assert(threw, 'Should have thrown error on replayed transaction signature');
  });

  // Test 5: Malformed & Invalid Signature Rejection
  await test('Malformed signature rejection without Solana RPC call', async () => {
    const invalidSig = 'too_short';
    const dummyQuote: any = { id: 'q_test', expires_at: new Date(Date.now() + 10000).toISOString() };

    let threw = false;
    try {
      await verifySettlementTransaction(invalidSig, dummyQuote);
    } catch (err: any) {
      threw = true;
      assert.strictEqual(err.code, 'INVALID_SIGNATURE', 'Must reject invalid signature format');
    }
    assert(threw, 'Must throw on malformed signature');
  });

  // Test 6: Semantic Knowledge Retrieval from PostgreSQL
  await test('Full-text semantic retrieval matches seeded knowledge', async () => {
    const results = await searchKnowledgeCollections('Turbine block propagation protocol', 2);
    assert(results.length > 0, 'Should find matched knowledge chunks');
    assert(
      results.some((r) => r.document_title.includes('Turbine')),
      'Should retrieve the Solana High-Throughput document'
    );
  });

  // Test 7: Real AI Provider (Ollama) Grounded Inference
  await test('Ollama local provider grounded synthesis and citation generation', async () => {
    const ollama = new OllamaProvider();
    const available = await ollama.isAvailable();
    assert(available, 'Local Ollama should be reachable on http://127.0.0.1:11434');

    const chunks = await searchKnowledgeCollections('What is Proof of History in Solana?', 1);
    assert(chunks.length > 0, 'Must have at least 1 knowledge chunk');

    const answer = await ollama.generateAnswer('Explain Proof of History in Solana.', chunks);
    assert(answer.answer.length > 20, 'Should produce a non-empty answer');
    assert.strictEqual(answer.provider, 'ollama', 'Provider must be ollama');
    assert(answer.citations.length > 0, 'Must attach grounded citations');
    assert.strictEqual(answer.citations[0].chunk_id, chunks[0].id, 'Citation chunk_id must match source chunk');
  });

  // Test 8: Fail-Closed Provider Check
  await test('AI provider fail-closed when credentials / models are absent', async () => {
    // If we test with empty or invalid URL, it should report unavailable
    const badOllama = new OllamaProvider();
    (badOllama as any).baseUrl = 'http://127.0.0.1:59999';
    const isAvail = await badOllama.isAvailable();
    assert.strictEqual(isAvail, false, 'Unreachable endpoint must report isAvailable() === false');
  });

  console.log('\n------------------------------------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log('------------------------------------------------------\n');

  await pool.end();

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal suite error:', err);
  process.exit(1);
});
