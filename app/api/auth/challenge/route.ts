import { NextResponse } from 'next/server';
import { createAuthChallenge, AuthError, isValidSolanaAddress } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';

    if (!wallet) {
      return NextResponse.json(
        { success: false, error: 'wallet is required.' },
        { status: 400 }
      );
    }

    if (!isValidSolanaAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'Invalid Solana wallet address.' },
        { status: 400 }
      );
    }

    const domain = new URL(req.url).host;
    const challenge = await createAuthChallenge(wallet, domain);

    return NextResponse.json({
      success: true,
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
    });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('Auth challenge error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to create authentication challenge.' },
      { status: 500 }
    );
  }
}
