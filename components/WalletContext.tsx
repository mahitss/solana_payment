'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';

interface PublisherPayout {
  publisher_wallet: string;
  amount_usdc: string;
  amount_base_units: string;
}

interface WalletContextType {
  connected: boolean;
  publicKey: string | null;
  connectWallet: () => Promise<string | null>;
  disconnectWallet: () => void;
  /** Signs an arbitrary UTF-8 message. Used for the authentication challenge. */
  signMessage: (message: string) => Promise<string>;
  /**
   * Builds and submits the atomic settlement transaction: one memo instruction
   * binding the quote, plus one SPL USDC transfer per publisher.
   */
  sendSettlementTransaction: (params: {
    publisherBreakdown: PublisherPayout[];
    memoExpected: string;
  }) => Promise<string>;
}

const WalletContext = createContext<WalletContextType>({
  connected: false,
  publicKey: null,
  connectWallet: async () => null,
  disconnectWallet: () => {},
  signMessage: async () => '',
  sendSettlementTransaction: async () => '',
});

export const useWallet = () => useContext(WalletContext);

const DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DEVNET_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ||
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);
const MEMO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MEMO_PROGRAM_ID ||
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
);

function getProvider(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).solana ?? null;
}

/* ------------------------------------------------------------------ */
/* External wallet store                                                */
/* ------------------------------------------------------------------ */

/**
 * The connected wallet lives outside React - inside the browser wallet
 * extension. Modelling it as an external store lets the provider read it with
 * `useSyncExternalStore`, which is the React-recommended way to consume a
 * mutable external source.
 *
 * The two rejected alternatives both have real bugs:
 *   - `setState` inside an effect triggers a cascading render on mount, and
 *   - reading the provider during the initial render breaks hydration,
 *     because the server render has no wallet extension at all.
 */
type WalletListener = () => void;

const walletListeners = new Set<WalletListener>();

/** The last known wallet address. `null` means disconnected. */
let storePublicKey: string | null = null;

/** Guards against binding the provider's listeners more than once. */
let providerBound = false;

function notifyWalletListeners(): void {
  walletListeners.forEach((listener) => listener());
}

function readProviderKey(): string | null {
  const provider = getProvider();
  if (provider?.isConnected && provider.publicKey) {
    return provider.publicKey.toString();
  }
  return null;
}

function subscribeToWallet(listener: WalletListener): () => void {
  walletListeners.add(listener);

  const provider = getProvider();
  if (provider && !providerBound) {
    providerBound = true;

    provider.on?.('accountChanged', (account: any) => {
      storePublicKey = account ? account.toString() : null;
      notifyWalletListeners();
    });

    provider.on?.('disconnect', () => {
      storePublicKey = null;
      notifyWalletListeners();
    });
  }

  // Pick up a connection that was already established before this page load.
  const existing = readProviderKey();
  if (existing !== storePublicKey) {
    storePublicKey = existing;
    notifyWalletListeners();
  }

  return () => {
    walletListeners.delete(listener);
  };
}

function getWalletSnapshot(): string | null {
  return storePublicKey;
}

/**
 * The server has no wallet extension, so the server-side render is always the
 * disconnected state. Keeping this explicit guarantees that the first client
 * render matches the server HTML before the store picks up a live connection.
 */
