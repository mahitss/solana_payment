'use client';

import React, { useState, useEffect } from 'react';
import { WalletProvider, useWallet } from '@/components/WalletContext';
import {
  Search,
  BookOpen,
  DollarSign,
  ShieldCheck,
  ExternalLink,
  UploadCloud,
  FileText,
  Clock,
  Sparkles,
  Layers,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Copy,
  Terminal,
} from 'lucide-react';

interface MatchedSourcePreview {
  source_index: number;
  document_title: string;
  publisher_name: string;
  publisher_wallet: string;
  price_usdc: string;
  preview_snippet: string;
}

interface QuoteData {
  id: string;
  quoteNonce: string;
  totalPriceUsdc: number;
  totalBaseUnits: number;
  memoExpected: string;
  expiresAt: string;
  publisherBreakdown: Array<{
    publisher_id: string;
    publisher_wallet: string;
    publisher_name: string;
    document_title: string;
    chunk_ids: string[];
    amount_usdc: number;
    amount_base_units: number;
  }>;
}

interface Citation {
  citation_index: number;
  chunk_id: string;
  document_title: string;
  publisher_wallet: string;
  publisher_name: string;
  content_hash: string;
  snippet: string;
}

function CiteRailDashboard() {
  const {
    connected,
    publicKey,
    connectWallet,
    disconnectWallet,
    signMessage,
    sendSettlementTransaction,
  } = useWallet();
  const [activeTab, setActiveTab] = useState<'consumer' | 'publisher' | 'verifier'>('consumer');

  // Wallet-based session. The token is what proves to the server that this
  // browser controls the connected wallet; publishing and reading private
  // publisher economics both require it.
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authWallet, setAuthWallet] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Consumer Query State
  const [queryInput, setQueryInput] = useState('');
  const [isQuoting, setIsQuoting] = useState(false);
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [sourcesPreview, setSourcesPreview] = useState<MatchedSourcePreview[]>([]);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const [answerData, setAnswerData] = useState<{
    answer: string;
    citations: Citation[];
    provider: string;
    model: string;
    receipt: any;
  } | null>(null);

  // Publisher State
  const [publisherWalletInput, setPublisherWalletInput] = useState('');
  const [publisherNameInput, setPublisherNameInput] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');
  const [docPrice, setDocPrice] = useState('0.05');
  const [docFileType, setDocFileType] = useState<'md' | 'pdf'>('md');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [publisherData, setPublisherData] = useState<any>(null);
  const [isLoadingPublisher, setIsLoadingPublisher] = useState(false);

  // Public Verifier State
  const [verifySigInput, setVerifySigInput] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedReceipt, setVerifiedReceipt] = useState<any>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Auto-sync wallet input when user connects wallet
  useEffect(() => {
    if (publicKey) {
      setPublisherWalletInput(publicKey);
      setAuthToken(null);
      setAuthWallet(null);
      setAuthError(null);
      fetchPublisherEconomics(publicKey);
    } else {
      setAuthToken(null);
      setAuthWallet(null);
      setPublisherData(null);
    }
  }, [publicKey]);

  /**
   * Proves ownership of the connected wallet by signing a server-issued
   * challenge. The resulting bearer token authorises publisher operations.
   */
  const authenticate = async () => {
    if (!publicKey) {
      setAuthError('Connect a wallet first.');
      return;
    }

    setIsAuthenticating(true);
    setAuthError(null);

    try {
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: publicKey }),
      });
      const challengeData = await challengeRes.json();
      if (!challengeData.success) {
        throw new Error(challengeData.error || 'Failed to create sign-in challenge.');
      }

      const signature = await signMessage(challengeData.message);

      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey,
          message: challengeData.message,
          signature,
        }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        throw new Error(verifyData.error || 'Signature verification failed.');
      }

      setAuthToken(verifyData.token);
      setAuthWallet(verifyData.wallet);
      fetchPublisherEconomics(verifyData.wallet, verifyData.token);
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const fetchPublisherEconomics = async (wallet: string, token?: string | null) => {
    // Economics are private to the wallet owner, so they are only fetched once
    // a session token exists.
    if (!token) {
      setPublisherData(null);
      return;
    }

    setIsLoadingPublisher(true);
    try {
      const res = await fetch('/api/publisher/economics', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success && data.registered) {
        setPublisherData(data.publisher);
      } else if (data.success) {
        setPublisherData(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingPublisher(false);
    }
  };

  // 1. Consumer: Request Quote
  const handleRequestQuote = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!queryInput.trim()) return;

    setIsQuoting(true);
    setQuote(null);
    setSourcesPreview([]);
    setQuoteError(null);
    setAnswerData(null);
    setSettlementError(null);

    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryInput.trim(),
          buyerWallet: publicKey || undefined,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to generate quote.');
      }

      if (!data.found) {
        setQuoteError('No published knowledge sources found matching your query in the catalog.');
        return;
      }

      setQuote(data.quote);
      setSourcesPreview(data.sourcesPreview || []);
    } catch (err: any) {
      setQuoteError(err.message);
    } finally {
      setIsQuoting(false);
    }
  };

  // 2. Consumer: Settle on Solana & Unlock Answer
  const handlePayAndSettle = async () => {
    if (!quote) return;
    if (!publicKey) {
      try {
        await connectWallet();
      } catch {
        return;
      }
    }

    setIsSettling(true);
    setSettlementError(null);

    try {
      // 1. User signs and sends the atomic USDC settlement transaction.
      const txSignature = await sendSettlementTransaction({
        publisherBreakdown: quote.publisherBreakdown,
        memoExpected: quote.memoExpected,
      });

      // 2. Send transaction signature to server-side settlement gatekeeper
      const settleRes = await fetch('/api/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.id,
          txSignature,
          buyerWallet: publicKey,
        }),
      });

      const settleData = await settleRes.json();

      // The payment may have settled on-chain even when answer generation
      // failed. Surface that honestly rather than hiding it behind a generic
      // error, and make sure the receipt is still shown.
      if (!settleData.success && settleData.paymentSettled) {
        setSettlementError(settleData.error);
        if (settleData.receipt) {
          setAnswerData({
            answer: '',
            citations: [],
            provider: '',
            model: '',
            receipt: settleData.receipt,
          });
        }
        return;
      }

      if (!settleData.success) {
        throw new Error(settleData.error || 'Server settlement verification failed.');
      }

      setAnswerData({
        answer: settleData.answer,
        citations: settleData.citations,
        provider: settleData.provider,
        model: settleData.model,
        receipt: settleData.receipt,
      });

      // Refresh publisher economics if publisher is connected
      if (publicKey && authToken) {
        fetchPublisherEconomics(publicKey, authToken);
      }
    } catch (err: any) {
      console.error(err);
      setSettlementError(err.message);
    } finally {
      setIsSettling(false);
    }
  };

  // 3. Publisher: Upload Document
  const handleUploadDocument = async (e: React.FormEvent) => {
    e.preventDefault();

    // Publishing requires proof of wallet ownership. Without it anyone could
    // publish under any wallet address and collect the royalties.
    if (!authToken) {
      setUploadError('Sign in with your wallet before publishing.');
      return;
    }
    if (!publicKey || authWallet !== publicKey) {
      setUploadError('Your wallet session is not active. Please sign in again.');
      return;
    }
    if (!docTitle.trim()) {
      setUploadError('Document title is required.');
      return;
    }
    if (!docPrice || Number.isNaN(Number.parseFloat(docPrice)) || Number.parseFloat(docPrice) <= 0) {
      setUploadError('Price per query must be a positive number.');
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadSuccess(null);

    try {
      const authHeaders = { Authorization: `Bearer ${authToken}` };
      let res;
      if (docFileType === 'pdf') {
        if (!pdfFile) {
          throw new Error('Please select a PDF file to upload.');
        }
        const formData = new FormData();
        formData.append('publisherName', publisherNameInput.trim() || 'Verified Publisher');
        formData.append('title', docTitle.trim());
        formData.append('pricePerQueryUsdc', docPrice);
        formData.append('file', pdfFile);

        res = await fetch('/api/documents', {
          method: 'POST',
          headers: authHeaders,
          body: formData,
        });
      } else {
        if (!docContent.trim()) {
          throw new Error('Document markdown content cannot be empty.');
        }
        res = await fetch('/api/documents', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publisherName: publisherNameInput.trim() || 'Verified Publisher',
            title: docTitle.trim(),
            content: docContent.trim(),
            fileType: 'md',
            pricePerQueryUsdc: docPrice,
          }),
        });
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Upload failed.');
      }

      setUploadSuccess(`Successfully published "${data.document.title}" (${data.document.total_chunks} chunks indexed)!`);
      setDocTitle('');
      setDocContent('');
      setPdfFile(null);
      fetchPublisherEconomics(publicKey, authToken);
    } catch (err: any) {
      setUploadError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  // 4. Verifier: Verify Signature
  const handleVerifyReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifySigInput.trim()) return;

    setIsVerifying(true);
    setVerifiedReceipt(null);
    setVerifyError(null);

    try {
      const res = await fetch(`/api/receipts/${encodeURIComponent(verifySigInput.trim())}`);
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Receipt not found or unverified.');
      }
      setVerifiedReceipt(data.receipt);
    } catch (err: any) {
      setVerifyError(err.message);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#07080c] text-gray-200">
      {/* Top Navigation */}
      <header className="border-b border-gray-800/80 bg-[#0c0d14]/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-tr from-purple-600 via-indigo-600 to-emerald-400 flex items-center justify-center font-bold text-white shadow-lg shadow-purple-500/20">
              CR
            </div>
            <div>
              <span className="font-extrabold text-xl tracking-tight text-white flex items-center gap-2">
                CITERAIL
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  Solana Devnet
                </span>
              </span>
            </div>
          </div>

          <nav className="flex items-center space-x-1 sm:space-x-2">
            <button
              onClick={() => setActiveTab('consumer')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === 'consumer'
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Ask & Retrieve
            </button>
            <button
              onClick={() => setActiveTab('publisher')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === 'publisher'
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Publisher Portal
            </button>
            <button
              onClick={() => setActiveTab('verifier')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === 'verifier'
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Public Verifier
            </button>
          </nav>

          <div className="flex items-center space-x-3">
            {connected && publicKey ? (
              <div className="flex items-center space-x-2">
                <span className="font-mono text-xs text-gray-300 bg-gray-900/90 border border-gray-700 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  {publicKey.slice(0, 4)}...{publicKey.slice(-4)}
                </span>
                <button
                  onClick={disconnectWallet}
                  className="text-xs text-gray-400 hover:text-red-400 px-2 py-1"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={() => connectWallet()}
                className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium text-xs px-4 py-2 rounded-lg transition shadow-md shadow-purple-600/20 flex items-center gap-1.5"
              >
                <span>Connect Phantom</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        {/* ======================= CONSUMER TAB ======================= */}
        {activeTab === 'consumer' && (
          <div className="space-y-8">
            <div className="text-center max-w-2xl mx-auto space-y-2">
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                Verifiable Knowledge Retrieval on{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-emerald-400">
                  Solana
                </span>
              </h1>
              <p className="text-gray-400 text-sm">
                Ask any question. Knowledge creators receive guaranteed, atomic USDC royalties on-chain before grounded AI answers are delivered.
              </p>
            </div>

            {/* Query Input Box */}
            <form onSubmit={handleRequestQuote} className="max-w-3xl mx-auto">
              <div className="relative flex items-center bg-[#11131d] border border-gray-700/80 rounded-2xl p-2 shadow-2xl focus-within:border-purple-500/80 transition">
                <Search className="w-5 h-5 text-gray-400 ml-3 mr-2" />
                <input
                  type="text"
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
                  placeholder="Ask a technical or research question..."
                  className="bg-transparent flex-1 text-white placeholder-gray-500 focus:outline-none text-base px-2 py-2"
                />
                <button
                  type="submit"
                  disabled={isQuoting || !queryInput.trim()}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium px-5 py-2.5 rounded-xl transition flex items-center gap-2 text-sm shadow-lg shadow-purple-600/30"
                >
                  {isQuoting ? (
                    <>
                      <div className="h-4 w-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      Retrieving...
                    </>
                  ) : (
                    <>
                      <span>Inspect Quote</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>

              {/* Sample queries */}
              <div className="flex items-center gap-2 mt-3 text-xs text-gray-400 flex-wrap justify-center">
                <span>Try asking:</span>
                <button
                  type="button"
                  onClick={() => {
                    setQueryInput('What is CiteRail and how does atomic royalty settlement work on Solana?');
                  }}
                  className="underline hover:text-purple-400 transition"
                >
                  "How does CiteRail atomic royalty settlement work?"
                </button>
                <span>•</span>
                <button
                  type="button"
                  onClick={() => {
                    setQueryInput('What are the non-negotiables for verifiable AI citations?');
                  }}
                  className="underline hover:text-purple-400 transition"
                >
                  "Verifiable AI citations non-negotiables"
                </button>
              </div>
            </form>

            {/* Error Message */}
            {quoteError && (
              <div className="max-w-2xl mx-auto p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-sm flex items-center gap-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-400" />
                <span>{quoteError}</span>
              </div>
            )}

            {/* Quote Inspection Card */}
            {quote && !answerData && (
              <div className="max-w-3xl mx-auto bg-[#0f111a] border border-purple-500/30 rounded-2xl p-6 shadow-2xl space-y-6">
                <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-6 h-6 text-purple-400" />
                    <h3 className="font-bold text-lg text-white">Cryptographic Settlement Quote</h3>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/20">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Expires in 5 minutes</span>
                  </div>
                </div>

                {/* Sources Matched */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-gray-400">
                    <span>Matched Knowledge Sources ({sourcesPreview.length})</span>
                    <span>Royalty Allocation</span>
                  </div>
                  <div className="space-y-2">
                    {sourcesPreview.map((src) => (
                      <div
                        key={src.source_index}
                        className="p-3 bg-[#161824] border border-gray-800 rounded-xl flex items-center justify-between text-sm"
                      >
                        <div className="space-y-1">
                          <div className="font-semibold text-gray-200 flex items-center gap-2">
                            <span className="text-xs bg-purple-900/60 text-purple-300 px-2 py-0.5 rounded font-mono">
                              Source [{src.source_index}]
                            </span>
                            {src.document_title}
                          </div>
                          <div className="text-xs text-gray-400 flex items-center gap-2">
                            <span>Author: {src.publisher_name}</span>
                            <span>•</span>
                            <span className="font-mono text-gray-500">
                              {src.publisher_wallet.slice(0, 6)}...{src.publisher_wallet.slice(-4)}
                            </span>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-mono font-bold text-emerald-400">
                            {parseFloat(src.price_usdc).toFixed(4)} USDC
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Payment Memo & Total */}
                <div className="bg-[#141622] p-4 rounded-xl space-y-3 border border-gray-800/80">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-400">Memo Program Binding:</span>
                    <span className="font-mono text-xs text-purple-300 bg-purple-950/60 px-2.5 py-1 rounded border border-purple-800/50">
                      {quote.memoExpected}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                    <span className="font-semibold text-base text-gray-200">Total Royalty Settlement:</span>
                    <span className="font-mono font-extrabold text-xl text-emerald-400">
                      ${quote.totalPriceUsdc.toFixed(4)} USDC
                    </span>
                  </div>
                </div>

                {/* Settlement Action Button */}
                <div className="space-y-3">
                  <button
                    onClick={handlePayAndSettle}
                    disabled={isSettling}
                    className="w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-indigo-600 hover:from-emerald-400 hover:to-indigo-500 disabled:opacity-50 text-white font-bold py-3.5 px-6 rounded-xl transition shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-2 text-base"
                  >
                    {isSettling ? (
                      <>
                        <div className="h-5 w-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        <span>Verifying On-Chain Devnet Payment...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5" />
                        <span>Sign Payment & Unlock Answer with Phantom</span>
                      </>
                    )}
                  </button>

                  <p className="text-[11px] text-center text-gray-500">
                    Atomic transaction contains SPL USDC transfers directly to publisher accounts plus an on-chain Memo binding. No custodial intermediary.
                  </p>
                </div>

                {settlementError && (
                  <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                    <span>{settlementError}</span>
                  </div>
                )}
              </div>
            )}

            {/* Grounded Answer & Verifiable Receipt */}
            {answerData && (
              <div className="max-w-3xl mx-auto space-y-6">
                {/* Answer Box */}
                <div className="bg-[#0f111a] border border-emerald-500/40 rounded-2xl p-6 shadow-2xl space-y-5">
                  <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-lg text-white">Grounded Answer</h3>
                        <p className="text-xs text-gray-400">
                          Synthesized using {answerData.provider.toUpperCase()} ({answerData.model})
                        </p>
                      </div>
                    </div>
                    <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold px-2.5 py-1 rounded-full">
                      Payment Confirmed & Verified
                    </span>
                  </div>

                  {/* Body text with citations */}
                  <div className="text-gray-200 leading-relaxed text-sm whitespace-pre-wrap font-sans">
                    {answerData.answer || (
                      <span className="text-amber-400">
                        The payment settled on-chain, but the answer could not be
                        generated. Retry to regenerate it from the same paid
                        sources — you will not be charged again.
                      </span>
                    )}
                  </div>

                  {/* Exact Sources Citations */}
                  <div className="border-t border-gray-800/80 pt-4 space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                      Verified Source Citations ({answerData.citations.length})
                    </h4>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {answerData.citations.map((c) => (
                        <div
                          key={c.citation_index}
                          className="p-3 rounded-xl bg-[#161824] border border-gray-800/80 text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-purple-400">
                              [^{c.citation_index}] {c.document_title}
                            </span>
                            <span className="font-mono text-[10px] text-gray-500">
                              {c.content_hash.slice(0, 8)}
                            </span>
                          </div>
                          <p className="text-gray-400 text-[11px] italic line-clamp-2">
                            "{c.snippet}"
                          </p>
                          <div className="text-[10px] text-gray-500 font-mono">
                            Publisher: {c.publisher_name} ({c.publisher_wallet.slice(0, 4)}..{c.publisher_wallet.slice(-4)})
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* On-Chain Receipt */}
                <div className="bg-[#0b0d14] border border-gray-800 rounded-2xl p-5 space-y-4 text-xs font-mono">
                  <div className="flex items-center justify-between text-gray-300">
                    <span className="font-sans font-bold flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-emerald-400" />
                      Solana Settlement Receipt
                    </span>
                    <a
                      href={answerData.receipt.solanaExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-purple-400 hover:text-purple-300 flex items-center gap-1 font-sans font-medium"
                    >
                      View on Solana Explorer <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <div className="p-3 bg-black/60 rounded-xl space-y-1.5 text-gray-400 overflow-x-auto">
                    <div>
                      <span className="text-gray-500">Receipt ID: </span>
                      <span className="text-gray-200">{answerData.receipt.id}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Tx Signature: </span>
                      <span className="text-purple-300 break-all">{answerData.receipt.txSignature}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Payer Wallet: </span>
                      <span className="text-gray-300">{answerData.receipt.payerWallet}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Solana Slot: </span>
                      <span className="text-emerald-400">{answerData.receipt.slot}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Total Royalty Paid: </span>
                      <span className="text-emerald-400">
                        ${answerData.receipt.totalAmountUsdc?.toFixed(4)}{' '}
                        {answerData.receipt.settlementAsset || 'USDC'}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Memo Verified: </span>
                      <span className="text-emerald-400">TRUE (Binding cryptographically matched)</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ======================= PUBLISHER TAB ======================= */}
        {activeTab === 'publisher' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-extrabold text-white">Publisher Economics & Knowledge Hub</h2>
              <p className="text-gray-400 text-sm">
                License your documents for AI retrieval. Earn real USDC every time your knowledge is retrieved and cited.
              </p>
            </div>

            {/* Revenue Overview Card */}
            {publisherData && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-[#10121b] border border-gray-800 rounded-2xl p-5">
                  <span className="text-xs text-gray-400 font-medium">Total Earned (USDC)</span>
                  <div className="text-2xl font-mono font-bold text-emerald-400 mt-2">
                    ${publisherData.totalRevenueUsdc.toFixed(4)}
                  </div>
                </div>
                <div className="bg-[#10121b] border border-gray-800 rounded-2xl p-5">
                  <span className="text-xs text-gray-400 font-medium">Licensed Queries Answered</span>
                  <div className="text-2xl font-mono font-bold text-purple-400 mt-2">
                    {publisherData.totalQueriesAnswered}
                  </div>
                </div>
                <div className="bg-[#10121b] border border-gray-800 rounded-2xl p-5">
                  <span className="text-xs text-gray-400 font-medium">Active Documents</span>
                  <div className="text-2xl font-mono font-bold text-gray-200 mt-2">
                    {publisherData.documents?.length || 0}
                  </div>
                </div>
              </div>
            )}

            {/* Document Ingestion Form */}
            <div className="bg-[#0f111a] border border-gray-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex items-center gap-2 border-b border-gray-800 pb-4">
                <UploadCloud className="w-5 h-5 text-purple-400" />
                <h3 className="font-bold text-lg text-white">Publish New Knowledge</h3>
              </div>

              {/* Wallet ownership proof */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-gray-800 bg-[#12141d] p-4">
                <div className="text-xs text-gray-400">
                  {authToken ? (
                    <span className="flex items-center gap-2 text-emerald-400">
                      <ShieldCheck className="w-4 h-4" />
                      Wallet verified &mdash; publishing as{' '}
                      <span className="font-mono">
                        {authWallet?.slice(0, 4)}...{authWallet?.slice(-4)}
                      </span>
                    </span>
                  ) : (
                    <span>
                      Sign a message with your wallet to prove you own{' '}
                      <span className="font-mono text-gray-300">
                        {publicKey
                          ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`
                          : '(connect a wallet first)'}
                      </span>
                      . This is a free signature, not a transaction.
                    </span>
                  )}
                </div>
                {!authToken && (
                  <button
                    type="button"
                    onClick={authenticate}
                    disabled={isAuthenticating || !connected}
                    className="shrink-0 rounded-lg bg-purple-600/20 text-purple-300 border border-purple-500/30 px-4 py-2 text-xs font-semibold hover:bg-purple-600/30 disabled:opacity-50"
                  >
                    {isAuthenticating
                      ? 'Verifying signature...'
                      : connected
                        ? 'Sign in to publish'
                        : 'Connect wallet'}
                  </button>
                )}
              </div>

              {authError && (
                <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                  <span>{authError}</span>
                </div>
              )}

              <form onSubmit={handleUploadDocument} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Publisher Solana Wallet Address *
                    </label>
                    <input
                      type="text"
                      value={publisherWalletInput}
                      readOnly
                      placeholder="Connect a wallet to publish"
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500 font-mono cursor-not-allowed"
                      required
                    />
                    <p className="text-[11px] text-gray-500 mt-1">
                      The wallet address is taken from your connected wallet and cannot
                      be typed in, so royalties can never be attributed to a wallet you
                      do not control.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Publisher / Author Display Name
                    </label>
                    <input
                      type="text"
                      value={publisherNameInput}
                      onChange={(e) => setPublisherNameInput(e.target.value)}
                      placeholder="e.g. Solana Research Labs"
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Document Title *
                    </label>
                    <input
                      type="text"
                      value={docTitle}
                      onChange={(e) => setDocTitle(e.target.value)}
                      placeholder="e.g. Solana High-Throughput Consensus Architecture"
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Price Per Query (USDC) *
                    </label>
                    <input
                      type="number"
                      step="0.005"
                      value={docPrice}
                      onChange={(e) => setDocPrice(e.target.value)}
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500 font-mono"
                      required
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs font-medium text-gray-400">
                  <span>Format:</span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="fileType"
                      checked={docFileType === 'md'}
                      onChange={() => setDocFileType('md')}
                      className="text-purple-600 focus:ring-purple-500"
                    />
                    <span>Markdown / Text</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="fileType"
                      checked={docFileType === 'pdf'}
                      onChange={() => setDocFileType('pdf')}
                      className="text-purple-600 focus:ring-purple-500"
                    />
                    <span>PDF Upload</span>
                  </label>
                </div>

                {docFileType === 'md' ? (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Markdown Content *
                    </label>
                    <textarea
                      rows={6}
                      value={docContent}
                      onChange={(e) => setDocContent(e.target.value)}
                      placeholder="Paste your technical markdown or research content here..."
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl p-3 text-sm text-gray-200 focus:outline-none focus:border-purple-500 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">
                      Upload PDF File *
                    </label>
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
                      className="w-full bg-[#161824] border border-gray-700 rounded-xl p-3 text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-purple-600 file:text-white hover:file:bg-purple-500"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isUploading || !authToken}
                  className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-xl transition shadow-lg shadow-purple-600/30 flex items-center justify-center gap-2 text-sm"
                >
                  {isUploading ? (
                    <>
                      <div className="h-4 w-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      Parsing Chunks & Ingesting...
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" />
                      Publish & Index Knowledge
                    </>
                  )}
                </button>

                {uploadSuccess && (
                  <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span>{uploadSuccess}</span>
                  </div>
                )}

                {uploadError && (
                  <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <span>{uploadError}</span>
                  </div>
                )}
              </form>
            </div>

            {/* Published Documents List */}
            {publisherData && publisherData.documents && (
              <div className="bg-[#0f111a] border border-gray-800 rounded-2xl p-6 shadow-xl space-y-4">
                <h3 className="font-bold text-lg text-white">Your Published Documents</h3>
                <div className="space-y-2">
                  {publisherData.documents.map((doc: any) => (
                    <div
                      key={doc.id}
                      className="p-3.5 bg-[#161824] border border-gray-800/80 rounded-xl flex items-center justify-between text-sm"
                    >
                      <div>
                        <div className="font-semibold text-gray-200">{doc.title}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-2 font-mono">
                          <span>{doc.total_chunks} Chunks</span>
                          <span>•</span>
                          <span>Hash: {doc.content_hash.slice(0, 10)}...</span>
                        </div>
                      </div>
                      <div className="text-right font-mono">
                        <span className="text-emerald-400 font-bold">${doc.price_per_query_usdc} USDC</span>
                        <div className="text-[10px] text-gray-500">per retrieval</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ======================= VERIFIER TAB ======================= */}
        {activeTab === 'verifier' && (
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-extrabold text-white">Public Transaction Verifier</h2>
              <p className="text-gray-400 text-sm">
                Audit any settlement receipt on Solana Devnet. Confirm publisher payout amounts, block confirmations, and memo bindings.
              </p>
            </div>

            <form onSubmit={handleVerifyReceipt} className="space-y-4">
              <div className="relative flex items-center bg-[#11131d] border border-gray-700 rounded-2xl p-2 shadow-2xl focus-within:border-purple-500 transition">
                <input
                  type="text"
                  value={verifySigInput}
                  onChange={(e) => setVerifySigInput(e.target.value)}
                  placeholder="Paste Solana transaction signature..."
                  className="bg-transparent flex-1 text-white placeholder-gray-500 focus:outline-none text-sm px-3 py-2 font-mono"
                />
                <button
                  type="submit"
                  disabled={isVerifying || !verifySigInput.trim()}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium px-5 py-2 rounded-xl transition text-sm flex items-center gap-2"
                >
                  {isVerifying ? 'Auditing...' : 'Verify'}
                </button>
              </div>
            </form>

            {verifyError && (
              <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-sm flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <span>{verifyError}</span>
              </div>
            )}

            {verifiedReceipt && (
              <div className="bg-[#0f111a] border border-gray-800 rounded-2xl p-6 shadow-2xl space-y-5 font-mono text-xs">
                <div className="flex items-center justify-between border-b border-gray-800 pb-4">
                  <div className="flex items-center gap-2 font-sans font-bold text-base text-white">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    Cryptographic Proof Confirmed
                  </div>
                  <a
                    href={verifiedReceipt.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-purple-400 hover:text-purple-300 flex items-center gap-1 font-sans"
                  >
                    Solana Explorer <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                <div className="space-y-2 text-gray-300">
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Transaction Signature:</span>
                    <span className="text-purple-300 break-all">{verifiedReceipt.txSignature}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Payer Wallet:</span>
                    <span className="text-gray-200">{verifiedReceipt.payerWallet}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Block Slot:</span>
                    <span className="text-emerald-400">{verifiedReceipt.slot}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Total Royalty Paid:</span>
                    <span className="text-emerald-400 font-bold">
                      ${verifiedReceipt.totalAmountUsdc.toFixed(4)}{' '}
                      {verifiedReceipt.settlementAsset || 'USDC'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Memo Program Binding:</span>
                    <span className="text-purple-300">{verifiedReceipt.memoExpected}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-gray-800/40">
                    <span className="text-gray-500">Query Text:</span>
                    <span className="text-gray-200 font-sans italic">"{verifiedReceipt.queryText}"</span>
                  </div>
                </div>

                <div className="pt-2">
                  <span className="text-gray-500 block mb-2 font-sans font-semibold">Publisher Payout Breakdown:</span>
                  <div className="space-y-1">
                    {verifiedReceipt.breakdown.map((item: any, i: number) => (
                      <div
                        key={i}
                        className="p-2.5 rounded-lg bg-black/40 border border-gray-800 flex justify-between items-center"
                      >
                        <span className="text-gray-400">{item.publisher_wallet}</span>
                        <span className="text-emerald-400 font-bold">
                          {(item.received_amount / 1_000_000).toFixed(4)}{' '}
                          {verifiedReceipt.settlementAsset || 'USDC'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800/80 bg-[#090a0f] py-6 text-center text-xs text-gray-500">
        <p>CiteRail — Verifiable AI Retrieval & Creator Royalty Settlement Protocol on Solana Devnet.</p>
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <WalletProvider>
      <CiteRailDashboard />
    </WalletProvider>
  );
}
