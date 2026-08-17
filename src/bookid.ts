// Content identity of a book (WP-M «Долговечность данных»). Per-book files
// (translation stores, glossaries) used to be named by a hash of the book
// PATH — moving or renaming the file orphaned an hours-long translation. The
// durable name is content-derived: djb2 over the first 64 KB plus the byte
// length. It is computed wherever the book's bytes are already in memory
// (viewer open, run doc open) — no extra disk reads — cached per path for the
// session, and read by booktranslate/translate to name per-book files. The
// old path-hash naming stays as a read fallback for files written before this
// scheme; bindBook (booktranslate.ts) migrates them on first open.

const HEAD = 65536;

export function contentKey(bytes: Uint8Array): string {
  let h = 5381;
  const n = Math.min(bytes.length, HEAD);
  for (let i = 0; i < n; i++) h = ((h << 5) + h + bytes[i]) >>> 0;
  return `${h.toString(16)}-${bytes.length.toString(16)}`;
}

const keys = new Map<string, string>();

export const bookKey = (bookPath: string): string | null => keys.get(bookPath) ?? null;
export const setBookKey = (bookPath: string, key: string): void => void keys.set(bookPath, key);
