/**
 * Capability coverage is an operator-facing product claim. A full GUI label on
 * a consequential CLI operation must mean the GUI can actually finish that
 * operation, rather than merely showing its terminal spelling in a drawer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = readFileSync(
  join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'core', 'registry.ts'),
  'utf8',
);
const ACTIONS = readFileSync(
  join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'core', 'actions.ts'),
  'utf8',
);

interface CapabilityRow {
  id: string;
  consequence: string;
  coverage: string;
}

function capabilityRows(): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  const row = /id:\s*'([^']+)'[\s\S]*?consequence:\s*'([^']+)'[\s\S]*?coverage:\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = row.exec(REGISTRY)) !== null) {
    rows.push({ id: match[1]!, consequence: match[2]!, coverage: match[3]! });
  }
  return rows;
}

function actionBlock(id: string): string | null {
  const quotedNeedle = "'" + id + "':";
  const bareNeedle = id + ':';
  const quotedStart = ACTIONS.indexOf(quotedNeedle);
  const bareStart = ACTIONS.indexOf(bareNeedle);
  const start = quotedStart >= 0 ? quotedStart : bareStart;
  if (start < 0) return null;
  const topLevel = /^  (?:'[^']+'|[a-z][a-z-]*):/gm;
  let next = -1;
  let match: RegExpExecArray | null;
  while ((match = topLevel.exec(ACTIONS)) !== null) {
    if (match.index > start) {
      next = match.index;
      break;
    }
  }
  return ACTIONS.slice(start, next < 0 ? undefined : next);
}

test('every consequential capability marked full has an executable GUI runner', () => {
  const fullConsequential = capabilityRows().filter(
    (cap) => cap.coverage === 'full' && cap.consequence !== 'read',
  );
  assert.ok(fullConsequential.length > 0, 'the GUI must retain at least one consequential full-parity path');

  for (const cap of fullConsequential) {
    const block = actionBlock(cap.id);
    assert.ok(block, cap.id + ' is marked full but the GUI has no action builder');
    assert.match(
      block!,
      /\b(commit|download):/,
      cap.id + ' is marked full but the GUI cannot commit or download its result',
    );
  }
});

test('consequential capabilities without an executable GUI runner are not marked full', () => {
  const incomplete = capabilityRows().filter(
    (cap) => cap.consequence !== 'read' && (!actionBlock(cap.id) || !/\b(commit|download):/.test(actionBlock(cap.id)!)),
  );
  assert.ok(incomplete.length > 0, 'expected incomplete GUI capabilities to remain visible to the operator');
  for (const cap of incomplete) {
    assert.notEqual(cap.coverage, 'full', cap.id + ' lacks an executable GUI runner and must not claim full coverage');
  }
});
