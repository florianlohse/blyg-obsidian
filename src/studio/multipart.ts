// A multipart/form-data body, built by hand: Obsidian's requestUrl takes a string or bytes, not FormData (the same on iOS and desktop).
// Pure: the boundary is passed in. Field names and values are the plugin's own (never free text); the file name is made ASCII-safe.

export interface MultipartFile {
  field: string;
  /** Shown to the server only; made safe here. */
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

export const safeFileName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";

export function buildMultipart(boundary: string, fields: Record<string, string>, file: MultipartFile): { body: ArrayBuffer; contentType: string } {
  const text = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(text.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(text.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeFileName(file.name)}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  parts.push(new Uint8Array(file.bytes));
  parts.push(text.encode(`\r\n--${boundary}--\r\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A boundary no part of a body contains in practice: random, from Web Crypto. */
export function newBoundary(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `----blyg${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
