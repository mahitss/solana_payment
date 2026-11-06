import { NextResponse } from 'next/server';
import {
  ingestDocument,
  listAllDocuments,
  DuplicateDocumentError,
} from '@/lib/documents';
import { AuthError, requireAuth } from '@/lib/auth';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Public catalogue listing. Browsing the published corpus is intentionally
 * open - it is the discovery surface for consumers.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(
      Math.max(Number.parseInt(searchParams.get('limit') || '100', 10) || 100, 1),
      200
    );

    const documents = await listAllDocuments(limit);
    return NextResponse.json({ success: true, documents });
  } catch (err: any) {
    console.error('Document listing error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * Publishes a document.
 *
 * Requires an authenticated wallet session. The publisher wallet is taken from
 * the verified session - never from the request body - so a caller cannot
 * publish under somebody else's address and collect their royalties.
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);

    const contentType = req.headers.get('content-type') || '';

    // The publisher wallet comes from the verified session, never from the
    // request body, so royalties can never be attributed to a wallet the
    // caller does not control.
    const publisherWallet = session.wallet;
    let publisherName = '';
    let title = '';
    let fileType: 'pdf' | 'md' = 'md';
    let rawText = '';
    let rawBuffer: Buffer | undefined;
    let pricePerQueryUsdc = 0.05;
    let licenseType = 'query_royalty_v1';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      publisherName = (formData.get('publisherName') as string) || '';
      title = (formData.get('title') as string) || '';
      const file = formData.get('file') as File | null;
      const priceStr = formData.get('pricePerQueryUsdc') as string;
      if (priceStr) pricePerQueryUsdc = Number.parseFloat(priceStr);
      licenseType = (formData.get('licenseType') as string) || 'query_royalty_v1';

      if (!file) {
        return NextResponse.json(
          { success: false, error: 'File is required in form-data.' },
          { status: 400 }
        );
      }

      // Reject oversized uploads before buffering the body.
      if (file.size > config.maxUploadBytes) {
        return NextResponse.json(
          {
            success: false,
            error: `File exceeds the maximum upload size of ${config.maxUploadBytes} bytes.`,
          },
          { status: 413 }
        );
      }

      const fileName = (file.name || '').toLowerCase();
      const declaredType = (file.type || '').toLowerCase();

      if (fileName.endsWith('.pdf') || declaredType === 'application/pdf') {
        fileType = 'pdf';
        // Defence in depth: a file claiming to be a PDF must actually be one.
        if (declaredType && declaredType !== 'application/pdf') {
          return NextResponse.json(
            { success: false, error: 'Uploaded file type does not match its extension.' },
            { status: 400 }
          );
        }
      } else {
        fileType = 'md';
        if (declaredType && !declaredType.startsWith('text/') && declaredType !== 'application/json') {
          return NextResponse.json(
            { success: false, error: 'Only PDF, Markdown or plain text uploads are supported.' },
            { status: 400 }
          );
        }
      }

      const arrayBuf = await file.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuf);

      if (rawBuffer.byteLength > config.maxUploadBytes) {
        return NextResponse.json(
          {
            success: false,
            error: `File exceeds the maximum upload size of ${config.maxUploadBytes} bytes.`,
          },
          { status: 413 }
        );
      }

      if (!title) {
        title = file.name.replace(/\.[^/.]+$/, '');
      }
    } else {
      const json = await req.json();
      publisherName = json.publisherName;
      title = json.title;
      fileType = json.fileType === 'pdf' ? 'pdf' : 'md';
      rawText = typeof json.content === 'string' ? json.content : '';
      if (json.pricePerQueryUsdc) {
        pricePerQueryUsdc = Number.parseFloat(json.pricePerQueryUsdc);
      }
      licenseType = json.licenseType || 'query_royalty_v1';

      if (Buffer.byteLength(rawText, 'utf8') > config.maxUploadBytes) {
        return NextResponse.json(
          {
            success: false,
            error: `Content exceeds the maximum upload size of ${config.maxUploadBytes} bytes.`,
          },
          { status: 413 }
        );
      }
    }

    if (!title || !title.trim()) {
      return NextResponse.json(
        { success: false, error: 'Document title is required.' },
        { status: 400 }
      );
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
    if (err instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: err.message, code: err.code },
        { status: err.status }
      );
    }
    if (err instanceof DuplicateDocumentError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 409 });
    }
    console.error('Document ingestion error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
