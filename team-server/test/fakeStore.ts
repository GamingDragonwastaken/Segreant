/**
 * In-memory RollupStore test double — lets server.test.ts exercise the HTTP
 * layer's auth/verification/routing without a live Postgres. See src/store.ts's
 * header comment for why the interface exists.
 */

import type { RollupStore, RegisteredDeveloper, StoredRollup, PeriodFilter, ProjectTotals, DeveloperTotals } from '../src/store.ts';
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
  private nextId = 1;

  async registerDeveloper(keyId: string, publicKey: string, label: string | null): Promise<void> {
    this.developers.set(keyId, { keyId, publicKey, label, registeredAt: new Date().toISOString() });
  }

  async findDeveloper(keyId: string): Promise<RegisteredDeveloper | null> {
    return this.developers.get(keyId) ?? null;
  }

  async insertRollup(signed: SignedRollup): Promise<StoredRollup> {
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
    return stored;
  }

  async listRollups(opts: { keyId?: string; limit?: number } = {}): Promise<StoredRollup[]> {
    const rows = opts.keyId ? this.rollups.filter((r) => r.keyId === opts.keyId) : this.rollups;
    return rows.slice(0, opts.limit ?? 50);
  }

  /** Mirrors PgRollupStore.aggregateProjects's weighting exactly — see store.ts's header comment on why realizationRate/avgRoiIndex can't be naive averages. */
  async aggregateProjects(filter: PeriodFilter = {}): Promise<ProjectTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    interface Acc {
      developers: Set<string>;
      rollups: Set<string>;
      totalUnits: number;
      totalCostUsd: number;
      totalRealizedValueUsd: number;
      totalNetRealizedValueUsd: number;
      realizationNumerator: number;
      roiNumerator: number;
      roiDenominator: number;
    }
    const byProject = new Map<string, Acc>();
    for (const r of inWindow) {
      for (const p of r.body.projects) {
        let acc = byProject.get(p.project);
        if (!acc) {
          acc = {
            developers: new Set(),
            rollups: new Set(),
            totalUnits: 0,
            totalCostUsd: 0,
            totalRealizedValueUsd: 0,
            totalNetRealizedValueUsd: 0,
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
        acc.totalRealizedValueUsd += p.realizedValueUsd;
        acc.totalNetRealizedValueUsd += p.netRealizedValueUsd;
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
        totalRealizedValueUsd: acc.totalRealizedValueUsd,
        totalNetRealizedValueUsd: acc.totalNetRealizedValueUsd,
        realizationRate: acc.totalUnits > 0 ? acc.realizationNumerator / acc.totalUnits : null,
        realizedValueRate: acc.totalCostUsd > 0 ? acc.totalRealizedValueUsd / acc.totalCostUsd : null,
        avgRoiIndex: acc.roiDenominator > 0 ? acc.roiNumerator / acc.roiDenominator : null,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  async aggregateDevelopers(filter: PeriodFilter = {}): Promise<DeveloperTotals[]> {
    const inWindow = this.rollups.filter((r) => overlapsWindow(r.periodFrom, r.periodTo, filter));
    interface Acc {
      rollups: Set<string>;
      totalCostUsd: number;
      totalRealizedValueUsd: number;
      lastPushedAt: string;
    }
    const byDev = new Map<string, Acc>();
    for (const r of inWindow) {
      let acc = byDev.get(r.keyId);
      if (!acc) {
        acc = { rollups: new Set(), totalCostUsd: 0, totalRealizedValueUsd: 0, lastPushedAt: r.receivedAt };
        byDev.set(r.keyId, acc);
      }
      acc.rollups.add(r.id);
      for (const p of r.body.projects) {
        acc.totalCostUsd += p.costUsd;
        acc.totalRealizedValueUsd += p.realizedValueUsd;
      }
      if (r.receivedAt > acc.lastPushedAt) acc.lastPushedAt = r.receivedAt;
    }
    return [...byDev.entries()]
      .map(([keyId, acc]) => ({
        keyId,
        label: this.developers.get(keyId)?.label ?? null,
        rollupCount: acc.rollups.size,
        totalCostUsd: acc.totalCostUsd,
        totalRealizedValueUsd: acc.totalRealizedValueUsd,
        realizedValueRate: acc.totalCostUsd > 0 ? acc.totalRealizedValueUsd / acc.totalCostUsd : null,
        lastPushedAt: acc.lastPushedAt,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  async close(): Promise<void> {}
}
