# CiteRail

**Licensed knowledge retrieval with verifiable, atomic creator royalties on Solana Devnet.**

CiteRail is a Next.js 16 (App Router) + TypeScript application that sells access to a
catalog of licensed documents. Publishers upload their work and set a per-query price;
consumers ask a question, receive a price quote, pay with devnet USDC from Phantom, and
only then receive a grounded answer with citations. Every settlement is verified
server-side against the Solana Devnet chain before a single word of paid content is
released, and the resulting receipt is publicly auditable.

---

## Features

- **Wallet-signature publisher auth** — sign-in-with-Solana style challenge/response. The
  publisher proves ownership of an Ed25519 key by signing a server-issued nonce, which
  burns the challenge and returns an HMAC-signed bearer session token.
- **Document ingestion with sliding-window chunking + SHA-256 integrity** — PDFs and
  Markdown are normalised, split into overlapping ~400-token chunks, and hashed with
  SHA-256 at both the document and chunk level. The hashes are what gets priced and
  what gets cited.
- **PostgreSQL full-text retrieval** — chunks are indexed with a `tsvector` search
  vector and ranked with `ts_rank_cd`, with an `ILIKE` fallback for partial matches.
  If nothing relevant matches, no quote is issued and nothing is charged.
- **On-chain quote → memo-bound payment → fail-closed verification → grounded cited
  answer** — a quote is priced per publisher, the payment memo binds the transaction to
  the exact quote and source digest, the chain state is verified server-side, and the
  AI answer is produced only from the purchased chunks.
- **Immutable source snapshots** — every priced chunk's exact text is snapshotted at
  quote time and re-verified by SHA-256 at settlement, before *and* after the on-chain
  check, so modified content can never be delivered under a valid receipt.
- **Buyer-bound quotes** — a quote records the authenticated buyer, and only that
  wallet can redeem the answer, so a third party who observes a transaction signature
  cannot claim it.
- **Prompt-injection isolation and fail-closed citations** — publisher content is
  sanitised and delimited as untrusted data before it reaches the model, and an answer
  without verifiable `[^N]` markers is withheld rather than published with fabricated
  provenance.
- **Atomic, idempotent settlement** — the receipt, the quote redemption and the
  normalised per-publisher payout ledger are written in one database transaction.
  Re-posting an already settled quote returns the existing receipt (regenerating the
  answer if generation failed) instead of charging the consumer twice.
- **Public receipt verifier** — `GET /api/receipts/:signature` returns the settlement
  receipt, the per-publisher breakdown, the memo payload and the citations for any
  transaction, with no authentication required.
- **Publisher royalty dashboard** — an authenticated publisher sees their own
  documents, total revenue, query count and a full settlement ledger keyed by
  transaction signature. The wallet is taken from the session token, never from a
  request parameter, so one publisher can never read another's earnings.

---

## Architecture

```text
                            CiteRail request flow
 ============================================================================
  PUBLISHER
    |
    |  POST /api/auth/challenge  ->  sign the nonce  ->  POST /api/auth/verify
    |       (returns a Bearer session token bound to the wallet)
    |
    |  POST /api/documents
    |       -> ingestDocument -> chunkText (sliding window) -> SHA-256
    |       -> Postgres (publishers, documents, document_chunks)
    |       (the publisher wallet comes from the session token, not the body)
    v
  Postgres  <--- FTS retrieval ---  POST /api/quotes  <---  CONSUMER
    |                                      |
    |                                      v
    |                            payment quote (expiry, per-publisher
    |                            breakdown, memo payload, buyer binding
    |                            + immutable source snapshots)
    |                                      |
    |                                      v
    |                            Phantom signs the memo + the USDC
    |                            transfers to each publisher ATA
    |                                      |
    |                                      v
    |                            POST /api/settle { quoteId, txSignature }
    |                                      |
    |                                      v
    |                            source integrity check (SHA-256 + digest)
    |                                      |
    |                                      v
    |                            on-chain verification (10 checks)
    |                                      |
    |                                      v
    |                            atomic COMMIT: receipt row + quote REDEEMED
    |                            + settlement_payouts royalty ledger
    |                                      |
    |                                      v
    |                            source integrity re-check
    |                            -> AI grounding -> answer + citations + receipt
    |                                      |
    +--------------------------------------+-------------------->  AUDITOR
                                                                   GET /api/receipts/:signature
                                                                   -> public receipt + citations
```

