import crypto from 'crypto';

export interface DocumentChunk {
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count: number;
}

/**
 * Average tokens per whitespace-delimited word for English prose. Used to
 * estimate the token cost of a chunk.
 */
const TOKENS_PER_WORD = 1.3;

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Splits text into semantically cohesive chunks with sliding window overlap.
 *
 * Note on units: `maxWords` is a WORD count, not a token count. The previous
 * parameter was called `maxTokens` but was compared against `words.length`,
 * which made a "400 token" chunk actually contain roughly 520 tokens. The
 * parameter is now named for what it measures; `token_count` on each chunk is
 * the estimated token cost.
 *
 * @param maxWords     Soft upper bound on words per chunk.
 * @param overlapWords Words carried over from the previous chunk.
 */
export function chunkText(
  rawText: string,
  maxWords: number = 400,
  overlapWords: number = 50
): DocumentChunk[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  if (maxWords <= 0) {
    throw new Error('maxWords must be greater than zero.');
  }
  if (overlapWords < 0 || overlapWords >= maxWords) {
    throw new Error('overlapWords must be non-negative and smaller than maxWords.');
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
        token_count: Math.ceil(currentWords.length * TOKENS_PER_WORD),
      });
    }
  };

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    if (currentWords.length + words.length <= maxWords) {
      currentWords.push(...words);
    } else {
      // Chunk exceeds limit, flush current chunk
      flushChunk();
      // Keep overlap from previous words
      const overlap = currentWords.slice(-overlapWords);
      currentWords = [...overlap, ...words];

      // If a single paragraph is larger than maxWords, sub-slice it
      while (currentWords.length > maxWords) {
        const slice = currentWords.slice(0, maxWords);
        const content = slice.join(' ').trim();
        chunks.push({
          chunk_index: chunks.length,
          content,
          content_hash: computeSha256(content),
          token_count: Math.ceil(slice.length * TOKENS_PER_WORD),
        });
        currentWords = currentWords.slice(maxWords - overlapWords);
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
 * Extracts text from Markdown or plain text.
 */
export function parseMarkdown(content: string): string {
  // Strip frontmatter if present
  let text = content.replace(/^---[\s\S]*?---/, '');
  // Normalize whitespace
  return text.trim();
}

/**
 * Extracts text from PDF buffer.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  // `pdf-parse/lib/pdf-parse.js` is imported directly: the package entry point
  // runs a debug block that attempts to read a sample PDF from disk when it is
  // loaded outside of a CommonJS parent, which breaks inside a Next.js server
  // bundle.
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const data = await pdfParse(buffer);
  return data.text || '';
}
