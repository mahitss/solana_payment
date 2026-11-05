import { ChunkRecord } from '../documents';

export interface CitationRef {
  citation_index: number;
  chunk_id: string;
  document_title: string;
  publisher_wallet: string;
  publisher_name: string;
  content_hash: string;
  snippet: string;
}

export interface GroundedAnswer {
  answer: string;
  provider: 'ollama' | 'gemini';
  model: string;
  citations: CitationRef[];
  raw_prompt_tokens?: number;
  raw_completion_tokens?: number;
}

export interface AIProvider {
  name: 'ollama' | 'gemini';
  isAvailable(): Promise<boolean>;
  generateAnswer(query: string, chunks: ChunkRecord[]): Promise<GroundedAnswer>;
}
