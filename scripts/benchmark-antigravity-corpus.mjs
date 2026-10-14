/** Run one synthetic Antigravity import in a new, disposable ordinary ledger. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (i + 1 >= process.argv.length) throw new Error(`--${name} needs a value`);
  return process.argv[i + 1];
};
const rootArg = arg('root');
if (!rootArg) throw new Error('pass --root with a generated synthetic source directory');
const root = resolve(rootArg);
const recentDays = Number(arg('recent-days', '0'));
if (!Number.isSafeInteger(recentDays) || recentDays < 0 || recentDays > 365) throw new Error('--recent-days must be 0..365');
const observe = process.argv.includes('--observe');
const home = await mkdtemp(join(tmpdir(), 'segreant-antigravity-bench-'));
process.env.SEGREANT_HOME = home;
delete process.env.SEGREANT_DB;
delete process.env.SEGREANT_DEMO;

let store;
try {
  const [{ Store }, { importAntigravity }] = await Promise.all([
    import('../dist/store/db.js'), import('../dist/connect/antigravity.js'),
  ]);
  store = new Store(join(home, 'segreant.db'));
  let profile;
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const summary = await importAntigravity(store, {
    root,
    ...(recentDays > 0 ? { sinceMs: Date.now() - recentDays * 86_400_000 } : {}),
    ...(observe ? { onProfile: (value) => { profile = value; } } : {}),
  });
  const durationMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const rssAfter = process.memoryUsage().rss;
  process.stdout.write(`${JSON.stringify({
    synthetic: true, recentDays, observed: observe, durationMs,
    cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
    rssBefore, rssAfter, inserted: summary.inserted, eventsSeen: summary.eventsSeen,
    files: summary.files, filesDeferred: summary.filesDeferred ?? 0,
    filesUnchanged: summary.filesUnchanged ?? 0, captureCoverage: summary.captureCoverage ?? 'complete',
    ...(profile ? { profile } : {}),
  })}\n`);
} finally {
  store?.close();
  await rm(home, { recursive: true, force: true });
}
