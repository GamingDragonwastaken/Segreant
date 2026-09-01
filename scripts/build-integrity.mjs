import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Windows fails an open with EBUSY/EPERM while another process holds the file
 * for writing, where POSIX simply reads the old or new bytes. A concurrent
 * build rewriting a generated source is exactly that case, and it is transient
 * by construction — the writer holds the handle for microseconds.
 *
 * A bounded synchronous retry is the whole remedy. It does not paper over a
 * race in the fingerprint itself: whichever generation this read lands on, the
 * publication lock is what decides which build wins, and a fingerprint of a
 * half-superseded generation still differs from the expected one and still
 * fails the assertion it feeds. What the retry removes is a crash where a
 * comparison was intended.
 */
function readFileWithRetry(path) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      return readFileSync(path);
    } catch (error) {
      const transient = error?.code === 'EBUSY' || error?.code === 'EPERM';
      if (!transient || Date.now() >= deadline) throw error;
      // Synchronous: this runs inside a synchronous recursive walk, and the
      // wait is bounded by the deadline above.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/**
 * Return a deterministic content fingerprint for the inputs a build reads.
 *
 * The fingerprint intentionally covers bytes and relative paths rather than
 * mtimes: editors and source-control operations are free to preserve or reset
 * timestamps, while a changed source generation must change the digest. The
 * caller chooses the input roots so --web remains a browser-only build and a
 * full build covers the complete src tree plus both compiler configurations.
 */
export function sourceFingerprint(root, inputPaths) {
  const files = [];

  function collect(path, relativePath) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        collect(join(path, entry.name), join(relativePath, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported build input type: ${path}`);
    files.push({ path: relativePath.replaceAll(sep, '/'), bytes: readFileWithRetry(path) });
  }

  for (const inputPath of inputPaths) {
    collect(join(root, inputPath), inputPath.replaceAll(sep, '/'));
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const file of files) {
    // Length-prefixing the path and content keeps concatenation unambiguous.
    hash.update(String(file.path.length));
    hash.update(':');
    hash.update(file.path);
    hash.update(String(file.bytes.length));
    hash.update(':');
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}
