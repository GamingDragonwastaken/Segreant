/**
 * In-memory RollupStore test double — lets server.test.ts exercise the HTTP
 * layer's auth/verification/routing without a live Postgres. See src/store.ts's
 * header comment for why the interface exists.
 */

import type { RollupStore, RegisteredDeveloper, StoredRollup, InsertRollupResult, PeriodFilter, ProjectTotals, DeveloperTotals, ObservationWindow } from '../src/store.ts';
import type { SignedRollup } from '../../src/team/rollup.ts';

/** True if [rollup's period_from, period_to) overlaps the requested [periodFrom, periodTo) window (open bounds = unbounded). */
function overlapsWindow(periodFrom: string, periodTo: string, filter: PeriodFilter): boolean {
  if (filter.periodFrom !== undefined && new Date(periodTo).getTime() <= new Date(filter.periodFrom).getTime()) return false;
  if (filter.periodTo !== undefined && new Date(periodFrom).getTime() >= new Date(filter.periodTo).getTime()) return false;
  return true;
}

export class FakeRollupStore implements RollupStore {
  private readonly developers = new Map<string, RegisteredDeveloper>();
  private readonly rollups: StoredRollup[] = [];
  private readonly rollupsBySignedIdentity = new Map<string, StoredRollup>();
  private nextId = 1;

  async registerDeveloper(keyId: string, publicKey: string, label: string | null): Promise<void> {
    this.developers.set(keyId, { keyId, publicKey, label, registeredAt: new Date().toISOString() });
  }

  async findDeveloper(keyId: string): Promise<RegisteredDeveloper | null> {
    return this.developers.get(keyId) ?? null;
  }

  async insertRollup(signed: SignedRollup): Promise<InsertRollupResult> {
    const signedIdentity = `${signed.keyId}:${signed.bodyHash}`;
    const existing = this.rollupsBySignedIdentity.get(signedIdentity);
    if (existing) return { rollup: existing, replayed: true };
    const stored: StoredRollup = {
      id: String(this.nextId++),
      keyId: signed.keyId,
      generatedAt: signed.body.generatedAt,
      periodFrom: signed.body.period.from,
      periodTo: signed.body.period.to,
      receivedAt: new Date().toISOString(),
      body: signed.body,
    };
    this.rollups.push(stored);
    this.rollupsBySignedIdentity.set(signedIdentity, stored);
    return { rollup: stored, replayed: false };
  }

  async listRollups(opts: { keyId?: string; limit?: number } = {}): Promise<StoredRollup[]> {
    const rows = opts.keyId ? this.rollups.filter((r) => r.keyId === opts.keyId) : this.rollups;
    return rows.slice(0, opts.limit ?? 50);
  }

  /** Mirrors PgRollupStore.observationWindows: the same latest-per-developer population, grouped by declared window. */
  async observationWindows(filter: PeriodFilter = {}): Promise<ObservationWindow[]> {
    const latest = this.latestPerDeveloper(filter);
    const byWindow = new Map<string, { periodFrom: string; periodTo: string; developers: Set<string> }>();
    for (const r of latest) {
      const key = `${r.periodFrom}\u0000${r.periodTo}`;
      let entry = byWindow.get(key);
      if (!entry) {
        entry = { periodFrom: r.periodFrom, periodTo: r.periodTo, developers: new Set() };
        byWindow.set(key, entry);
      }
      entry.developers.add(r.keyId);
    }
    return [...byWindow.values()]
      .map((entry) => ({ periodFrom: entry.periodFrom, periodTo: entry.periodTo, developerCount: entry.developers.size }))
      .sort((a, b) => a.periodFrom.localeCompare(b.periodFrom) || a.periodTo.localeCompare(b.periodTo));
  }

  /** One developer, one rollup: the latest received among those overlapping the filter. */
  private latestPerDeveloper(filter: PeriodFilter): StoredRollup[] {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    const latestPerDev = new Map<string, StoredRollup>();
    for (const r of inWindow) {
      const existing = latestPerDev.get(r.keyId);
      if (!existing || r.receivedAt >= existing.receivedAt) latestPerDev.set(r.keyId, r);
    }
    return [...latestPerDev.values()];
  }

