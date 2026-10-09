/**
 * The quota view: the vendors' meters read from their logs, the pace to the
 * reset (an estimate), and the meter set beside Segreant's own count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexRateLimitEvents, claudeLimitEvent, nextLocalTime, type QuotaEvent } from '../src/quota/limits.ts';
import { windowView, meterCheck, claudeLimitView, quotaView } from '../src/quota/view.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-10-05T00:00:00Z');

function snap(kind: 'codex_primary' | 'codex_secondary', ts: number, used: number, resets: number, minutes: number): QuotaEvent {
  return { source: 'codex', kind, tsEpochMs: ts, usedPercent: used, windowMinutes: minutes, resetsAtMs: resets, detail: null };
}

test('Codex rate_limits become one event per window, in milliseconds', () => {
  const ev = codexRateLimitEvents({
    primary: { used_percent: 25, window_minutes: 300, resets_at: 1_791_492_967 },
    secondary: { used_percent: 65, window_minutes: 10_080, resets_at: 1_791_951_811 },
  }, T0);
  assert.deepEqual(ev.map((e) => [e.kind, e.usedPercent, e.windowMinutes, e.resetsAtMs]), [
    ['codex_primary', 25, 300, 1_791_492_967_000],
    ['codex_secondary', 65, 10_080, 1_791_951_811_000],
  ]);
  assert.deepEqual(codexRateLimitEvents(null, T0), []);
  assert.deepEqual(codexRateLimitEvents({ primary: { used_percent: 'x' } }, T0), []);
});

test('a Claude limit counts only on the vendor error line, never when quoted', () => {
  const vendor = JSON.stringify({ isApiErrorMessage: true, message: { content: "You've hit your weekly limit · resets 4am (Africa/Cairo)" } });
  const quoted = JSON.stringify({ type: 'user', message: { content: "it said You've hit your weekly limit · resets 4am (Africa/Cairo)" } });
  const e = claudeLimitEvent(vendor, Date.parse('2026-10-05T14:00:00Z'));
  assert.equal(e?.kind, 'claude_weekly');
  assert.equal(e?.resetsAtMs, Date.parse('2026-10-06T01:00:00Z'), '4am Cairo (UTC+3) the next morning');
  assert.equal(claudeLimitEvent(quoted, T0), null);
});

test('a local reset time resolves to the next occurrence in its own zone', () => {
  const at = Date.parse('2026-10-05T14:00:00Z'); // 17:00 in Cairo
  assert.equal(nextLocalTime('6:40pm', 'Africa/Cairo', at), Date.parse('2026-10-05T15:40:00Z'));
  assert.equal(nextLocalTime('5pm', 'Africa/Cairo', at), Date.parse('2026-10-06T14:00:00Z'), 'not the instant itself');
  assert.equal(nextLocalTime('6:40pm', 'Not/AZone', at), null);
  assert.equal(nextLocalTime('25pm', 'Africa/Cairo', at), null);
});

test('pace: a projection at the reset, a limit time only before the reset, and nothing once reset', () => {
  // A 10-hour window opened at T0; at 2h in, 40% used => 20%/h => 100% at 5h, before the 10h reset.
  const fast = windowView(snap('codex_primary', T0 + 2 * H, 40, T0 + 10 * H, 600), T0 + 2 * H);
  assert.equal(fast.limitAtMs, T0 + 5 * H);
  assert.ok(Math.abs(fast.projectedAtResetPercent! - 200) < 1e-9);
  const slow = windowView(snap('codex_primary', T0 + 5 * H, 20, T0 + 10 * H, 600), T0 + 5 * H);
  assert.equal(slow.limitAtMs, null, 'the reset comes first');
  assert.ok(Math.abs(slow.projectedAtResetPercent! - 40) < 1e-9);
  const past = windowView(snap('codex_primary', T0 + 5 * H, 20, T0 + 10 * H, 600), T0 + 11 * H);
  assert.equal(past.reset, true);
  assert.equal(past.projectedAtResetPercent, null);
});

test('meter check: list cost per 1% this window against earlier windows, with a band', () => {
  const week = 10_080;
  const W = 7 * 24 * H;
  const events = [1, 2, 3, 4].map((i) => snap('codex_secondary', T0 + i * W - H, 50, T0 + i * W, week));
  // $100 per window => $2 per 1% everywhere, except the newest window at $500.
  const spend = (_s: string, start: number) => (start >= T0 + 3 * W ? 500 : 100);
  const check = meterCheck(events, spend);
  assert.equal(check.currentUsdPerPercent, 10);
  assert.deepEqual(check.earlierUsdPerPercent, [2, 2, 2]);
  assert.equal(check.agrees, false, '5x the earlier median is outside the band');
  const steady = meterCheck(events, () => 100);
  assert.equal(steady.agrees, true);
  assert.equal(meterCheck(events.slice(-2), () => 100).agrees, null, 'one earlier window is too little to compare');
});

test('Claude: parallel agents hitting one wall count once, and the window before each hit is summed', () => {
  const reset = T0 + 6 * H;
  const hit = (ts: number): QuotaEvent => ({ source: 'claude-code', kind: 'claude_session', tsEpochMs: ts, usedPercent: null, windowMinutes: 300, resetsAtMs: reset, detail: 'x' });
  const v = claudeLimitView([hit(T0 + 4 * H), hit(T0 + 4 * H + 60_000)], (_s, a, b) => (b - a) / H * 10, T0 + 8 * H)!;
  assert.equal(v.sessionHits, 1);
  assert.equal(v.usdBeforeSessionHit.length, 1);
  // From reset - 5h (T0+1h) to the first hit (T0+4h): 3 hours at $10/h.
  assert.ok(Math.abs(v.usdBeforeSessionHit[0]! - 30) < 1e-3);
  assert.equal(quotaView([], () => 0, T0).claude, null, 'no use and no messages: nothing to say');
});
