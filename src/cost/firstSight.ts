/**
 * The checkpoint, not the clock: the first time Segreant prices a request by a
 * guess (a family match or the generic fallback), it asks the public price list
 * whether the model is known yet. A 30-day refresh left a new model at a guessed
 * price for up to a month; claude-haiku-5-5 was in the public list while
 * Segreant priced it at $3/$15 instead of $0.10/$0.50.
 *
 * The lookup never sits in a request's path: the request is recorded at its
 * provisional price at once, and the lookup runs afterwards. When the list does
 * know the model, recorded rows are NOT rewritten here; the user is told, and
 * `segreant reprice` previews the correction (preview-then-commit).
 *
 * One lookup at a time, and none when the card was checked within the last hour
 * (the check is a conditional GET; the list does not change faster than that).
 */
import { pricingStatus, rateFor, type Provider, type RateMatchKind, type RefreshResult } from './pricing.ts';

export const FIRST_SIGHT_MIN_INTERVAL_MS = 60 * 60 * 1000;

const GUESSED: ReadonlySet<RateMatchKind> = new Set(['family_provider', 'family_cross_provider', 'fallback']);
/** What the refreshed card itself answers; a price the user declared meanwhile is not the list's answer (PR #146 review). */
const CARD_EXACT: ReadonlySet<RateMatchKind> = new Set(['exact_provider', 'exact_cross_provider']);

/** Whether the card's last check of the price list is older than the interval (or never happened). */
export function priceCheckDue(status: { lastCheckedAt: string | null; fetchedAt: string | null }, now: number = Date.now()): boolean {
  const when = status.lastCheckedAt ?? status.fetchedAt;
  const ms = when === null ? NaN : Date.parse(when);
  return !Number.isFinite(ms) || now - ms >= FIRST_SIGHT_MIN_INTERVAL_MS;
}

export interface FirstSightOptions {
  /** Read at each sighting, so turning the setting off takes effect without a restart. */
  enabled: () => boolean;
  refresh: () => Promise<RefreshResult>;
  /** Told the models the refreshed card now prices exactly. */
  onLearned?: (models: Array<{ provider: Provider; model: string }>) => void;
  /** Told a refresh failed, with its reason; the provisional prices stand. */
  onFailed?: (error: string) => void;
  now?: () => number;
  /** When the card was last checked, from its provenance; null when it never was. */
  lastCheckedMs?: () => number | null;
  minIntervalMs?: number;
}

export interface FirstSightWatcher {
  /** Call after pricing a request. Never throws, never waits. */
  note(provider: Provider, model: string, rateMatchKind: string): void;
  /** Resolves when no lookup is running (for tests and shutdown). */
  idle(): Promise<void>;
}

function defaultLastChecked(): number | null {
  const st = pricingStatus();
  const when = st.lastCheckedAt ?? st.fetchedAt;
  const ms = when === null ? NaN : Date.parse(when);
  return Number.isFinite(ms) ? ms : null;
}

export function createFirstSightWatcher(options: FirstSightOptions): FirstSightWatcher {
  const now = options.now ?? Date.now;
  const lastChecked = options.lastCheckedMs ?? defaultLastChecked;
  const minInterval = options.minIntervalMs ?? FIRST_SIGHT_MIN_INTERVAL_MS;
  // Models priced by a guess that no lookup has answered yet, by tuple key.
  const pending = new Map<string, { provider: Provider; model: string }>();
  let running: Promise<void> | null = null;
  let lastAttemptMs: number | null = null;

  const due = (): boolean => {
    const t = now();
    if (lastAttemptMs !== null && t - lastAttemptMs < minInterval) return false;
    const checked = lastChecked();
    return checked === null || t - checked >= minInterval;
  };

  const run = (): void => {
    if (running || pending.size === 0 || !due()) return;
    lastAttemptMs = now();
    running = (async () => {
      try {
        const result = await options.refresh();
        if (!result.ok) {
          options.onFailed?.(result.error ?? 'the price list could not be read');
          return;
        }
        // Every pending model is checked against the refreshed card, including
        // one first seen while this lookup was running: a snapshot taken at the
        // start left it pending for good once the card priced it exactly, since
        // exact requests never call note() again (PR #146 review). Known or not,
        // each has had its answer; one the list does not know is not asked about
        // again until the next interval.
        const answered = [...pending.values()];
        pending.clear();
        const learned = answered.filter(({ provider, model }) => CARD_EXACT.has(rateFor(provider, model).pricing.rateMatchKind));
        if (learned.length > 0) options.onLearned?.(learned);
      } catch (error) {
        options.onFailed?.(error instanceof Error ? error.message : String(error));
      } finally {
        running = null;
      }
    })();
  };

  return {
    note(provider, model, rateMatchKind) {
      try {
        if (!GUESSED.has(rateMatchKind as RateMatchKind) || !options.enabled()) return;
        const key = JSON.stringify([provider, model]);
        if (!pending.has(key)) pending.set(key, { provider, model });
        run();
      } catch {
        // A sighting must never break the request that caused it.
      }
    },
    async idle() {
      while (running) await running;
    },
  };
}
