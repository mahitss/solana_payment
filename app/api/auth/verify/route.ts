import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  AuthError,
  buildAuthMessage,
  isValidSolanaAddress,
  issueSessionToken,
  verifyWalletSignature,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface ChallengeRow {
  id: string;
  wallet_address: string;
  nonce: string;
  message: string;
  issued_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';

    if (!wallet || !message || !signature) {
      return NextResponse.json(
        { success: false, error: 'wallet, message and signature are required.' },
        { status: 400 }
      );
    }

    if (!isValidSolanaAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'Invalid Solana wallet address.' },
        { status: 400 }
      );
    }

    // The nonce is embedded in the signed message; extract it to locate the
    // server-side challenge. We do not trust any client-supplied field.
    const nonceMatch = /^Nonce:\s*([a-f0-9]{48})$/m.exec(message);
    if (!nonceMatch) {
      return NextResponse.json(
        { success: false, error: 'Malformed authentication message.' },
        { status: 400 }
      );
    }
    const nonce = nonceMatch[1];

    const challengeRes = await query<ChallengeRow>(
      `SELECT id, wallet_address, nonce, message, issued_at, expires_at, used_at
       FROM auth_challenges WHERE nonce = $1`,
      [nonce]
    );

    if (challengeRes.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Unknown or expired authentication challenge.' },
        { status: 400 }
      );
    }

    const challenge = challengeRes.rows[0];

    if (challenge.used_at) {
      return NextResponse.json(
        { success: false, error: 'This authentication challenge was already used.' },
        { status: 400 }
      );
    }

    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return NextResponse.json(
        { success: false, error: 'This authentication challenge has expired.' },
        { status: 400 }
      );
    }

    if (challenge.wallet_address !== wallet) {
      return NextResponse.json(
        { success: false, error: 'Challenge wallet does not match the signed wallet.' },
        { status: 400 }
      );
    }

    // The client must have signed the exact message we issued. We rebuild the
    // expected message from stored values rather than trusting the submitted
    // text, so a tampered message cannot be used to smuggle extra content.
    const issuedAt = new Date(challenge.issued_at).toISOString();
    const domain = new URL(req.url).host;
    const expectedMessage = buildAuthMessage({
      wallet: challenge.wallet_address,
      nonce: challenge.nonce,
      issuedAt,
      domain,
    });

    if (message !== expectedMessage) {
      return NextResponse.json(
        { success: false, error: 'Signed message does not match the issued challenge.' },
        { status: 400 }
      );
    }

    if (!verifyWalletSignature(message, signature, wallet)) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet signature.' },
        { status: 401 }
      );
    }

    // Burn the nonce. The UPDATE is conditional so that two concurrent
    // verifications cannot both succeed.
    const burn = await query(
      `UPDATE auth_challenges SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [challenge.id]
    );
    if (burn.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'This authentication challenge was already used.' },
        { status: 400 }
      );
    }

    const session = issueSessionToken(wallet);

    return NextResponse.json({
      success: true,
      token: session.token,
      wallet,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('Auth verify error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to verify wallet signature.' },
      { status: 500 }
    );
  }
}
