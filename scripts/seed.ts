import { ingestDocument, DuplicateDocumentError } from '../lib/documents';
import { query, pool } from '../lib/db';
import { markPublisherVerified } from '../lib/auth';

/**
 * Seeds the demo knowledge base.
 *
 * Idempotent: documents that have already been published by the same wallet
 * are skipped rather than failing, so the script can be re-run safely.
 */
async function seed() {
  console.log('Seeding initial CiteRail published knowledge base...');

  const documents = [
    {
      publisherWallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      publisherName: 'Solana Systems Architecture',
      title: 'Solana High-Throughput Consensus & Turbine Protocol Specification',
      fileType: 'md' as const,
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
    },
    {
      publisherWallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      publisherName: 'CiteRail Protocol Core',
      title: 'CiteRail On-Chain Verification & Royalty Settlement Protocol',
      fileType: 'md' as const,
      pricePerQueryUsdc: 0.05,
      rawText: `# CiteRail On-Chain Verification & Royalty Settlement Protocol

## Core Promise and Settlement Guarantee
When an AI engine synthesizes an answer using licensed publisher knowledge, the user's wallet executes an atomic on-chain transaction on Solana Devnet before any grounded knowledge is unlocked. The platform enforces strict non-custodial settlement: funds travel directly from the buyer's wallet to the publisher's token account.

## Cryptographic Memo Binding
Every payment transaction MUST contain an instruction executing the official Solana Memo Program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr). The memo data must match the format:
CITERAIL:QUOTE:<quote_id>:<quote_nonce>:<source_digest>
This binds the transaction to the exact query session, the unique nonce issued for that quote, and the SHA-256 digest of the source chunk hashes that were priced, preventing front-running, transaction substitution, and tampering.

## Eight-Point Verification Engine
The server-side verification engine queries the Solana Devnet RPC and validates:
1. Slot confirmation and error-free on-chain status (meta.err === null).
2. Database replay protection: the transaction signature has never been recorded in prior settlement receipts.
3. Block time validity: mined block time does not exceed quote expiry (5-minute window).
4. Payer identity: the transaction fee payer must be the expected buyer wallet.
5. Memo presence and exact byte-for-byte digest match against the issued quote.
6. Exact publisher destination accounts, with the SPL mint proven to be USDC.
7. Payer debit: the buyer's USDC balance must actually decrease by the quoted total.
8. Fail-closed retrieval: if any check fails, access to the paid response is blocked.

## Grounded Citation Rules
Every factual claim generated in CiteRail must carry an explicit footnote marker [^N] linking to the verified source index. Hallucinated or speculative citations are strictly forbidden. If a synthesis engine cannot produce at least one verifiable citation marker, the answer is withheld rather than published with invented provenance.

## Publisher Identity
A publisher wallet must prove ownership by signing a server-issued authentication challenge. Royalties are attributed only to wallets whose ownership has been cryptographically demonstrated.`,
    },
    {
      publisherWallet: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
      publisherName: 'Web3 AI Rights & Economics',
      title: 'Decentralized AI Knowledge Retrieval and Creator Rights Framework',
      fileType: 'md' as const,
      pricePerQueryUsdc: 0.04,
      rawText: `# Decentralized AI Knowledge Retrieval and Creator Rights Framework

## The Creator Compensation Crisis
Traditional generative AI platforms scrape and ingest vast corpora of creative and technical literature without attribution or royalty remuneration. This strips incentives for technical authors, researchers, and domain experts.

## Micro-Settlement Economics on High-Speed Blockchains
High-frequency micropayments were historically unviable on Ethereum due to variable gas spikes. Solana's sub-second block times and sub-cent fees enable true per-retrieval settlement where publishers receive instantaneous royalties (such as $0.05 USDC) every time their work directly informs an AI synthesis.

## Verifiable Audit Receipts
Every retrieval event produces a publicly verifiable receipt on Solana. Third-party auditors, creators, and consumers can query any transaction signature to confirm exact payment distribution, proving that creator compensation occurred on-chain.`,
    },
  ];

  for (const spec of documents) {
    try {
      const doc = await ingestDocument(spec);
      console.log(
        `Indexed document: ${doc.title} (${doc.total_chunks} chunks, ${doc.price_per_query_usdc} USDC/query)`
      );
    } catch (err: any) {
      if (err instanceof DuplicateDocumentError) {
        console.log(`Skipped (already published): ${spec.title}`);
      } else {
        throw err;
      }
    }
  }

  // The seed wallets are known demo publishers; mark them verified so they
  // appear as trusted in the publisher directory.
  const wallets = documents.map((d) => d.publisherWallet);
  await query(
    `UPDATE publishers SET verified_at = COALESCE(verified_at, NOW()) WHERE wallet_address = ANY($1::varchar[])`,
    [wallets]
  );
  for (const wallet of wallets) {
    await markPublisherVerified(wallet);
  }

  console.log('Knowledge base seeding completed successfully!');
}

seed()
  .then(async () => {
    await pool.end();
  })
  .catch((err) => {
    console.error('Seeding error:', err);
    process.exit(1);
  });
