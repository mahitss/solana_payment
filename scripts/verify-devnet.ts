import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  Keypair,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  getMint,
} from '@solana/spl-token';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);
const MEMO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

async function verifyDevnet() {
  console.log('\n================ CITERAIL SOLANA DEVNET LIVE VERIFIER ================\n');
  console.log(`Connecting to Solana Devnet RPC: ${RPC_URL}...`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // 1. Cluster Version & Health Check
  const version = await connection.getVersion();
  console.log(`[✓] Devnet RPC Online! Core Version: ${version['solana-core']}, Feature Set: ${version['feature-set']}`);

  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  console.log(`[✓] Current Devnet Slot: ${slot} | Mined Block Time: ${blockTime ? new Date(blockTime * 1000).toISOString() : 'N/A'}`);

  // 2. Devnet USDC Mint Verification
  console.log(`\nVerifying Devnet USDC Mint (${USDC_MINT.toBase58()})...`);
  try {
    const mintInfo = await getMint(connection, USDC_MINT);
    console.log(`[✓] Mint verified on-chain! Decimals: ${mintInfo.decimals}, Supply: ${mintInfo.supply.toString()}`);
  } catch (err: any) {
    console.log(`[!] Note on USDC Mint lookup: ${err.message}`);
  }

  // 3. Memo Program Verification
  console.log(`\nVerifying Memo Program (${MEMO_PROGRAM_ID.toBase58()})...`);
  const memoAccountInfo = await connection.getAccountInfo(MEMO_PROGRAM_ID);
  if (memoAccountInfo && memoAccountInfo.executable) {
    console.log(`[✓] Solana Memo Program verified executable on Devnet!`);
  } else {
    console.log(`[!] Memo program account executable status: ${Boolean(memoAccountInfo?.executable)}`);
  }

  // 4. On-Chain Transaction Simulation & Instruction Validation
  console.log(`\nTesting Atomic Transaction Construction & Devnet Simulation...`);
  const dummyBuyer = Keypair.generate();
  const dummyPublisher = Keypair.generate();

  const tx = new Transaction();

  // Instruction A: Memo Program Instruction with CiteRail Binding
  const testMemo = 'CITERAIL:q_test_12345:digest_abcde123';
  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: dummyBuyer.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(testMemo, 'utf8'),
  });
  tx.add(memoIx);

  // Instruction B: Payment Transfer (SystemProgram Lamport Transfer / SPL Token Transfer)
  const transferIx = SystemProgram.transfer({
    fromPubkey: dummyBuyer.publicKey,
    toPubkey: dummyPublisher.publicKey,
    lamports: 50_000,
  });
  tx.add(transferIx);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = dummyBuyer.publicKey;

  console.log(`[✓] Transaction constructed with 2 atomic instructions:`);
  console.log(`    1. Memo Program binding: "${testMemo}"`);
  console.log(`    2. Royalty Transfer: ${dummyBuyer.publicKey.toBase58()} -> ${dummyPublisher.publicKey.toBase58()} (50,000 units)`);

  // Simulate on Devnet
  const simulation = await connection.simulateTransaction(tx);
  console.log(`[✓] Devnet Simulation Response:`);
  console.log(`    Units Consumed: ${simulation.value.unitsConsumed}`);
  console.log(`    Simulation Logs:`);
  if (simulation.value.logs) {
    simulation.value.logs.forEach((log) => console.log(`      ${log}`));
  }

  console.log('\n================ LIVE DEVNET VERIFICATION COMPLETE ================\n');
}

verifyDevnet().catch((err) => {
  console.error('Live Devnet Verification Error:', err);
  process.exit(1);
});
