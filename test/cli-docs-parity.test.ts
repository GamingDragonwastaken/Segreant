/**
 * Every command the CLI dispatches is documented in `help all` and in
 * docs/GUIDE.md, except named aliases whose target is. The launch bar's L5
 * ("every feature documented, none hidden") found `alloc` and `statusline`
 * missing from `help all`, ten commands missing from the GUIDE, and both
 * describing bare `segreant` as `guide` when it runs `home`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Alias -> the command it runs, which must itself be documented. */
const ALIASES: Record<string, string> = {
  allocation: 'alloc', baselines: 'baseline', diagnostic: 'diagnostics', economics: 'economic',
  limits: 'quota', next: 'guide', plans: 'plan', projects: 'project', realization: 'realize',
  receipts: 'receipt', status: 'today', study: 'causal', version: '--version', help: 'help', home: '(no command)',
};

const source = readFileSync('src/cli.ts', 'utf8');
const dispatched = [...new Set([...source.matchAll(/^ {4}case '([a-z][a-z-]*)'/gm)].map((m) => m[1]!))];
const helpAll = execFileSync(process.execPath, ['bin/segreant.mjs', 'help', 'all'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const guide = readFileSync('docs/GUIDE.md', 'utf8');

test('the dispatch table was read', () => {
  assert.ok(dispatched.length > 40, `found ${dispatched.length} commands`);
});

test('every dispatched command is in `help all`, or is a named alias of one that is', () => {
  const inHelp = (verb: string) => new RegExp(`^ {4}(?:[a-z-]+ \\| )*${verb.replace(/[-()]/g, '\\$&')}\\b`, 'm').test(helpAll)
    || (verb === '(no command)' && helpAll.includes('(no command)'))
    || (verb === '--version' && helpAll.includes('--version'));
  const missing = dispatched.filter((verb) => !inHelp(ALIASES[verb] ?? verb));
  assert.deepEqual(missing, [], `not in help all: ${missing.join(', ')}`);
});

test('every dispatched command appears in GUIDE.md as `segreant <command>`', () => {
  const inGuide = (verb: string) => (verb === '--version' && /segreant --version\b/.test(guide))
    || (verb === '(no command)' ? /^segreant +Bare:/m.test(guide) : new RegExp(`segreant (?:[a-z-]+ \\| )*${verb}\\b`).test(guide));
  const missing = dispatched.filter((verb) => !inGuide(ALIASES[verb] ?? verb));
  assert.deepEqual(missing, [], `not in GUIDE: ${missing.join(', ')}`);
});
