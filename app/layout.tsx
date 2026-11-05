import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'CiteRail | AI Knowledge Retrieval & Solana Royalty Settlement',
  description: 'Grounded AI answers with verifiable, atomic USDC creator royalties on Solana.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#090a0f] text-gray-100 antialiased selection:bg-purple-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}
