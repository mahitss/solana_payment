import { NextResponse } from 'next/server';
import { getOrCreatePublisher, listAllPublishers, isValidSolanaAddress } from '@/lib/publishers';

export async function GET() {
  try {
    const publishers = await listAllPublishers();
    return NextResponse.json({ success: true, publishers });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { walletAddress, name, email } = body;

    if (!walletAddress || !isValidSolanaAddress(walletAddress)) {
      return NextResponse.json(
        { success: false, error: 'A valid 32-44 character base58 Solana public key is required.' },
        { status: 400 }
      );
    }

    const publisher = await getOrCreatePublisher(walletAddress, name, email);
    return NextResponse.json({ success: true, publisher });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