**Publisher path.** `POST /api/documents` → `ingestDocument` → `chunkText` → SHA-256 →
PostgreSQL. The document hash and every chunk hash are stored alongside the price.

**Consumer path.** `POST /api/quotes` → full-text retrieval → payment quote → Phantom
signs (memo + transfers) → `POST /api/settle` → on-chain verification → AI grounding →
answer + citations + receipt.

**Auditor path.** `GET /api/receipts/:signature` → the stored receipt, the verified
per-publisher breakdown, the expected memo payload and the citations.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript 5.7 (strict) |
| Runtime | Node.js 22 |
| Database | PostgreSQL via Neon, accessed with `pg`; native FTS (`tsvector` / `ts_rank_cd`) |
| Blockchain | Solana Devnet — `@solana/web3.js`, `@solana/spl-token` |
| Settlement asset | SPL USDC on Devnet (6 decimals, integer base units) |
| AI providers | Ollama (local, default) and Google Gemini (`gemini-2.0-flash` fallback) |
| Auth | Ed25519 wallet-signature challenge/response, HMAC-SHA256 session tokens |
| PDF parsing | `pdf-parse` (externalised from the server bundle) |
| Styling | Tailwind CSS 3.4 (near-black surfaces, `#9945FF` purple, `#14F195` emerald) |
| Deployment | Render blueprint (`render.yaml`) |
| CI | GitHub Actions (typecheck → lint → build) |

---

## Getting Started

### Prerequisites

- **Node.js 22+**
- **PostgreSQL 14+** — a local instance or a hosted one such as Neon. Hosted providers
  require `sslmode=require` in the connection string.
- **Ollama** *(optional)* — a local Ollama server for grounded answers. Alternatively set
  `GEMINI_API_KEY`. If neither provider is reachable, the API fails closed and refuses
  to release a paid answer.

### Steps

```bash
git clone <repository-url>
cd citerail
npm install
cp .env.example .env          # then edit DATABASE_URL (and AUTH_SECRET)
npm run db:migrate            # create the schema
npm run db:seed               # optional: demo publishers and documents
npm run dev                   # http://localhost:3000
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm test` | Runs the test suite (44 tests). Database-backed tests are skipped automatically when `DATABASE_URL` is not set. Set `RUN_NETWORK_TESTS=1` to additionally exercise live Devnet verification. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint (flat config, ESLint 9). |
| `npm run verify:devnet` | Live Devnet check: RPC health, USDC mint decimals, Memo program executability and a settlement simulation. |

For production:

```bash
npm run build
npm run start
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill it in. Never commit a populated `.env`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | – | PostgreSQL connection string. Neon and other hosted providers expect `sslmode=require`; TLS certificate verification stays enabled. |
| `AUTH_SECRET` | Yes in production | ephemeral per-process secret in development | HMAC-SHA256 key used to sign publisher session tokens. Minimum 32 characters. Generate with `openssl rand -hex 32`. |
| `SESSION_TTL_SECONDS` | No | `43200` | Lifetime of an issued publisher session token (12 hours). |
| `AUTH_CHALLENGE_TTL_SECONDS` | No | `300` | Lifetime of a single-use wallet authentication challenge (5 minutes). |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | No | `https://api.devnet.solana.com` | Solana JSON-RPC endpoint used server-side to fetch and verify transactions. |
| `NEXT_PUBLIC_SOLANA_NETWORK` | No | `devnet` | Cluster label used when building Solana Explorer links. |
| `NEXT_PUBLIC_USDC_MINT` | No | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | SPL mint address of the settlement asset (USDC on Solana Devnet). |
| `NEXT_PUBLIC_MEMO_PROGRAM_ID` | No | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | Memo program used to bind a payment transaction to its quote. |
| `OLLAMA_BASE_URL` | No | `http://127.0.0.1:11434` | Base URL of the Ollama instance used for grounded answer generation. |
| `OLLAMA_MODEL` | No | `gemma3:4b` | Ollama model tag to use. |
| `GEMINI_API_KEY` | No | – | Google Gemini API key. When present it is preferred over Ollama. |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model id used for grounded answer generation. |
| `AI_REQUEST_TIMEOUT_MS` | No | `60000` | Timeout for outbound AI provider requests, in milliseconds. |
| `QUOTE_EXPIRY_SECONDS` | No | `300` | How long a payment quote stays valid (5 minutes). |
| `MAX_UPLOAD_BYTES` | No | `10485760` | Maximum accepted upload size in bytes (10 MiB). |
| `MAX_QUERY_LENGTH` | No | `2000` | Maximum accepted query length in characters. |

