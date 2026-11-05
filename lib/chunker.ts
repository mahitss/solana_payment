import crypto from 'crypto';

export interface DocumentChunk {
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count: number;
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Splits text into semantically cohesive chunks with sliding window overlap.
 */
export function chunkText(rawText: string, maxTokens: number = 400, overlapTokens: number = 50): DocumentChunk[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  // Split into paragraphs / sections first
  const paragraphs = normalized.split(/\n\n+/);
  const chunks: DocumentChunk[] = [];
  let currentWords: string[] = [];

  const flushChunk = () => {
    if (currentWords.length === 0) return;
    const content = currentWords.join(' ').trim();
    if (content.length > 0) {
      chunks.push({
        chunk_index: chunks.length,
        content,
        content_hash: computeSha256(content),
        token_count: Math.ceil(currentWords.length * 1.3), // Approximate token count
      });
    }
  };

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    if (currentWords.length + words.length <= maxTokens) {
      currentWords.push(...words);
    } else {
      // Chunk exceeds limit, flush current chunk
      flushChunk();
      // Keep overlap from previous words
      const overlap = currentWords.slice(-overlapTokens);
      currentWords = [...overlap, ...words];

      // If a single paragraph is larger than maxTokens, sub-slice it
      while (currentWords.length > maxTokens) {
        const slice = currentWords.slice(0, maxTokens);
        const content = slice.join(' ').trim();
        chunks.push({
          chunk_index: chunks.length,
          content,
          content_hash: computeSha256(content),
          token_count: Math.ceil(slice.length * 1.3),
        });
        currentWords = currentWords.slice(maxTokens - overlapTokens);
      }
    }
  }

  // Flush remaining words
  if (currentWords.length > 0) {
    flushChunk();
  }

  return chunks;
}

/**
 * Extract text from Markdown or plain text.
 */
export function parseMarkdown(content: string): string {
  // Strip frontmatter if present
  let text = content.replace(/^---[\s\S]*?---/, '');
  // Normalize whitespace
  return text.trim();
}

/**
 * Extract text from PDF buffer.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);
  return data.text || '';
}