  /** Mirrors PgRollupStore.aggregateProjects's weighting exactly — see store.ts's header comment on why realizationRate/avgRoiIndex can't be naive averages. */
  async aggregateProjects(filter: PeriodFilter = {}): Promise<ProjectTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    // Cumulative-snapshot rollups: a developer who pushed more than once with
    // overlapping windows (e.g. a daily cron) must only count once — summing
    // every overlapping snapshot would multiply their true spend by however
    // many times they happened to push. Keep only each developer's single
    // latest (by receivedAt) rollup among those overlapping the filter.
    const latestPerDev = new Map<string, StoredRollup>();
    for (const r of inWindow) {
      const existing = latestPerDev.get(r.keyId);
      // >= (not >): on an exact receivedAt tie, the later-inserted rollup wins
      // — this.rollups is in insertion order, so a later loop iteration means
      // a later insert. Matches PgRollupStore's DISTINCT ON ... ORDER BY
      // received_at DESC, id DESC secondary tiebreaker.
      if (!existing || r.receivedAt >= existing.receivedAt) latestPerDev.set(r.keyId, r);
    }
    const deduped = [...latestPerDev.values()];
    interface Acc {
      developers: Set<string>;
      rollups: Set<string>;
      totalUnits: number;
      totalCostUsd: number;
      totalSpendOnRealizedUnitsUsd: number;
      totalAcceptanceWeightedSpendUsd: number;
      realizationNumerator: number;
      roiNumerator: number;
      roiDenominator: number;
    }
    const byProject = new Map<string, Acc>();
    for (const r of deduped) {
      for (const p of r.body.projects) {
        let acc = byProject.get(p.project);
        if (!acc) {
          acc = {
            developers: new Set(),
            rollups: new Set(),
            totalUnits: 0,
            totalCostUsd: 0,
            totalSpendOnRealizedUnitsUsd: 0,
            totalAcceptanceWeightedSpendUsd: 0,
            realizationNumerator: 0,
            roiNumerator: 0,
            roiDenominator: 0,
          };
          byProject.set(p.project, acc);
        }
        acc.developers.add(r.keyId);
        acc.rollups.add(r.id);
        acc.totalUnits += p.units;
        acc.totalCostUsd += p.costUsd;
        acc.totalSpendOnRealizedUnitsUsd += p.spendOnRealizedUnitsUsd;
        acc.totalAcceptanceWeightedSpendUsd += p.acceptanceWeightedSpendUsd;
        acc.realizationNumerator += p.realizationRate * p.units;
        if (p.roiIndex !== null) {
          acc.roiNumerator += p.roiIndex * p.costUsd;
          acc.roiDenominator += p.costUsd;
        }
      }
    }
    return [...byProject.entries()]
      .map(([project, acc]) => ({
        project,
        developerCount: acc.developers.size,
        rollupCount: acc.rollups.size,
        totalUnits: acc.totalUnits,
        totalCostUsd: acc.totalCostUsd,
        totalSpendOnRealizedUnitsUsd: acc.totalSpendOnRealizedUnitsUsd,
        totalAcceptanceWeightedSpendUsd: acc.totalAcceptanceWeightedSpendUsd,
        realizationRate: acc.totalUnits > 0 ? acc.realizationNumerator / acc.totalUnits : null,
        realizedSpendShare: acc.totalCostUsd > 0 ? acc.totalSpendOnRealizedUnitsUsd / acc.totalCostUsd : null,
        avgRoiIndex: acc.roiDenominator > 0 ? acc.roiNumerator / acc.roiDenominator : null,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  async aggregateDevelopers(filter: PeriodFilter = {}): Promise<DeveloperTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    const latestPerDev = new Map<string, StoredRollup>();
    for (const r of inWindow) {
      const existing = latestPerDev.get(r.keyId);
      if (!existing || r.receivedAt >= existing.receivedAt) latestPerDev.set(r.keyId, r);
    }
    return [...latestPerDev.values()]
      .map((r) => {
        let totalCostUsd = 0;
        let totalSpendOnRealizedUnitsUsd = 0;
        for (const p of r.body.projects) {
          totalCostUsd += p.costUsd;
          totalSpendOnRealizedUnitsUsd += p.spendOnRealizedUnitsUsd;
        }
        return {
          keyId: r.keyId,
          label: this.developers.get(r.keyId)?.label ?? null,
          rollupCount: 1,
          totalCostUsd,
          totalSpendOnRealizedUnitsUsd,
          realizedSpendShare: totalCostUsd > 0 ? totalSpendOnRealizedUnitsUsd / totalCostUsd : null,
          lastPushedAt: r.receivedAt,
        };
      })
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  async close(): Promise<void> {}
}
