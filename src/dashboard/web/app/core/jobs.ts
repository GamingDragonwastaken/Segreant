/**
 * The six jobs, in top-bar order. Shared by the top bar and by Settings, which
 * lets each reader choose which of them the top bar shows.
 */
export const JOBS: ReadonlyArray<{ id: string; label: string; plain: string }> = [
  { id: 'statement', label: 'Statement', plain: 'One month: measured, billed, split and produced, side by side.' },
  { id: 'spend', label: 'Spend', plain: 'What AI cost, and where it went.' },
  { id: 'control', label: 'Protect', plain: 'Limits and alerts that stop spend before it happens.' },
  { id: 'evidence', label: 'Close', plain: 'Check what was measured against the provider bill.' },
  { id: 'allocation', label: 'Allocate', plain: 'Assign cost to the teams and projects that carry it.' },
  { id: 'value', label: 'Value', plain: 'What the spend produced.' },
];