function getServerWalletSnapshot(): string | null {
  return null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // Restore an existing Phantom connection and keep the UI in sync with the
  // wallet. Previously the app only read `isConnected` once on mount, so
  // disconnecting or switching accounts inside Phantom left the dashboard
  // showing a stale, connected wallet.
  const publicKey = useSyncExternalStore(
    subscribeToWallet,
    getWalletSnapshot,
    getServerWalletSnapshot
  );

  const connectWallet = useCallback(async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    const provider = getProvider();

    if (!provider) {
      window.open('https://phantom.app/', '_blank');
      alert('Please install the Phantom wallet extension to interact with CiteRail on Solana.');
      return null;
    }

    try {
      const resp = await provider.connect();
      const pubkey = resp.publicKey.toString();
      storePublicKey = pubkey;
      notifyWalletListeners();
      return pubkey;
    } catch (err: any) {
      console.error('Wallet connection error:', err);
      throw err;
    }
  }, []);

  const disconnectWallet = useCallback(() => {
    const provider = getProvider();
    if (provider) {
      provider.disconnect?.();
    }
    storePublicKey = null;
    notifyWalletListeners();
  }, []);

  const signMessage = useCallback(async (message: string): Promise<string> => {
    const provider = getProvider();
    if (!provider) {
      throw new Error('Solana wallet provider not found.');
    }
    if (!provider.publicKey) {
      throw new Error('Wallet is not connected.');
    }

    const encoded = new TextEncoder().encode(message);
    const signature = await provider.signMessage(encoded, 'utf8');

    // Phantom historically returned a Uint8Array; some wallets return base64.
    if (typeof signature === 'string') return signature;
    return Buffer.from(signature).toString('base64');
  }, []);

  const sendSettlementTransaction = useCallback(
    async ({
      publisherBreakdown,
      memoExpected,
    }: {
      publisherBreakdown: PublisherPayout[];
      memoExpected: string;
    }): Promise<string> => {
      const provider = getProvider();
      if (!provider) {
        throw new Error('Solana wallet provider not found.');
      }

      if (!provider.publicKey) {
        await connectWallet();
      }
      if (!provider.publicKey) {
        throw new Error('Wallet is not connected.');
      }

      const buyerPubkey = new PublicKey(provider.publicKey.toString());
      const connection = new Connection(DEVNET_RPC, 'confirmed');
      const tx = new Transaction();

      // 1. Memo instruction binding the transaction to this quote and to the
      //    exact source chunk digests that were priced.
      const memoIx = new TransactionInstruction({
        keys: [{ pubkey: buyerPubkey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoExpected, 'utf8'),
      });
      tx.add(memoIx);

      // 2. One SPL USDC transfer per publisher.
      //
      //    CiteRail settles exclusively in USDC. The previous implementation
      //    also offered a native SOL path that treated USDC base units as
      //    lamports 1:1, so a $0.05 quote moved 50,000 lamports (~0.00005 SOL)
      //    while the receipt displayed it as 0.0500 USDC.
      const buyerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, buyerPubkey);

      // The buyer needs a USDC account to pay from.
      const buyerAtaInfo = await connection.getAccountInfo(buyerAta);
      if (!buyerAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            buyerPubkey,
            buyerAta,
            buyerPubkey,
            DEVNET_USDC_MINT
          )
        );
      }

      for (const item of publisherBreakdown) {
        const targetPubkey = new PublicKey(item.publisher_wallet);
        const recipientAta = getAssociatedTokenAddressSync(
          DEVNET_USDC_MINT,
          targetPubkey
        );

        // Create the recipient's USDC account if it does not exist yet.
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

        const amount = BigInt(item.amount_base_units);
        if (amount === 0n || amount < 0n) {
          throw new Error(
            `Invalid payout amount for publisher ${item.publisher_wallet}.`
          );
        }

        tx.add(
          createTransferInstruction(buyerAta, recipientAta, buyerPubkey, amount)
        );
      }

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = buyerPubkey;

      // Sign and send through the connected wallet. Newer wallets expect the
      // transaction wrapped in an object; older ones expect the raw instance.
      let signature: string;
      try {
        const result = await provider.signAndSendTransaction({ transaction: tx });
        signature = result.signature ?? result;
      } catch {
        const result = await provider.signAndSendTransaction(tx);
        signature = result.signature ?? result;
      }

      if (!signature) {
        throw new Error('Wallet did not return a transaction signature.');
      }

      // Wait for on-chain confirmation before returning to the backend.
      await connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        'confirmed'
      );

      return signature;
    },
    [connectWallet]
  );

  const value = useMemo<WalletContextType>(
    () => ({
      connected: Boolean(publicKey),
      publicKey,
      connectWallet,
      disconnectWallet,
      signMessage,
      sendSettlementTransaction,
    }),
    [
      publicKey,
      connectWallet,
      disconnectWallet,
      signMessage,
      sendSettlementTransaction,
    ]
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
