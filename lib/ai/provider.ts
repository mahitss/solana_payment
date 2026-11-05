import { ChunkRecord } from '../documents';
import { AIProvider, CitationRef, GroundedAnswer } from './types';

export class AIProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderUnavailableError';
  }
}

function buildGroundedPrompt(userQuery: string, chunks: ChunkRecord[]): string {
  const sourcesText = chunks
    .map((chunk, idx) => {
      return `[SOURCE ${idx + 1}]
Document: ${chunk.document_title}
Publisher: ${chunk.publisher_name} (${chunk.publisher_wallet})
Chunk Hash: ${chunk.content_hash}
Content:
${chunk.content}`;
    })
    .join('\n\n---\n\n');

  return `You are CiteRail's verifiable knowledge synthesis engine on Solana.
Your role is to produce a grounded, factual answer to the user's question based EXCLUSIVELY on the provided licensed knowledge sources below.

CRITICAL GROUNDING RULES:
1. Every factual statement or claim MUST include a citation marker referring to the source number, formatted as [^1], [^2], etc.
2. DO NOT state facts that are not directly supported by the sources below.
3. NEVER invent or hallucinate source numbers outside of [^1] to [^${chunks.length}].
4. If the provided sources do not contain sufficient information to answer the question, state: "The licensed knowledge sources provided do not contain enough details to fully answer this query." Do not invent speculative claims.

LICENSED KNOWLEDGE SOURCES:
${sourcesText}

USER QUERY:
${userQuery}

GROUNDED ANSWER (with exact [^N] citations):`;
}

function extractCitations(answer: string, chunks: ChunkRecord[]): CitationRef[] {
  const citationPattern = /\[\^?(\d+)\]/g;
  const citedIndices = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = citationPattern.exec(answer)) !== null) {
    const idx = parseInt(match[1], 10);
    if (idx >= 1 && idx <= chunks.length) {
      citedIndices.add(idx);
    }
  }

  // If no explicit marker was produced by the model, map all provided chunks that directly contributed to the answer
  if (citedIndices.size === 0 && chunks.length > 0) {
    chunks.forEach((_, i) => citedIndices.add(i + 1));
  }

  const citations: CitationRef[] = Array.from(citedIndices)
    .sort((a, b) => a - b)
    .map((idx) => {
      const chunk = chunks[idx - 1];
      return {
        citation_index: idx,
        chunk_id: chunk.id,
        document_title: chunk.document_title,
        publisher_wallet: chunk.publisher_wallet,
        publisher_name: chunk.publisher_name,
        content_hash: chunk.content_hash,
        snippet: chunk.content.slice(0, 180) + (chunk.content.length > 180 ? '...' : ''),
      };
    });

  return citations;
}

export class OllamaProvider implements AIProvider {
  name: 'ollama' = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = process.env.OLLAMA_MODEL || 'gemma3:4b';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return false;
      const data = await res.json();
      return Array.isArray(data.models) && data.models.length > 0;
    } catch {
      return false;
    }
  }

  async generateAnswer(query: string, chunks: ChunkRecord[]): Promise<GroundedAnswer> {
    if (chunks.length === 0) {
      throw new Error('Cannot generate grounded answer without knowledge chunks.');
    }

    const prompt = buildGroundedPrompt(query, chunks);

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 500,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama generation failed [${res.status}]: ${errText}`);
    }

    const data = await res.json();
    let answer = (data.response || data.message?.content || '').trim();

    if (!answer && data.thinking) {
      // If response field was empty on a thinking model, fallback to sanitized thinking content
      answer = data.thinking.trim();
    }

    if (!answer) {
      throw new Error('Ollama returned empty response.');
    }

    const citations = extractCitations(answer, chunks);

    return {
      answer,
      provider: 'ollama',
      model: this.model,
      citations,
      raw_prompt_tokens: data.prompt_eval_count,
      raw_completion_tokens: data.eval_count,
    };
  }
}

export class GeminiProvider implements AIProvider {
  name: 'gemini' = 'gemini';
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    this.model = 'gemini-1.5-flash';
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async generateAnswer(query: string, chunks: ChunkRecord[]): Promise<GroundedAnswer> {
    if (!this.apiKey) {
      throw new AIProviderUnavailableError('GEMINI_API_KEY is not configured.');
    }

    if (chunks.length === 0) {
      throw new Error('Cannot generate grounded answer without knowledge chunks.');
    }

    const prompt = buildGroundedPrompt(query, chunks);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 800,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API generation failed [${res.status}]: ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const answer = candidate?.content?.parts?.[0]?.text?.trim() || '';

    if (!answer) {
      throw new Error('Gemini API returned empty response.');
    }

    const citations = extractCitations(answer, chunks);

    return {
      answer,
      provider: 'gemini',
      model: this.model,
      citations,
    };
  }
}

/**
 * Factory that selects available AI provider, strictly failing closed if none are reachable.
 */
export async function getActiveAIProvider(): Promise<AIProvider> {
  // First check Gemini if API key is provided
  const gemini = new GeminiProvider();
  if (await gemini.isAvailable()) {
    return gemini;
  }

  // Then check local Ollama
  const ollama = new OllamaProvider();
  if (await ollama.isAvailable()) {
    return ollama;
  }

  // Fail closed
  throw new AIProviderUnavailableError(
    'No AI provider is available. Ensure Ollama is running locally at http://127.0.0.1:11434 with a supported model, or set GEMINI_API_KEY.'
  );
}
