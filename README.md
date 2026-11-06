# CiteRail

**Licensed knowledge retrieval with verifiable, atomic creator royalties on Solana Devnet.**

CiteRail is a Next.js 14 (App Router) + TypeScript application that sells access to a
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
    |                            breakdown, memo payload)
    |                                      |
    |                                      v
    |                            Phantom signs the memo + the USDC
    |                            transfers to each publisher ATA
    |                                      |
    |                                      v
    |                            POST /api/settle { quoteId, txSignature }
    |                                      |
    |                                      v
    |                            on-chain verification (10 checks)
    |                                      |
    |                                      v
    |                            atomic COMMIT: receipt row + quote REDEEMED
    |                            + settlement_payouts royalty ledger
    |                                      |
    |                                      v
    |                            AI grounding -> answer + citations + receipt
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
| Framework | Next.js 14 (App Router), React 18, TypeScript 5.7 (strict) |
| Runtime | Node.js 20 |
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

- **Node.js 20+**
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
| `POST` | `/api/quotes` | No | Run full-text retrieval and return a payment quote (no payment is taken yet). Body: `{ query, buyerWallet }`. Returns `found: false` and no quote when nothing matches. |
| `POST` | `/api/settle` | No | Verify an on-chain payment against a quote; on success return the grounded answer, citations and receipt. Body: `{ quoteId, txSignature, buyerWallet }`. Idempotent for an already-settled quote. |
| `POST` | `/api/documents` | **Yes** — `Authorization: Bearer <token>` | Ingest a PDF or Markdown document for the authenticated publisher. Accepts `multipart/form-data` or a JSON body. The publisher wallet is taken from the session token, never from the body. |
| `GET` | `/api/documents` | No | Public catalogue listing. Optional `?limit=` (1–200, default 100). |
| `GET` | `/api/publishers` | No | Public publisher directory (contact e-mail addresses are not exposed). |
| `POST` | `/api/publishers` | **Yes** — `Authorization: Bearer <token>` | Register or update the publisher profile for the authenticated wallet. Body: `{ walletAddress, name, email }`; `walletAddress` must match the session wallet. |
| `GET` | `/api/publisher/economics` | **Yes** — `Authorization: Bearer <token>` | Publisher royalty dashboard: documents, total revenue, query count and the settlement ledger for the **authenticated** wallet only. The wallet comes from the session token; a `?wallet=` parameter is not honoured. |
| `GET` | `/api/receipts/:signature` | No | Public receipt verifier: settlement receipt, verified per-publisher breakdown, expected memo and citations for a transaction signature. |

The bearer token is obtained from `POST /api/auth/verify` and must be sent as
`Authorization: Bearer <token>`. For publisher write routes the token's wallet is the
identity: it must match the wallet being credited, so a caller cannot publish under
somebody else's address and collect their royalties.

---

## Security Model

### Verify before deliver

CiteRail never releases paid content on the client's word. The consumer pays on-chain
first, and the server independently fetches the transaction from Solana Devnet and
validates it. Only when every check passes does the server read the purchased chunks,
generate the answer and persist a receipt. The quote is marked `REDEEMED` and the
receipt is written in a single database transaction, so a crash can never leave a quote
redeemed without a matching receipt (or the other way around).

### The seven verification checks

Every settlement transaction is put through seven core checks before any content is
served:

1. **Signature format** — the supplied signature must be a plausible Solana transaction
   signature (length enforced) before any network call is made.
2. **Replay protection** — the signature must not already exist in
   `settlement_receipts`, and the quote must still be `PENDING`. The quote redemption
   itself is a conditional `UPDATE ... WHERE status = 'PENDING'`, so two concurrent
   redemptions of the same quote cannot both succeed. The same rule protects auth
   challenges, whose nonce is burned with a conditional `UPDATE` so two concurrent
   verifications cannot both succeed either.
3. **On-chain success** — the transaction's `meta.err` must be null, i.e. the chain
   actually executed it rather than aborting it.
4. **Quote expiry versus block time** — the transaction's block time is compared
   against the quote's expiry (with a 60-second clock tolerance). A payment mined after
   the quote expired is rejected with `QUOTE_EXPIRED`.
5. **Payer match** — the transaction's fee payer must be the expected buyer wallet, so
   a third party cannot pay someone else's quote and claim the answer.
6. **Exact memo binding** — a Memo program instruction must contain exactly the
   expected payload `CITERAIL:QUOTE:<quote_id>:<quote_nonce>:<source_digest>`. The
   comparison is exact string equality, not a substring match, so a buyer cannot
   append extra data to the memo. The quote id, the per-quote nonce and the SHA-256
   digest of the priced chunk hashes together bind the payment to this quote and to
   precisely the sources that were priced.
7. **Per-publisher transfer amount and mint check** — every publisher in the quote's
   breakdown must have received at least their quoted amount, in USDC base units, at
   their associated token account for the configured mint. Settlement is exclusively in
   SPL USDC: native SOL transfers are not accepted, because comparing lamports against
   USDC base units would let a 50,000-lamport transfer count as a $0.05 payment. The
   mint is proven either from `transferChecked` or from the source ATA, and the
   pre/post token balance delta is used as an independent cross-check.

Three further settlement-integrity checks close the remaining gaps:

8. **No unexpected outflows** — every USDC transfer in the transaction must go to a
   publisher that was actually priced, so a buyer cannot bundle extra USDC outflows
   into the same atomic transaction.
9. **The payer was debited** — the buyer's USDC balance must actually have fallen by
   at least the quoted total.
10. **The total covers the quote** — the sum of the verified per-publisher amounts must
    be at least the quoted total, recomputed in integer base units from the breakdown
    rather than trusted from the stored decimal.

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
payment is never silently "refunded" by pretending it succeeded. The grounding prompt
also forbids citations outside the supplied chunk range and instructs the model to say
so explicitly when the licensed sources do not contain enough information.

### Other measures

- Publisher write routes (`POST /api/documents`, `POST /api/publishers`) and the
  royalty dashboard derive the publisher identity from the **session token**, never
  from the request body or a query parameter.
- Session tokens are HMAC-SHA256 signed envelopes compared with `timingSafeEqual`; the
  signing secret must be at least 32 characters and is mandatory in production.
- Wallet addresses are validated as base58 public keys before they are stored or used.
- Upload size and query length are bounded by `MAX_UPLOAD_BYTES` and
  `MAX_QUERY_LENGTH`, and queries that match nothing are never quoted or charged.
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