---

## API Reference

All routes are JSON endpoints. Errors are returned as `{ "success": false, "error": "…" }`
with a meaningful HTTP status.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/challenge` | No | Issue a single-use nonce and the canonical message a wallet must sign. Body: `{ wallet }`. |
| `POST` | `/api/auth/verify` | No | Verify the Ed25519 signature, burn the nonce and return a bearer session token. Body: `{ wallet, message, signature }`. |
| `POST` | `/api/quotes` | **Yes** — `Authorization: Bearer <token>` | Run full-text retrieval and return a payment quote (no payment is taken yet). Body: `{ query }`. The buyer wallet is taken from the session token, never from the body, and is bound to the quote so only that wallet can redeem it. Returns `found: false` and no quote when nothing matches. |
| `POST` | `/api/settle` | **Yes** — `Authorization: Bearer <token>` | Verify an on-chain payment against a quote; on success return the grounded answer, citations and receipt. Body: `{ quoteId, txSignature }`. The expected payer is derived from the session token, so a third party who observes a transaction signature cannot claim the answer. Idempotent for an already-settled quote. |
| `POST` | `/api/documents` | **Yes** — `Authorization: Bearer <token>` | Ingest a PDF or Markdown document for the authenticated publisher. Accepts `multipart/form-data` or a JSON body. The publisher wallet is taken from the session token, never from the body. |
| `GET` | `/api/documents` | No | Public catalogue listing. Optional `?limit=` (1–200, default 100). |
| `GET` | `/api/publishers` | No | Public publisher directory (contact e-mail addresses are not exposed). |
| `POST` | `/api/publishers` | **Yes** — `Authorization: Bearer <token>` | Register or update the publisher profile for the authenticated wallet. Body: `{ walletAddress, name, email }`; `walletAddress` must match the session wallet. |
| `GET` | `/api/publisher/economics` | **Yes** — `Authorization: Bearer <token>` | Publisher royalty dashboard: documents, total revenue, query count and the settlement ledger for the **authenticated** wallet only. The wallet comes from the session token; a `?wallet=` parameter is not honoured. |
| `GET` | `/api/receipts/:signature` | No | Public receipt verifier: settlement receipt, verified per-publisher breakdown, expected memo and citations for a transaction signature. |

The bearer token is obtained from `POST /api/auth/verify` and must be sent as
`Authorization: Bearer <token>`. For every authenticated route the token's wallet is the
identity: it must match the wallet being credited or charged, so a caller cannot publish
under somebody else's address, read another publisher's earnings, or redeem an answer
that they did not pay for.

---

## Security Model

### Verify before deliver

CiteRail never releases paid content on the client's word. The consumer pays on-chain
first, and the server independently fetches the transaction from Solana Devnet and
validates it. Only when every check passes does the server read the purchased chunks,
generate the answer and persist a receipt. The quote is marked `REDEEMED` and the
receipt is written in a single database transaction, so a crash can never leave a quote
redeemed without a matching receipt (or the other way around).

### The ten verification checks

Every settlement transaction is put through ten checks before any content is served.
All of them fail closed: any doubt means the paid content is not released.

1. **Signature format** — the supplied signature must be a plausible Solana transaction
   signature (length enforced) before any network call is made.
2. **Replay protection** — the signature must not already exist in
   `settlement_receipts`, and the quote must still be `PENDING`. The quote redemption
   itself is a conditional `UPDATE ... WHERE status = 'PENDING'`, so two concurrent
   redemptions of the same quote cannot both succeed. The same rule protects auth
   challenges, whose nonce is burned with a conditional `UPDATE` so two concurrent
   verifications cannot both succeed either.
3. **On-chain success** — the transaction's `meta.err` must be null, i.e. the chain
   actually executed it rather than aborting it. Missing metadata is rejected outright
   rather than treated as success.
4. **Quote expiry versus block time** — the transaction's block time is compared
   against the quote's expiry (with a 60-second clock tolerance). A payment mined after
   the quote expired is rejected with `QUOTE_EXPIRED`.
5. **Payer match** — the transaction's fee payer must be the authenticated buyer, so
   a third party cannot pay someone else's quote and claim the answer.
6. **Exact memo binding** — a Memo program instruction must contain exactly the
   expected payload `CITERAIL:QUOTE:<quote_id>:<quote_nonce>:<source_digest>`. The
   comparison is exact string equality, not a substring match, so a buyer cannot
   append extra data to the memo. The quote id, the per-quote nonce and the SHA-256
   digest of the priced chunk hashes together bind the payment to this quote and to
   precisely the sources that were priced.
7. **Per-publisher amount and mint check** — every publisher in the quote's breakdown
   must have received **exactly** their quoted amount, in USDC base units, at their
   associated token account for the configured mint. Underpayment *and* overpayment are
   both rejected. Settlement is exclusively in SPL USDC: native SOL transfers are not
   accepted, because comparing lamports against USDC base units would let a
   50,000-lamport transfer count as a $0.05 payment. The mint is proven from the token
   balance metadata of **both** the source and the destination account, so an
   unchecked `transfer` cannot smuggle a different token through the same accounts.

8. **No unexpected outflows** — every USDC transfer in the transaction must go to a
   publisher that was actually priced, so a buyer cannot bundle extra USDC outflows
   into the same atomic transaction.
9. **No third-party funding** — a priced publisher's account may only be credited by
   the buyer's own USDC account. A third party topping up a publisher's ATA inside the
   same transaction is rejected with `THIRD_PARTY_FUNDING`.
10. **The payer was debited exactly** — the buyer's USDC token account must have
    fallen by exactly the quoted total, and the sum of the verified per-publisher
    amounts must equal the quote total. Both are recomputed in integer base units from
    the breakdown rather than trusted from the stored decimal, and any unexpected
    incoming transfer to the buyer's account is rejected as well.

### Source integrity is verified before and after settlement

When a quote is priced, the exact text of every purchased chunk is written to an
immutable `payment_quote_sources` snapshot table (write-once, never exposed through a
public API). At settlement time the server:

1. loads the quoted chunk IDs and checks the count matches exactly — no partial
   fulfilment is possible;
2. re-hashes every chunk's content with SHA-256 and compares it against the stored
   hash, so modified content is detected;
3. recomputes the combined source digest and compares it against the digest committed
   to in the memo, proving the delivered sources are the priced sources; and
4. repeats the hash and digest checks **after** the on-chain verification and before
   the answer is generated, closing the window between verification and delivery.

If any of these fail, no settlement is recorded (before) or the receipt is recorded
but no answer is produced (after), and the consumer is told explicitly which happened.

### Money is handled as integers

All amounts are computed and compared as integer USDC base units (6 decimals), never as
floating-point decimals. A quote's total is recomputed from its per-publisher breakdown
when it is loaded, so a corrupted or hand-edited row can never cause an under-payment
to slip through.

### Atomic and idempotent settlement

The receipt, the quote redemption and a normalised `settlement_payouts` royalty ledger
(one row per publisher per receipt) are written inside a single database transaction.
If the write fails, everything rolls back — a quote can never end up redeemed without a
matching receipt, or the other way around.

Settlement is also idempotent. `POST /api/settle` verifies and records the payment
*first*, then generates the answer. If generation fails the payment is still settled
and recorded, and re-posting the same quote returns the existing receipt and produces
the answer without charging the consumer a second time.

### The AI fails closed

Grounded generation is only attempted through a provider that has been positively
probed. If neither Gemini (configured `GEMINI_API_KEY`) nor Ollama (reachable at
`OLLAMA_BASE_URL` with at least one model) responds, the provider factory throws and
the request fails — no answer is invented, no partial answer is returned, and the
payment is never silently "refunded" by pretending it succeeded. Outbound provider
calls are also bounded by `AI_REQUEST_TIMEOUT_MS`, so a hung inference server cannot
hold a request open indefinitely.

**Prompt injection is neutralised.** Publisher documents are attacker-controlled, so
every chunk is sanitised before it enters the prompt: ANSI escape sequences and
control characters are stripped, zero-width characters are removed, Markdown
structural prefixes (`>`, `#`) are collapsed, and lines that look like role or system
instructions (`system:`, `ignore all previous instructions`, `you are now`, and
similar) are prefixed with `[REDACTED-INSTRUCTION]`. Each source is then wrapped in
explicit `---BEGIN/END UNTRUSTED SOURCE n---` delimiters — and any attempt to forge
those delimiters inside the content is neutralised too — under a preamble that states
the enclosed regions are untrusted data and must never be followed as instructions.
The user query is sanitised the same way.

