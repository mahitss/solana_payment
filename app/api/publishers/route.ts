import { NextResponse } from 'next/server';
import {
  getOrCreatePublisher,
  listAllPublishers,
  isValidSolanaAddress,
} from '@/lib/publishers';
import { AuthError, requireAuth, markPublisherVerified } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Public publisher directory. Only the public-facing fields are returned so
 * that contact e-mail addresses are not leaked to every visitor.
 */
export async function GET() {
  try {
    const publishers = await listAllPublishers();
    return NextResponse.json({
      success: true,
      publishers: publishers.map((p) => ({
        id: p.id,
        walletAddress: p.wallet_address,
        name: p.name,
        verified: Boolean(p.verified_at),
        createdAt: p.created_at,
      })),
    });
  } catch (err: any) {
    console.error('Publisher listing error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * Registers (or updates) a publisher profile.
 *
 * Requires an authenticated wallet session, and the wallet in the body must
 * match the authenticated wallet - otherwise anyone could register a profile
 * for a wallet they do not control.
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);

    const body = await req.json().catch(() => ({}));
    const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '';

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'walletAddress is required.' },
        { status: 400 }
      );
    }

    if (!isValidSolanaAddress(walletAddress)) {
      return NextResponse.json(
        { success: false, error: 'A valid base58 Solana public key is required.' },
        { status: 400 }
      );
    }

    if (walletAddress !== session.wallet) {
      return NextResponse.json(
        {
          success: false,
          error: 'walletAddress must match the authenticated wallet.',
        },
        { status: 403 }
      );
    }

    const publisher = await getOrCreatePublisher(
      walletAddress,
      body.name,
      body.email
    );

    // The wallet just proved ownership, so mark it verified.
    await markPublisherVerified(walletAddress);

    return NextResponse.json({
      success: true,
      publisher: {
        id: publisher.id,
        walletAddress: publisher.wallet_address,
        name: publisher.name,
        email: publisher.email,
        verified: true,
      },
    });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('Publisher registration error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
