'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';

interface WalletContextType {
  connected: boolean;
  publicKey: string | null;
  connectWallet: () => Promise<string | null>;
  disconnectWallet: () => void;
  sendSettlementTransaction: (params: {
    publisherBreakdown: Array<{
      publisher_wallet: string;
      amount_usdc: number;
      amount_base_units: number;
    }>;
    memoExpected: string;
    useUsdc?: boolean;
  }) => Promise<string>;
}

const WalletContext = createContext<WalletContextType>({
  connected: false,
  publicKey: null,
  connectWallet: async () => null,
  disconnectWallet: () => {},
  sendSettlementTransaction: async () => '',
});

export const useWallet = () => useContext(WalletContext);

const DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DEVNET_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);
const MEMO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).solana?.isPhantom) {
      if ((window as any).solana.isConnected && (window as any).solana.publicKey) {
        setPublicKey((window as any).solana.publicKey.toString());
      }
    }
  }, []);

  const connectWallet = async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    const provider = (window as any).solana;

    if (!provider) {
      window.open('https://phantom.app/', '_blank');
      alert('Please install the Phantom wallet extension to interact with CiteRail on Solana.');
      return null;
    }

    try {
      const resp = await provider.connect();
      const pubkey = resp.publicKey.toString();
      setPublicKey(pubkey);
      return pubkey;
    } catch (err: any) {
      console.error('Wallet connection error:', err);
      throw err;
    }
  };

  const disconnectWallet = () => {
    if (typeof window !== 'undefined' && (window as any).solana) {
      (window as any).solana.disconnect();
    }
    setPublicKey(null);
  };

  const sendSettlementTransaction = async ({
    publisherBreakdown,
    memoExpected,
    useUsdc = false,
  }: {
    publisherBreakdown: Array<{
      publisher_wallet: string;
      amount_usdc: number;
      amount_base_units: number;
    }>;
    memoExpected: string;
    useUsdc?: boolean;
  }): Promise<string> => {
    if (typeof window === 'undefined' || !(window as any).solana) {
      throw new Error('Solana wallet provider not found.');
    }

    const provider = (window as any).solana;
    if (!provider.publicKey) {
      await connectWallet();
    }

    const buyerPubkey = new PublicKey(provider.publicKey.toString());
    const connection = new Connection(DEVNET_RPC, 'confirmed');

    const tx = new Transaction();

    // 1. Add Memo Instruction binding quote & source digests
    const memoIx = new TransactionInstruction({
      keys: [{ pubkey: buyerPubkey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoExpected, 'utf8'),
    });
    tx.add(memoIx);

    // 2. Add Payment Transfer Instructions
    for (const item of publisherBreakdown) {
      const targetPubkey = new PublicKey(item.publisher_wallet);

      if (useUsdc) {
        // Devnet USDC SPL Token Transfer
        const buyerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, buyerPubkey);
        const recipientAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, targetPubkey);

        // Check if recipient ATA exists; if not, create it
        const recipientAccountInfo = await connection.getAccountInfo(recipientAta);
        if (!recipientAccountInfo) {
          tx.add(
            createAssociatedTokenAccountInstruction(
              buyerPubkey,
              recipientAta,
              targetPubkey,
              DEVNET_USDC_MINT
            )
          );
        }

        const splTransferIx = createTransferInstruction(
          buyerAta,
          recipientAta,
          buyerPubkey,
          BigInt(item.amount_base_units)
        );
        tx.add(splTransferIx);
      } else {
        // Native SOL transfer on Devnet (1 USDC = 0.0005 SOL or base lamports)
        // Ensure minimum 10,000 lamports per publisher
        const lamports = Math.max(10_000, item.amount_base_units);
        const solTransferIx = SystemProgram.transfer({
          fromPubkey: buyerPubkey,
          toPubkey: targetPubkey,
          lamports,
        });
        tx.add(solTransferIx);
      }
    }

    // Set recent blockhash and fee payer
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = buyerPubkey;

    // Sign & Send through connected Phantom wallet
    const { signature } = await provider.signAndSendTransaction(tx);

    // Wait for on-chain confirmation before returning to backend
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
  };

  return (
    <WalletContext.Provider
      value={{
        connected: Boolean(publicKey),
        publicKey,
        connectWallet,
        disconnectWallet,
        sendSettlementTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