**Citations fail closed.** The citation marker grammar is strict: only `[^N]` counts,
and `N` must be within `1..N` for the number of sources actually supplied. A bare
`[N]` is deliberately not accepted, because models emit it by accident and it
collides with ordinary Markdown. If the model returns an answer with no valid
citation marker, the request **fails** rather than publishing the answer with
fabricated provenance — the previous behaviour silently marked every chunk as
"cited", which would have presented ungrounded claims as verified. The grounding
prompt also forbids citations outside the supplied chunk range and instructs the model
to say so explicitly when the licensed sources do not contain enough information.

### Other measures

- Every authenticated route (`POST /api/quotes`, `POST /api/settle`,
  `POST /api/documents`, `POST /api/publishers`, `GET /api/publisher/economics`)
  derives the wallet identity from the **session token**, never from the request
  body or a query parameter. A quote is bound to the buyer at creation time, so only
  the wallet that paid can redeem the answer.
- Session tokens are HMAC-SHA256 signed envelopes compared with `timingSafeEqual`; the
  signing secret must be at least 32 characters and is mandatory in production.
- Wallet addresses are validated as base58 public keys before they are stored or used.
- Upload size and query length are bounded by `MAX_UPLOAD_BYTES` and
  `MAX_QUERY_LENGTH`, and queries that match nothing are never quoted or charged.
