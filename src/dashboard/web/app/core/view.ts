/**
 * What you see: density, and which parts of the page are shown.
 *
 * The same screens serve a finance reader who wants the four figures and the
 * explanations, and a developer who lives in two jobs and wants them dense.
 * These are display choices only: hiding a part never changes a figure, and
 * everything hidden stays reachable from Settings and by its address. Kept in
 * this browser only, like the theme.
 */

import { signal } from './signal.ts';

export type Density = 'comfortable' | 'compact';

export interface ViewPrefs {
  density: Density;
  /** The four-figure strip above the money pages. */
  strip: boolean;
  /** The short explanation under each page title. */
  intros: boolean;
  /** Jobs left out of the top bar. The current job always shows. */
  hiddenJobs: string[];
}

const STORAGE_KEY = 'segreant.view';
export const VIEW_DEFAULTS: ViewPrefs = { density: 'comfortable', strip: true, intros: true, hiddenJobs: [] };

/** Anything unreadable or out of range falls back to the default, field by field. */
export function parseViewPrefs(raw: string | null): ViewPrefs {
  if (!raw) return { ...VIEW_DEFAULTS, hiddenJobs: [] };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      density: v.density === 'compact' ? 'compact' : 'comfortable',
      strip: v.strip !== false,
      intros: v.intros !== false,
      hiddenJobs: Array.isArray(v.hiddenJobs) ? v.hiddenJobs.filter((j): j is string => typeof j === 'string') : [],
    };
  } catch {
    return { ...VIEW_DEFAULTS, hiddenJobs: [] };
  }
}

function stored(): ViewPrefs {
  try {
    return parseViewPrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...VIEW_DEFAULTS, hiddenJobs: [] };
  }
}

export const viewPrefs = signal<ViewPrefs>(stored());

function apply(): void {
  const p = viewPrefs();
  // Reached through globalThis so the parsing rules can be unit-tested under Node, which has no document.
  const doc = (globalThis as { document?: { documentElement: { dataset: Record<string, string | undefined> } } }).document;
  if (!doc) return;
  const root = doc.documentElement.dataset;
  root.density = p.density;
  root.intros = p.intros ? 'on' : 'off';
}

export function setView(patch: Partial<ViewPrefs>): void {
  viewPrefs.set({ ...viewPrefs(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(viewPrefs()));
  } catch {
    // Storage can be unavailable; the choice still applies for this visit.
  }
  apply();
}

export function setJobShown(id: string, shown: boolean): void {
  const rest = viewPrefs().hiddenJobs.filter((j) => j !== id);
  setView({ hiddenJobs: shown ? rest : [...rest, id] });
}

export function jobShown(id: string): boolean {
  return !viewPrefs().hiddenJobs.includes(id);
}

/** Run once before the first render, so the page never paints at the wrong density. */
export function initView(): void {
  apply();
}
