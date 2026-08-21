/**
 * Per-source DEPTH — how much of the value loop a connected source exposes.
 *
 * The product's honesty rule applied to Sources: a feed is metered at the depth
 * its signals actually reach, never asserted. Every routed source exposes spend
 * (the cost ledger). If it also emits captured proposals, first-pass ACCEPTANCE
 * becomes measurable. If its work lands in projects that have realized-value
 * snapshots, the full RoI loop (OUTCOMES) is in view. Untagged traffic ('direct')
 * is spend the user routed but didn't attribute to a tool.
 *
 * This mirrors the vision's depth ladder — a proxy+git source is the richest; a
 * spend-only feed (e.g. a future billing import) sits at the bottom — but reads
 * it off real signals instead of claiming it. Pure + tested; the CLI and the
 * dashboard both render the string it returns, so the wording can't diverge.
 */

export interface SourceDepthFlags {
  tagged: boolean; // carries an x-fiscus-source label (false = 'direct', routed but un-attributed)
  hasProposals: boolean; // emitted captured proposed edits → the acceptance signal is available
  hasOutcomes: boolean; // contributed to projects with realized-value snapshots → RoI is in view
}

export function describeSourceDepth(f: SourceDepthFlags): { depth: string; full: boolean } {
  if (!f.tagged) return { depth: 'untagged · spend only', full: false };
  const parts = ['spend'];
  if (f.hasProposals) parts.push('acceptance');
  if (f.hasOutcomes) parts.push('RoI');
  return { depth: parts.join(' + '), full: f.hasProposals && f.hasOutcomes };
}
