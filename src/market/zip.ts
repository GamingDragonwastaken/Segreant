/**
 * Minimal, bounded ZIP reader for one public data archive (Epoch AI's
 * benchmark bundle). Reads the central directory, supports stored and
 * deflated entries, and refuses anything else rather than guessing.
 * Zero dependencies: node:zlib does the inflating.
 */
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export function readZipEntries(zip: Buffer, wanted: ReadonlySet<string>): Map<string, Buffer> {
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.has(name)) continue;
    if (size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${name}`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header: ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES }) : null;
    if (!data) throw new Error(`unsupported zip compression method ${method}: ${name}`);
    if (data.length !== size) throw new Error(`zip entry size mismatch: ${name}`);
    out.set(name, data);
  }
  return out;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Returns header-keyed rows. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
