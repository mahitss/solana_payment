import { NextResponse } from 'next/server';
import { ingestDocument, listAllDocuments } from '@/lib/documents';
import { isValidSolanaAddress } from '@/lib/publishers';

export async function GET() {
  try {
    const documents = await listAllDocuments();
    return NextResponse.json({ success: true, documents });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') || '';

    let publisherWallet = '';
    let publisherName = '';
    let title = '';
    let fileType: 'pdf' | 'md' = 'md';
    let rawText = '';
    let rawBuffer: Buffer | undefined;
    let pricePerQueryUsdc = 0.05;
    let licenseType = 'query_royalty_v1';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      publisherWallet = (formData.get('publisherWallet') as string) || '';
      publisherName = (formData.get('publisherName') as string) || '';
      title = (formData.get('title') as string) || '';
      const file = formData.get('file') as File | null;
      const priceStr = formData.get('pricePerQueryUsdc') as string;
      if (priceStr) pricePerQueryUsdc = parseFloat(priceStr);
      licenseType = (formData.get('licenseType') as string) || 'query_royalty_v1';

      if (!file) {
        return NextResponse.json({ success: false, error: 'File is required in form-data.' }, { status: 400 });
      }

      const fileName = file.name.toLowerCase();
      if (fileName.endsWith('.pdf')) {
        fileType = 'pdf';
      } else {
        fileType = 'md';
      }

      const arrayBuf = await file.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuf);
      if (!title) {
        title = file.name.replace(/\.[^/.]+$/, '');
      }
    } else {
      const json = await req.json();
      publisherWallet = json.publisherWallet;
      publisherName = json.publisherName;
      title = json.title;
      fileType = json.fileType || 'md';
      rawText = json.content || '';
      if (json.pricePerQueryUsdc) pricePerQueryUsdc = parseFloat(json.pricePerQueryUsdc);
      licenseType = json.licenseType || 'query_royalty_v1';
    }

    if (!publisherWallet || !isValidSolanaAddress(publisherWallet)) {
      return NextResponse.json(
        { success: false, error: 'A valid Solana wallet address is required for publisher attribution.' },
        { status: 400 }
      );
    }

    if (!title) {
      return NextResponse.json({ success: false, error: 'Document title is required.' }, { status: 400 });
    }

    const doc = await ingestDocument({
      publisherWallet,
      publisherName,
      title,
      fileType,
      rawBuffer,
      rawText,
      pricePerQueryUsdc,
      licenseType,
    });

    return NextResponse.json({ success: true, document: doc });
  } catch (err: any) {
    console.error('Document ingestion error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
