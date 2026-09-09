/**
 * The wire carries the whole claim profile; the rendered view is a projection OF
 * it (AII-014, WP-B02's remainder).
 *
 * WHAT THIS FILE IS FOR, AND WHY THE EXISTING TESTS DO NOT COVER IT.
 *
 * `test/claim-support-axes.test.ts` compares the wire's axis VOCABULARIES
 * against `src/epistemic/` by reading both files as text. That catches a union
 * that drifts. It cannot catch a route that transports a value outside its own
 * union, because nothing on the server re-checks a hand-written literal against
 * the kernel's ladder, and the browser compiles against a declaration rather
 * than against the bytes.
 *
 * `test/claim-support.test.ts` probes the live routes, but asserts
 * `typeof support[axis] === 'string'` over four field names. That is the exact
 * shape of assertion CLAUDE.md warns is insufficient: a contract test asserting
 * a field is PRESENT does not catch a declaration that disagrees with the wire.
 * `reconciliation.runs` was present, and a number, and wrong.
 *
 * So this file asserts the VALUE, on every axis the kernel names, over every
 * claim route, against the kernel's own arrays imported at runtime — not
 * against the wire's copy of them, which is the thing under test.
 *
 * And it pins the projection. A payload shaped by what today's reader happens
 * to render is the defect: the axes nobody transports are where a claim's real
 * standing goes to be lost. The profile is transported once; the four-axis view
 * the spine reads is a NAMED function of it, applied where the pixels are, that
 * declares which axes it drops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { EPISTEMIC_STATES } from '../src/epistemic/state.ts';
import {
  AUTHENTICITY,
  CAUSALITY,
  COVERAGE,
  DECISION_FITNESS,
  FINALITY,
  INTEGRITY,
  MEASUREMENT,
  MONETARY_BASIS,
  SCOPE_STATUS,
} from '../src/epistemic/profile.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

/**
 * The kernel's ladders, keyed by the kernel's own axis names.
 *
 * Imported, not transcribed. A test that restates the members would pass
 * against a wire that had drifted from the kernel in the same direction the
 * test drifted, which is no test at all.
 */
const LADDERS: Readonly<Record<string, readonly string[]>> = {
  epistemic: EPISTEMIC_STATES,
  integrity: INTEGRITY,
  authenticity: AUTHENTICITY,
  scope: SCOPE_STATUS,
  coverage: COVERAGE,
  measurement: MEASUREMENT,
  causality: CAUSALITY,
  monetaryBasis: MONETARY_BASIS,
  finality: FINALITY,
  decisionFitness: DECISION_FITNESS,
};

/**
 * The axes the kernel names, read from `ClaimProfileInput` itself.
 *
 * Deriving the list rather than writing it out is what makes a NEW kernel axis
 * fail here instead of being silently uncovered — the failure mode this packet
 * is about, one iteration later.
 */
function kernelAxes(): string[] {
  const source = read('src', 'epistemic', 'profile.ts');
  const block = /export interface ClaimProfileInput \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, 'ClaimProfileInput not found in the kernel source');
  return [...block[1]!.matchAll(/^\s+readonly (\w+):/gm)].map((m) => m[1]!);
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('every claim route transports every kernel axis, and every value is a member of that axis’s ladder', async () => {
  const axes = kernelAxes();
  assert.ok(axes.length >= 10, `the kernel axis extraction is vacuous (${axes.length})`);
  for (const axis of axes) {
    assert.ok(LADDERS[axis], `this test has no ladder for the kernel axis "${axis}" — a new axis is uncovered`);
  }

  const store = new Store(':memory:');
  const { base, close } = await boot(store);
  try {
    // All FOUR claim routes. `value` was the one the existing wire probe left
    // out, and it is the claim whose collapse the spine exists to refuse.
    for (const route of ['overview', 'billing', 'allocation', 'value']) {
      const res = await fetch(`${base}/api/${route}`);
      assert.equal(res.status, 200, `/api/${route}`);
      const payload = (await res.json()) as Record<string, unknown>;

      const support = payload['claimSupport'] as Record<string, unknown> | undefined;
      assert.ok(support, `/api/${route} sent no claimSupport`);

      const profile = support['profile'] as Record<string, unknown> | undefined;
      assert.ok(profile, `/api/${route} claimSupport carries no canonical profile`);

      const missing = axes.filter((axis) => !(axis in profile));
      assert.deepEqual(
        missing,
        [],
        `/api/${route} does not transport ${missing.length} kernel axis/axes: ${missing.join(', ')}`,
      );

      for (const axis of axes) {
        const value: unknown = profile[axis];
        assert.equal(typeof value, 'string', `/api/${route} profile.${axis} is not a string`);
        assert.ok(
          LADDERS[axis]!.includes(value as string),
          `/api/${route} profile.${axis} = ${JSON.stringify(value)} is not a member of the kernel ladder [${LADDERS[axis]!.join(', ')}]`,
        );
      }
    }
  } finally {
    await close();
    store.close();
  }
});

