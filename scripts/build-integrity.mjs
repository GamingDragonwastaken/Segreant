import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

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
    files.push({ path: relativePath.replaceAll(sep, '/'), bytes: readFileSync(path) });
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
