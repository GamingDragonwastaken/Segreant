/**
 * Task-type classification — the "context" axis of the per-context frontier.
 *
 * The frontier answers "what's best for *you*" by comparing RoI within
 * like-for-like work (you can't compare a typo fix to a feature). Coding units
 * are classified from the commit subject; the same enum is reused for non-coding
 * interactions later, so the frontier is modality-agnostic.
 */

export type TaskType = 'feature' | 'fix' | 'refactor' | 'test' | 'docs' | 'perf' | 'chore' | 'other';

const PREFIX: Record<string, TaskType> = {
  feat: 'feature',
  feature: 'feature',
  fix: 'fix',
  bugfix: 'fix',
  hotfix: 'fix',
  refactor: 'refactor',
  perf: 'perf',
  test: 'test',
  tests: 'test',
  docs: 'docs',
  doc: 'docs',
  chore: 'chore',
  build: 'chore',
  ci: 'chore',
  style: 'chore',
};

/** Classify a unit of work from its description (commit subject / task title). */
export function classifyTaskType(text: string): TaskType {
  const s = (text ?? '').toLowerCase().trim();
  const m = s.match(/^([a-z]+)\s*[(:\/!]/); // conventional-commit prefix: "feat:", "fix(x):"
  const p = m?.[1];
  if (p && PREFIX[p]) return PREFIX[p]!;

  if (/\b(fix(es|ed)?|bug|patch|hotfix|regression)\b/.test(s)) return 'fix';
  if (/\b(refactor|cleanup|clean up|rename|reorganize|restructure)\b/.test(s)) return 'refactor';
  if (/\b(test|tests|spec|coverage)\b/.test(s)) return 'test';
  if (/\b(doc|docs|documentation|readme|comment)\b/.test(s)) return 'docs';
  if (/\b(perf|performance|optimi[sz]e|speed up|faster)\b/.test(s)) return 'perf';
  if (/\b(add|implement|introduce|feature|support|new)\b/.test(s)) return 'feature';
  return 'other';
}
