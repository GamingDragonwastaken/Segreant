/**
 * Suppress the one Node experimental warning we knowingly accept: node:sqlite.
 * Importing this module before node:sqlite keeps the daemon's stdout clean
 * without hiding any other warnings the user should actually see.
 */

const originalEmitWarning = process.emitWarning.bind(process);

// Signature is overloaded; wrap loosely and forward everything else untouched.
process.emitWarning = function patchedEmitWarning(
  warning: string | Error,
  ...rest: unknown[]
): void {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : '';
  if (/SQLite is an experimental feature/i.test(text) || type === 'ExperimentalWarning') {
    if (/SQLite/i.test(text)) return;
  }
  // @ts-expect-error — forwarding the original overloaded signature
  return originalEmitWarning(warning, ...rest);
};