- Retrieval enforces a relevance floor: a chunk is only priced if it actually matches
  the query, and there is no fallback that returns unrelated recent content.
- Every settlement receipt is public by design: the payment is provable on-chain, so
  the receipt, the per-publisher breakdown and the citations are readable by anyone
  holding the transaction signature.
- Response headers set `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` and `Permissions-Policy` on every route.
- Secrets live only in the environment. `render.yaml` references them with
  `sync: false`, and `.env` files are git-ignored.

---

## Deployment

CiteRail ships with a [Render](https://render.com) blueprint in `render.yaml`:

- Service type `web`, runtime `node`, plan `starter`, service name `citerail`.
- Build command `npm install && npm run build`, start command `npm run start`.
- Public Solana configuration (Devnet RPC, network label, USDC mint, memo program) is
  declared in the blueprint.

### Secrets

`DATABASE_URL`, `AUTH_SECRET` and `GEMINI_API_KEY` are declared with `sync: false`, so
Render prompts for them on the first deploy instead of reading them from the
repository. Set them in the **Render dashboard → Environment** panel:

- `DATABASE_URL` — the Neon (or other) connection string, including
  `?sslmode=require`.
- `AUTH_SECRET` — generate with `openssl rand -hex 32`.
- `GEMINI_API_KEY` — optional; only needed if you do not run your own Ollama.

**Never commit credentials.** If `OLLAMA_BASE_URL` points at a private instance, update
it from the dashboard as well — the blueprint only carries a public, non-secret
placeholder.

---

## License

CiteRail is currently **all rights reserved**. The package is marked `"private": true`
and no open-source licence has been granted. Add a `LICENSE` file before redistributing
or publishing the code.
