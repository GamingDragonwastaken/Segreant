/**
 * The modern Control view must expose the alert detector coverage already
 * computed by the today overview. An empty alert array is not a negative claim
 * when some channels are structurally dark, so the browser has to show the
 * producer's reasons rather than silently rendering nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dashboardPayloadContract,
  validateDashboardPayload,
} from '../src/dashboard/contracts.ts';

const CONTROL = join(
  import.meta.dirname,
  '..',
  'src',
  'dashboard',
  'web',
  'app',
  'views',
  'control.ts',
);

test('the overview boundary requires the alert coverage that qualifies an empty alert list', () => {
  const contract = dashboardPayloadContract('overview', 'GET');
  assert.ok(
    contract.required.some((field) => field.name === 'alertCoverage' && field.kind === 'object'),
    'overview must require the coverage object beside alerts',
  );

  const withoutCoverage = {
    claimSupport: {}, range: 'today', demo: false, generatedAt: 'now', budget: {}, summary: {},
    pricing: {}, byModel: [], byProject: [], attributionEvidence: [], byUser: [], bySource: [],
    characterization: {}, dimensions: [], series: [], recent: [], alerts: [],
  };
  assert.throws(
    () => validateDashboardPayload(contract, withoutCoverage),
    /overview\.GET\.alertCoverage.*required/i,
  );

  assert.doesNotThrow(() => validateDashboardPayload(contract, {
    ...withoutCoverage,
    alertCoverage: { channels: [], liveChannels: 0, complete: false, summary: 'coverage is partial' },
  }));
});
test('modern Control consumes today coverage and renders dark reasons without claiming no alerts', () => {
  const source = readFileSync(CONTROL, 'utf8');

  assert.match(source, /api\.overview\('today'\)/, 'coverage must stay on the today-scoped alert observation');
  assert.match(source, /alertCoverage/, 'Control must consume the overview coverage object');
  assert.match(source, /coverage\.summary/, 'the producer summary must reach the operator');
  assert.match(source, /coverage\.complete/, 'the view must distinguish complete from partial coverage');
  assert.match(source, /channel\.live/, 'the view must distinguish watching channels from dark channels');
  assert.match(source, /channel\.darkBecause/, 'dark channels must expose the producer reason');

  // An incomplete observation cannot be rendered as a clean negative result.
  assert.doesNotMatch(
    source,
    /!coverage\.complete[\s\S]{0,320}(?:no alerts|nothing fired|all clear)/i,
    'partial coverage must not be labelled as no alerts or all clear',
  );
});
