/**
 * Type declarations for the deep import of `pdf-parse`.
 *
 * `pdf-parse`'s package entry point runs a debug block when it is loaded
 * outside of a CommonJS parent, so `lib/chunker.ts` imports
 * `pdf-parse/lib/pdf-parse.js` directly. That subpath has no published types,
 * so it is declared here.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }

  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;

  export default pdfParse;
}
