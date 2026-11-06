import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import dotenv from 'dotenv';
import { config } from '../lib/config';
import { buildMemoPayload } from '../lib/protocol';

dotenv.config();

const USDC_MINT = new PublicKey(config.usdcMint);
const MEMO_PROGRAM_ID = new PublicKey(config.memoProgramId);

/**
 * Live Devnet verification.
 *
 * Confirms that the on-chain primitives CiteRail depends on are actually
 * present and behaving on the configured cluster:
 *   - the RPC endpoint is healthy
 *   - the settlement asset mint exists and has the expected 6 decimals
 *   - the Memo program is executable
 *   - a canonical CiteRail memo payload can be built
 *   - a transaction containing the memo simulates successfully
 *
 * Set DEVNET_FAUCET_KEYPAIR (base58 secret key) to additionally simulate a
 * real SPL USDC transfer with associated token account creation.
 */
async function verifyDevnet() {
  console.log('\n============ CITERAIL SOLANA DEVNET LIVE VERIFIER ============\n');
  console.log(`Cluster: ${config.solanaNetwork}`);
  console.log(`RPC URL: ${config.solanaRpcUrl}`);

  const connection = new Connection(config.solanaRpcUrl, 'confirmed');

  // 1. Cluster version & health check
  const version = await connection.getVersion();
  console.log(
    `\n[OK] Devnet RPC online - core version ${version['solana-core']}, feature set ${version['feature-set']}`
  );

  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  console.log(
    `[OK] Current slot ${slot} | mined ${blockTime ? new Date(blockTime * 1000).toISOString() : 'N/A'}`
  );

  // 2. Settlement asset (USDC) mint verification
  console.log(`\nVerifying settlement mint ${USDC_MINT.toBase58()}...`);
  try {
    const mintInfo = await getMint(connection, USDC_MINT);
    if (mintInfo.decimals !== 6) {
      console.error(
        `[FAIL] Expected USDC to have 6 decimals, found ${mintInfo.decimals}. ` +
          'Base-unit arithmetic in lib/protocol.ts assumes 6.'
      );
      process.exit(1);
    }
    console.log(`[OK] Mint verified on-chain - decimals ${mintInfo.decimals}`);
  } catch (err: any) {
    console.error(`[FAIL] Settlement mint lookup failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Memo program verification
  console.log(`\nVerifying Memo program ${MEMO_PROGRAM_ID.toBase58()}...`);
  const memoAccountInfo = await connection.getAccountInfo(MEMO_PROGRAM_ID);
  if (!memoAccountInfo?.executable) {
    console.error('[FAIL] Memo program is not executable on this cluster.');
    process.exit(1);
  }
  console.log('[OK] Memo program verified executable');

  // 4. Canonical memo payload
  const sampleMemo = buildMemoPayload({
    quoteId: 'q_test_12345',
    quoteNonce: 'f'.repeat(32),
    sourceDigest: 'a'.repeat(32),
  });
  console.log(`\nCanonical memo payload:\n    ${sampleMemo}`);
  if (!sampleMemo.startsWith('CITERAIL:QUOTE:')) {
    console.error('[FAIL] Memo payload does not use the CITERAIL:QUOTE format.');
    process.exit(1);
  }
  console.log('[OK] Memo payload format is correct');

  // 5. Transaction simulation
  console.log('\nSimulating an atomic CiteRail settlement transaction...');
  const dummyBuyer = Keypair.generate();
  const dummyPublisher = Keypair.generate();

  const tx = new Transaction();
  tx.add(
    new TransactionInstruction({
      keys: [{ pubkey: dummyBuyer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(sampleMemo, 'utf8'),
    })
  );

  const faucetKeypair = process.env.DEVNET_FAUCET_KEYPAIR;

  if (faucetKeypair) {
    // Full USDC path: create the recipient ATA and transfer USDC.
    const payer = Keypair.fromSecretKey(
      Buffer.from(
        faucetKeypair
          .split(',')
          .map((v) => Number(v))
          .map((v) => v & 0xff)
      )
    );

    const buyerAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
    const recipientAta = getAssociatedTokenAddressSync(
      USDC_MINT,
      dummyPublisher.publicKey
    );

    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        recipientAta,
        dummyPublisher.publicKey,
        USDC_MINT
      )
    );
    tx.add(
      createTransferInstruction(
        buyerAta,
        recipientAta,
        payer.publicKey,
        BigInt(50_000)
      )
    );
    tx.feePayer = payer.publicKey;

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    const simulation = await connection.simulateTransaction(tx);
    console.log(`[OK] USDC settlement simulation - units consumed: ${simulation.value.unitsConsumed}`);
    if (simulation.value.err) {
      console.error(`[FAIL] Simulation error: ${JSON.stringify(simulation.value.err)}`);
      process.exit(1);
    }
    (simulation.value.logs || []).forEach((log) => console.log(`      ${log}`));
  } else {
    // Structural path: memo + a native transfer keeps the simulation valid for
    // an unfunded throwaway keypair.
    tx.add(
      SystemProgram.transfer({
        fromPubkey: dummyBuyer.publicKey,
        toPubkey: dummyPublisher.publicKey,
        lamports: 50_000,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = dummyBuyer.publicKey;

    const simulation = await connection.simulateTransaction(tx);
    console.log(`[OK] Simulation succeeded - units consumed: ${simulation.value.unitsConsumed}`);
    if (simulation.value.err) {
      console.error(`[FAIL] Simulation error: ${JSON.stringify(simulation.value.err)}`);
      process.exit(1);
    }
    console.log(
      '     (Set DEVNET_FAUCET_KEYPAIR to additionally simulate a real SPL USDC transfer.)'
    );
  }

  console.log('\n============ LIVE DEVNET VERIFICATION COMPLETE ============\n');
}

verifyDevnet().catch((err) => {
  console.error('Live Devnet Verification Error:', err);
  process.exit(1);
});
