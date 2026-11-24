/**
 * Finding and reading the line logs other tools write.
 *
 * A tool may compress a finished log where it lies: Codex rewrites
 * `rollout-*.jsonl` as `rollout-*.jsonl.zst` once a session goes quiet. Reading
 * only `.jsonl` then loses that session's usage without any sign, so a log in a
 * form this build does not read is counted and reported, never skipped in silence.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { basename, join } from 'node:path';
import { RESOURCE_LIMITS } from '../util/resource-limits.ts';

const READABLE = /\.jsonl(?:\.zst|\.gz)?$/i;
const COMPRESSED_OTHERWISE = /\.jsonl\.(?:br|bz2|lz4|xz|zip|7z|lzma|snappy)$/i;

export interface LogFileScan {
  files: string[];
  /** A file or directory budget was reached, so `files` is a prefix. */
  truncated: boolean;
  /** Logs compressed in a form this build does not read. */
  unsupported: number;
}

/** A log's name without its compression suffix: the same before and after the tool compresses it. */
export function logBaseName(file: string): string {
  return basename(file).replace(/\.(?:zst|gz)$/i, '');
}

/**
 * List a directory tree's logs without materializing the whole recursive
 * listing. Symlinks are not followed: native tool logs are local files, and a
 * link could expose a second tree. A budget that is reached is reported.
 */
export function boundedJsonlFiles(root: string): LogFileScan {
  const files: string[] = [];
  const pending = [root];
  let directories = 0;
  let truncated = false;
  let unsupported = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    directories += 1;
    if (directories > RESOURCE_LIMITS.importDirectories) {
      truncated = true;
      break;
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (directories + pending.length >= RESOURCE_LIMITS.importDirectories) {
          truncated = true;
          break;
        }
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!READABLE.test(entry.name)) {
        if (COMPRESSED_OTHERWISE.test(entry.name)) unsupported += 1;
        continue;
      }
      if (files.length >= RESOURCE_LIMITS.importFiles) {
        truncated = true;
        break;
      }
      try {
        if (statSync(full).isFile()) files.push(full);
      } catch {
        /* vanished mid-scan: skip */
      }
    }
    if (truncated) break;
  }
  return { files, truncated, unsupported };
}

/** Whether an error came from reading or decompressing a log, rather than from recording what it said. */
export function isUnreadableLog(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('Z_') || code.startsWith('ZSTD_') || code.startsWith('ERR_ZSTD') || code.startsWith('ERR_ZLIB')
    || ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE', 'ESTALE', 'UNKNOWN'].includes(code));
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Yield a log's lines, decompressing as it reads. A line over the byte limit is
 * dropped without being held in memory, and reported with the record type its
 * first bytes name (null when they name none); the lines after it are still
 * read. Throws when the file cannot be read or decompressed to its end.
 */
export async function* readLogLines(file: string, onOversizedLine?: (kind: string | null) => void): AsyncGenerator<string> {
  const raw = createReadStream(file, { highWaterMark: 256 * 1024 });
  const lower = file.toLowerCase();
  const inflate = lower.endsWith('.zst') ? createZstdDecompress() : lower.endsWith('.gz') ? createGunzip() : null;
  if (inflate !== null) {
    raw.on('error', (error) => inflate.destroy(error));
    raw.pipe(inflate);
  }
  const limit = RESOURCE_LIMITS.transcriptLineBytes;
  let held: Buffer[] = [];
  let heldBytes = 0;
  let oversized = false;
  let atStart = true;

  const hold = (part: Buffer): void => {
    if (oversized || part.length === 0) return;
    heldBytes += part.length;
    if (heldBytes > limit) {
      const start = Buffer.concat([...held, part].slice(0, 2)).subarray(0, 1024).toString('latin1');
      oversized = true;
      held = [];
      onOversizedLine?.(/"type"\s*:\s*"([^"]*)"/.exec(start)?.[1] ?? null);
      return;
    }
    held.push(part);
  };
  /** The held bytes as one line, or null when the line was dropped. */
  const release = (): string | null => {
    const dropped = oversized;
    let bytes = held.length === 1 ? held[0]! : Buffer.concat(held);
    held = [];
    heldBytes = 0;
    oversized = false;
    const wasStart = atStart;
    atStart = false;
    if (dropped) return null;
    if (bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN) bytes = bytes.subarray(0, -1);
    const text = bytes.toString('utf8');
    return wasStart && text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  };

  try {
    for await (const chunk of (inflate ?? raw) as AsyncIterable<Buffer>) {
      let from = 0;
      for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, from)) {
        hold(chunk.subarray(from, at));
        from = at + 1;
        const line = release();
        if (line !== null) yield line;
      }
      hold(chunk.subarray(from));
    }
    if (heldBytes > 0) {
      const line = release();
      if (line !== null) yield line;
    }
  } finally {
    raw.destroy();
    inflate?.destroy();
  }
}
