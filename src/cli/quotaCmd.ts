/**
 * `segreant quota`: each vendor's own usage meter, read from its tool's logs,
 * the pace to the next reset, and whether the meter moves in step with what
 * Segreant counted. Imports first, so the reading is as fresh as the logs.
 */
import { Store } from '../store/db.ts';
import { dbPath } from '../config.ts';
import { quotaView, median, type WindowView } from '../quota/view.ts';
import { statuslineLine } from '../quota/statusline.ts';
import { readFileSync } from 'node:fs';
import { detectPlans, planName } from '../plans/detect.ts';
import { C, color, usd, printJson } from './ui.ts';
import type { Flags } from './flags.ts';

const DAY = 86_400_000;

function when(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function inFor(ms: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((ms - nowMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ${mins % 60}m` : `${Math.round(h / 24)}d`;
}

function windowLabel(w: WindowView): string {
  if (w.windowMinutes === 300) return '5-hour';
  if (w.windowMinutes === 10_080) return 'weekly';
  return w.windowMinutes === null ? 'window' : `${Math.round(w.windowMinutes / 60)}-hour`;
}

const STATUSLINE_SETUP = `  Add this to ~/.claude/settings.json (or merge it into an existing statusLine):

    "statusLine": { "type": "command", "command": "segreant-statusline" }

  Claude Code then hands Segreant its live usage meter (5-hour and weekly percentages)
  each time the status line refreshes. Segreant records a reading when it changes and
  prints one short line. Nothing leaves your machine; segreant quota shows the history.`;

/**
 * `segreant statusline`: the same lean path as the `segreant-statusline` bin
 * (src/quota/statusline.ts), reachable through the full CLI for convenience.
 * The bin is what the setup snippet names, because it starts far faster.
 */
export function cmdStatusline(flags: Flags): void {
  if (flags.setup) {
    console.log(STATUSLINE_SETUP);
    return;
  }
  let raw = '';
  try { raw = readFileSync(0, 'utf8').slice(0, 1_000_000); } catch { raw = ''; }
  process.stdout.write(statuslineLine(dbPath(), raw, Date.now()) + '\n');
}

export function cmdQuota(flags: Flags): void {
  const store = new Store(dbPath());
  const now = Date.now();
  const events = store.quotaEvents(now - 35 * DAY);
  const view = quotaView(events, (source, a, b) => store.sourceCostBetween(source, a, b), now);
  store.close();
  if (flags.json) {
    printJson({ generatedAtMs: now, ...view });
    return;
  }
  const tty = process.stdout.isTTY ?? false;
  const plans = new Map(detectPlans().map((p) => [p.source, planName(p)]));
  console.log('');
  console.log(color(tty, C.bold, '  Quota') + color(tty, C.gray, "   the vendors' own meters, read from their tools' logs · refresh with segreant import all"));

  console.log('');
  console.log(color(tty, C.bold, `  Codex${plans.get('codex') ? ` (${plans.get('codex')})` : ''}`));
  if (view.codex === null) {
    console.log(color(tty, C.gray, '    No rate-limit readings in the Codex logs yet.'));
  } else {
    for (const w of view.codex.windows) {
      const label = windowLabel(w).padEnd(7);
      if (w.reset) {
        console.log(`    ${label} ${color(tty, C.gray, `reset at ${when(w.resetsAtMs!, now)}; no use logged since, so no current reading`)}`);
        continue;
      }
      const resets = w.resetsAtMs === null ? '' : ` · resets ${when(w.resetsAtMs, now)} (in ${inFor(w.resetsAtMs, now)})`;
      const tone = w.usedPercent >= 90 ? C.red : w.usedPercent >= 70 ? C.yellow : C.green;
      console.log(`    ${label} ${color(tty, tone, `${Math.round(w.usedPercent)}% used`)}${resets}${color(tty, C.gray, ` · read ${when(w.asOfMs, now)}`)}`);
      if (w.limitAtMs !== null && w.limitAtMs <= now) {
        console.log(color(tty, C.yellow, `            at the pace of that reading the limit was due ${when(w.limitAtMs, now)}; nothing has been logged since, so whether it was reached is not known yet`));
      } else if (w.limitAtMs !== null) {
        console.log(color(tty, C.yellow, `            at this pace you reach the limit ${when(w.limitAtMs, now)} (estimate: the pace since the window opened)`));
      } else if (w.projectedAtResetPercent !== null) {
        console.log(color(tty, C.gray, `            at this pace: about ${Math.round(w.projectedAtResetPercent)}% by the reset (estimate)`));
      }
    }
    const m = view.codex.weekly;
    if (m.currentUsdPerPercent !== null) {
      const earlier = median(m.earlierUsdPerPercent);
      const line = `    Segreant counted ${usd(m.currentUsdPerPercent)} of list-price work per 1% of the weekly meter this week`
        + (earlier === null ? '' : `; ${usd(earlier)} per 1% in earlier weeks (median of ${m.earlierUsdPerPercent.length})`);
      console.log(color(tty, C.gray, line));
      if (m.agrees === false) {
        console.log(color(tty, C.yellow, '    The meter and the count disagree beyond 1.5x this week. Both figures are above; the vendor may weight models or caching differently from list price.'));
      } else if (m.agrees === true) {
        console.log(color(tty, C.gray, '    The meter moves in step with what Segreant counted.'));
      }
    }
  }

  console.log('');
  console.log(color(tty, C.bold, `  Claude Code${plans.get('claude-code') ? ` (${plans.get('claude-code')})` : ''}`));
  const c = view.claude;
  if (c === null) {
    console.log(color(tty, C.gray, '    No Claude Code use or limit messages in the last 35 days.'));
  } else {
    if (view.claudeWindows.length > 0) {
      for (const w of view.claudeWindows) {
        const label = (w.kind === 'claude_spend_window' ? 'spend' : windowLabel(w)).padEnd(7);
        if (w.reset) {
          console.log(`    ${label} ${color(tty, C.gray, `reset at ${when(w.resetsAtMs!, now)}; no reading since`)}`);
          continue;
        }
        const resets = w.resetsAtMs === null ? '' : ` · resets ${when(w.resetsAtMs, now)} (in ${inFor(w.resetsAtMs, now)})`;
        const tone = w.usedPercent >= 90 ? C.red : w.usedPercent >= 70 ? C.yellow : C.green;
        console.log(`    ${label} ${color(tty, tone, `${Math.round(w.usedPercent)}% used`)}${resets}${color(tty, C.gray, ` · read ${when(w.asOfMs, now)} from the status line`)}`);
        if (w.limitAtMs !== null && w.limitAtMs > now) {
          console.log(color(tty, C.yellow, `            at this pace you reach the limit ${when(w.limitAtMs, now)} (estimate: the pace since the window opened)`));
        }
      }
    } else {
      console.log(color(tty, C.gray, '    Claude Code logs no percentage; it logs a message when a limit is reached. For the live percentage, set segreant as'));
      console.log(color(tty, C.gray, '    your Claude Code status line (segreant statusline --setup shows how), or see claude.ai/settings/usage.'));
    }
    const parts = [
      `the session limit ${c.sessionHits} time${c.sessionHits === 1 ? '' : 's'}`,
      `the weekly limit ${c.weeklyHits} time${c.weeklyHits === 1 ? '' : 's'}`,
      ...(c.spendHits > 0 ? [`the monthly spend limit ${c.spendHits} time${c.spendHits === 1 ? '' : 's'}`] : []),
    ];
    console.log(`    Last 35 days: you reached ${parts.join(', ')}.`);
    if (c.lastHit !== null) {
      const reset = c.lastHit.resetsAtMs === null ? '' : `, reset ${when(c.lastHit.resetsAtMs, now)}`;
      console.log(color(tty, C.gray, `    Last: ${when(c.lastHit.tsEpochMs, now)}${reset} ("${c.lastHit.detail ?? ''}")`));
    }
    const before = c.usdBeforeSessionHit.filter((x) => x > 0);
    const med = median(before);
    if (med !== null) {
      const lo = Math.min(...before);
      const hi = Math.max(...before);
      console.log(`    Before a session-limit message, the 5 hours held ${usd(lo)}–${usd(hi)} of list-price work (median ${usd(med)}).`);
      const share = Math.round((c.lastFiveHoursUsd / med) * 100);
      console.log(color(tty, C.gray, `    The last 5 hours: ${usd(c.lastFiveHoursUsd)}, about ${share}% of that median (estimate: the window's real start is not logged).`));
    } else {
      console.log(color(tty, C.gray, `    The last 5 hours: ${usd(c.lastFiveHoursUsd)} of list-price work.`));
    }
  }
  console.log('');
}
