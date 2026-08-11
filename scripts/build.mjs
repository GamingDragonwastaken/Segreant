import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(dist, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const dashboardSource = join(root, 'src', 'dashboard', 'web');
const dashboardOutput = join(dist, 'dashboard', 'web');
if (!existsSync(dashboardSource)) throw new Error('Dashboard static assets are missing from src/dashboard/web.');
cpSync(dashboardSource, dashboardOutput, { recursive: true });
