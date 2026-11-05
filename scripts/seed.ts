import { ingestDocument } from '../lib/documents';
import { pool } from '../lib/db';

async function seed() {
  console.log('Seeding initial CiteRail published knowledge base...');

  const doc1 = await ingestDocument({
    publisherWallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
    publisherName: 'Solana Systems Architecture',
    title: 'Solana High-Throughput Consensus & Turbine Protocol Specification',
    fileType: 'md',
    pricePerQueryUsdc: 0.05,
    rawText: `# Solana High-Throughput Consensus & Turbine Protocol

## Proof of History (PoH)
Proof of History is a high-frequency verifiable delay function (VDF). In Solana, PoH provides a cryptographic timestamp that allows validators to trust the passage of time without having to communicate with every other node. A SHA-256 sequential hashing loop ensures that messages are ordered sequentially before consensus.

## Tower BFT Consensus
Tower BFT is an asynchronous Byzantine Fault Tolerance algorithm tailored specifically to operate on top of the Proof of History ledger. Rather than sending individual consensus messages for every block, validators cast votes on PoH slots. With each successive vote, the lockup timeout period doubles exponentially, ensuring deterministic rollback resistance.

## Turbine Block Propagation
Turbine solves the classic blockchain bandwidth bottleneck. When a designated leader validator produces a shredded transaction block, it breaks the block into small packets with Reed-Solomon erasure coding. Instead of broadcasting each packet to thousands of nodes individually, Turbine uses a multi-layered random tree topology to stream packets hop-by-hop with minimal latency.

## Gulf Stream Mempool-less Execution
Solana replaces traditional memory pools by pushing transaction routing to the edge of the network. Because validator schedules are deterministic, clients and RPC nodes push signed transactions directly to the upcoming leader validators ahead of slot production.`,
  });

  console.log(`Indexed document 1: ${doc1.title} (${doc1.total_chunks} chunks)`);

  const doc2 = await ingestDocument({
    publisherWallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    publisherName: 'CiteRail Protocol Core',
    title: 'CiteRail On-Chain Verification & Royalty Settlement Protocol',
    fileType: 'md',
    pricePerQueryUsdc: 0.05,
    rawText: `# CiteRail On-Chain Verification & Royalty Settlement Protocol

## Core Promise and Settlement Guarantee
When an AI engine synthesizes an answer using licensed publisher knowledge, the user's wallet executes an atomic on-chain transaction on Solana Devnet before any grounded knowledge is unlocked. The platform enforces strict non-custodial settlement: funds travel directly from the buyer's wallet to the publisher's token account.

## Cryptographic Memo Binding
Every payment transaction MUST contain an instruction executing the official Solana Memo Program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr). The memo data must match the format:
CITERAIL:QUOTE:<quote_id>:<source_digest>
This binds the transaction to the exact query session and chunk hashes, preventing front-running, transaction substitution, and tampering.

## Six-Point Verification Engine
The server-side verification engine queries the Solana Devnet RPC and validates:
1. Slot confirmation and error-free on-chain status (meta.err === null).
2. Database replay protection: the transaction signature has never been recorded in prior settlement receipts.
3. Block time validity: mined block time does not exceed quote expiry (5-minute window).
4. Memo presence and exact digest match.
5. Exact publisher destination accounts and transferred token/SOL amounts.
6. Fail-closed retrieval: if any check fails, access to the paid response is blocked.

## Grounded Citation Rules
Every factual claim generated in CiteRail must carry an explicit footnote marker [^N] linking to the verified source index. Hallucinated or speculative citations are strictly forbidden.`,
  });

  console.log(`Indexed document 2: ${doc2.title} (${doc2.total_chunks} chunks)`);

  const doc3 = await ingestDocument({
    publisherWallet: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
    publisherName: 'Web3 AI Rights & Economics',
    title: 'Decentralized AI Knowledge Retrieval and Creator Rights Framework',
    fileType: 'md',
    pricePerQueryUsdc: 0.04,
    rawText: `# Decentralized AI Knowledge Retrieval and Creator Rights Framework

## The Creator Compensation Crisis
Traditional generative AI platforms scrape and ingest vast corpora of creative and technical literature without attribution or royalty remuneration. This strips incentives for technical authors, researchers, and domain experts.

## Micro-Settlement Economics on High-Speed Blockchains
High-frequency micropayments were historically unviable on Ethereum due to variable gas spikes. Solana's sub-second block times and sub-cent fees enable true per-retrieval settlement where publishers receive instantaneous royalties (such as $0.05 USDC) every time their work directly informs an AI synthesis.

## Verifiable Audit Receipts
Every retrieval event produces a publicly verifiable receipt on Solana. Third-party auditors, creators, and consumers can query any transaction signature to confirm exact payment distribution, proving that creator compensation occurred on-chain.`,
  });

  console.log(`Indexed document 3: ${doc3.title} (${doc3.total_chunks} chunks)`);

  console.log('Knowledge base seeding completed successfully!');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seeding error:', err);
  process.exit(1);
});