test('the rendered view is a named projection that drops exactly the axes it declares', async () => {
  // Read through `unknown`: this test's whole job is to ask what the module
  // exports, so it must not compile against the declaration it is checking.
  const claimTypes = await import('../src/dashboard/web/app/core/claimTypes.ts') as unknown as {
    RENDERED_PROFILE_AXES?: readonly string[];
    DROPPED_PROFILE_AXES?: readonly string[];
    projectRenderedAxes?: (profile: Record<string, string>) => Record<string, string>;
  };

  const rendered = claimTypes.RENDERED_PROFILE_AXES;
  const dropped = claimTypes.DROPPED_PROFILE_AXES;
  const project = claimTypes.projectRenderedAxes;
  assert.ok(rendered, 'the browser declares no RENDERED_PROFILE_AXES: the projection is unnamed');
  assert.ok(dropped, 'the browser declares no DROPPED_PROFILE_AXES: nothing states which axes the view drops');
  assert.equal(typeof project, 'function', 'the four-axis view is not a named projection function');

  const axes = kernelAxes();

  // Declared, not assumed: every kernel axis is either rendered or explicitly
  // dropped, and none is both. An axis that appeared in neither list would be
  // one the GUI silently forgot, which is the whole defect.
  assert.deepEqual(
    [...rendered!, ...dropped!].slice().sort(),
    axes.slice().sort(),
    'the rendered and dropped lists must together be exactly the kernel’s axes',
  );
  assert.equal(
    new Set([...rendered!, ...dropped!]).size,
    axes.length,
    'an axis is declared both rendered and dropped',
  );

  // A profile whose every axis holds a distinct, non-default ladder member, so
  // a projection that returned a constant, or read the wrong axis, cannot pass.
  const profile: Record<string, string> = {};
  for (const axis of axes) profile[axis] = LADDERS[axis]![LADDERS[axis]!.length - 1]!;

  const view = project!(profile);
  assert.deepEqual(
    Object.keys(view).slice().sort(),
    rendered!.slice().sort(),
    'the projection returns keys other than the ones it declares it renders',
  );
  for (const axis of rendered!) {
    assert.equal(view[axis], profile[axis], `the projection changed ${axis} rather than copying it`);
  }
  for (const axis of dropped!) {
    assert.ok(!(axis in view), `${axis} is declared dropped but is in the projection`);
  }
});

test('the payload transports the profile once, not a view-shaped flattening beside it', () => {
  // The remainder AII-014 names. The wire grew a canonical ten-axis profile and
  // KEPT the three-axis flat copy the GUI used to read, so the payload still
  // carried a view of the claim next to the claim. Two statements of one
  // judgement is how they come apart — and the flat copy was believed by the
  // browser, so a server that projected wrongly could not be caught by anything
  // downstream. Where the projection lives is not a style question: applied at
  // the point of render, over the transported profile, there is nothing for a
  // second statement to disagree with.
  const wire = read('src', 'dashboard', 'shared-types.ts');
  const block = /export interface ClaimSupportPayload \{([\s\S]*?)\n\}/.exec(wire);
  assert.ok(block, 'ClaimSupportPayload not found on the wire');

  const fields = [...block[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
  assert.ok(fields.includes('profile'), 'the payload must carry the canonical profile');

  const flattened = kernelAxes().filter((axis) => fields.includes(axis));
  assert.deepEqual(
    flattened,
    [],
    `the payload flattens ${flattened.length} profile axis/axes beside the profile: ${flattened.join(', ')}`,
  );

  // `figure` is not a profile axis and must stay: whether a band shows a number
  // is a rendering decision, and the kernel has no opinion about rendering.
  assert.ok(fields.includes('figure'), 'the payload must still state why the value slot shows what it shows');
});
