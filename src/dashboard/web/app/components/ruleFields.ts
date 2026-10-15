/**
 * The allocation rule form's fields, and the rule they describe.
 *
 * One copy, used by the Allocate page's form and by the rule drawer, so a rule
 * written in either place is the same rule `segreant alloc rule` writes, field
 * by field. The fields only build a request body; saving it is the caller's job,
 * which is what lets the drawer preview before it commits.
 */

import { h, type Child } from '../core/dom.ts';
import { signal } from '../core/signal.ts';
import { isPrecise } from '../core/fmt.ts';
import { slug } from '../core/slug.ts';
import { localMidnightIso } from '../core/periods.ts';
import type { AllocationRule, CostCentre } from '../core/api.ts';
import { field } from './workflow.ts';

export const METHOD_WORDS: Record<AllocationRule['method'], { plain: string; precise: string }> = {
  direct: { plain: 'all of it to one centre', precise: 'direct' },
  fixed_split: { plain: 'split by fixed shares', precise: 'fixed_split' },
  proportional_to_direct: { plain: 'shared, split like the direct spend', precise: 'proportional_to_direct' },
};

/** The match fields beyond project, in the engine's own vocabulary (MATCH_FIELDS). */
export const EXTRA_MATCH: Array<{ key: 'model' | 'provider' | 'source' | 'user'; label: string; placeholder: string }> = [
  { key: 'model', label: 'Model', placeholder: 'for example gpt-5' },
  { key: 'provider', label: 'Provider', placeholder: 'for example openai' },
  { key: 'source', label: 'Tool', placeholder: 'for example claude-code' },
  { key: 'user', label: 'User', placeholder: 'as recorded on the request' },
];

/** A rule in a sentence: what spend it takes and where that spend goes. */
export function describeRule(r: Pick<AllocationRule, 'match' | 'method' | 'targets'>, nameOf: (id: string) => string): string {
  const match = Object.entries(r.match ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ');
  const what = match ? `Spend where ${match}` : 'All spend';
  if (r.method === 'proportional_to_direct') return `${what}: shared across centres in proportion to their direct spend`;
  if (r.method === 'fixed_split') return `${what}: ${r.targets.map((t) => `${Math.round(t.ratio * 1000) / 10}% to ${nameOf(t.costCentreId)}`).join(', ')}`;
  return `${what} goes to ${r.targets[0] ? nameOf(r.targets[0].costCentreId) : '—'}`;
}

/** What the fields say, ready to send as `op: 'rule'`. */
export interface RuleDraft {
  id: string;
  body: Record<string, unknown>;
  rule: Pick<AllocationRule, 'match' | 'method' | 'targets'>;
  priority: number | null;
  from: string;
  until: string;
  owner: string;
  note: string;
}

/**
 * The fields, as children to place inside a form or a drawer, and `build()`,
 * which returns the rule they describe or the reason they describe none.
 * `prefix` keeps element ids unique when two copies could share a page.
 */
export function ruleFields(centres: CostCentre[], projects: () => string[], models: () => string[], prefix = 'rule'): { children: Child[]; build: () => RuleDraft | string } {
  const method = signal<AllocationRule['method']>('direct');
  const project = signal('');
  const extra = signal<Record<string, string>>({});
  const priority = signal('');
  const from = signal('');
  const until = signal('');
  const owner = signal('');
  const note = signal('');
  const target = signal(centres[0]?.costCentreId ?? '');
  const shares = signal<Record<string, string>>({});
  const shareTotal = (): number => Object.values(shares()).reduce((s, v) => s + (Number(v) || 0), 0);
  const id = (key: string): string => `${prefix}-${key}`;

  const build = (): RuleDraft | string => {
    if (centres.length === 0) return 'Add a cost centre first: a rule needs somewhere to send the spend.';
    const p = project().trim();
    const match: Record<string, string> = p ? { project: p } : {};
    for (const { key } of EXTRA_MATCH) { const v = (extra()[key] ?? '').trim(); if (v) match[key] = v; }
    const pr = priority().trim();
    if (pr !== '' && !/^-?\d+$/.test(pr)) return 'Priority must be a whole number.';
    if (from() && until() && until() <= from()) return 'The stop date must be after the start date.';
    const targets = method() === 'fixed_split'
      ? Object.entries(shares()).filter(([, v]) => Number(v) > 0).map(([costCentreId, v]) => ({ costCentreId, ratio: Math.round(Number(v) * 10_000) / 1_000_000 }))
      : [{ costCentreId: target(), ratio: method() === 'direct' ? 1 : 0 }];
    if (method() === 'fixed_split' && Math.abs(shareTotal() - 100) > 1e-9) return `The shares add up to ${shareTotal()}%. They need to add up to 100%.`;
    // Every condition is part of the id: with only project and centre in it, a
    // rule for one model would have replaced an existing rule for all spend.
    const ruleId = slug([...Object.values(match), method() === 'direct' ? target() : method()].join('-') || 'all');
    return {
      id: ruleId,
      rule: { match, method: method(), targets },
      priority: pr === '' ? null : Number(pr),
      from: from(),
      until: until(),
      owner: owner().trim(),
      note: note().trim(),
      body: {
        op: 'rule', id: ruleId, method: method(), targets, match,
        ...(pr === '' ? {} : { priority: Number(pr) }),
        ...(from() ? { from: localMidnightIso(from()) } : {}),
        ...(until() ? { until: localMidnightIso(until()) } : {}),
        ...(owner().trim() ? { owner: owner().trim() } : {}),
        ...(note().trim() ? { note: note().trim() } : {}),
      },
    };
  };

  const children: Child[] = [
    h('div', { class: 'form-row' },
      field(id('project'), 'Which spend', h('input', {
        id: id('project'), class: 'drawer-input', list: id('projects'), autocomplete: 'off',
        placeholder: 'a project name, or empty for all spend',
        oninput: (e: Event) => project.set((e.target as HTMLInputElement).value),
      })),
      h('datalist', { id: id('projects') }, () => projects().map((p) => h('option', { value: p }))),
      h('datalist', { id: id('models') }, () => models().map((m) => h('option', { value: m }))),
      field(id('method'), 'How', h('select', {
        id: id('method'), class: 'drawer-input',
        onchange: (e: Event) => method.set((e.target as HTMLSelectElement).value as AllocationRule['method']),
      }, ...(Object.keys(METHOD_WORDS) as Array<AllocationRule['method']>).map((m) =>
        h('option', { value: m, text: isPrecise() ? METHOD_WORDS[m].precise : METHOD_WORDS[m].plain })))),
      () => method() === 'direct'
        ? field(id('target'), 'To', h('select', {
            id: id('target'), class: 'drawer-input',
            onchange: (e: Event) => target.set((e.target as HTMLSelectElement).value),
          // `peek`, not a read: the select keeps the centre already chosen when
          // the method changes away and back, without rebuilding on each choice.
          }, ...centres.map((c) => h('option', { value: c.costCentreId, text: c.name, selected: c.costCentreId === target.peek() }))))
        : null),
    () => method() === 'fixed_split'
      ? h('fieldset', { class: 'shares' },
          h('legend', { text: () => `Shares, in percent (now ${shareTotal()}% of 100%)` }),
          ...centres.map((c) => h('label', { class: 'share' },
            h('span', { text: c.name }),
            h('input', {
              class: 'drawer-input', type: 'number', min: '0', max: '100', step: '0.01', inputmode: 'decimal',
              'aria-label': `Share for ${c.name}, percent`,
              oninput: (e: Event) => shares.set({ ...shares(), [c.costCentreId]: (e.target as HTMLInputElement).value }),
            }))))
      : method() === 'proportional_to_direct'
        ? h('p', { class: 'form-hint', text: 'This spend is shared out in the same proportions as the spend each centre gets directly in the period. If nothing was allocated directly, it stays unallocated rather than being split evenly.' })
        : null,
    h('details', { class: 'rule-more' },
      h('summary', { text: 'More conditions and dates' }),
      h('p', { class: 'form-hint', text: 'Every condition must hold for a request to match. Leave a field empty to match anything.' }),
      h('div', { class: 'form-row rule-more-row' },
        ...EXTRA_MATCH.map(({ key, label, placeholder }) => field(id(key), label, h('input', {
          id: id(key), class: 'drawer-input', autocomplete: 'off', spellcheck: 'false', placeholder,
          ...(key === 'model' ? { list: id('models') } : {}),
          oninput: (e: Event) => extra.set({ ...extra(), [key]: (e.target as HTMLInputElement).value }),
        })))),
      h('div', { class: 'form-row rule-more-row' },
        field(id('priority'), 'Priority', h('input', {
          id: id('priority'), class: 'drawer-input', type: 'number', step: '1', inputmode: 'numeric', placeholder: '100',
          'aria-describedby': id('priority-hint'),
          oninput: (e: Event) => priority.set((e.target as HTMLInputElement).value),
        })),
        field(id('from'), 'Applies from', h('input', {
          id: id('from'), class: 'drawer-input', type: 'date',
          oninput: (e: Event) => from.set((e.target as HTMLInputElement).value),
        })),
        field(id('until'), 'Stops on', h('input', {
          id: id('until'), class: 'drawer-input', type: 'date',
          oninput: (e: Event) => until.set((e.target as HTMLInputElement).value),
        }))),
      h('div', { class: 'form-row rule-more-row' },
        field(id('owner'), 'Owner (optional)', h('input', {
          id: id('owner'), class: 'drawer-input', maxlength: '120', autocomplete: 'off', placeholder: 'who answers for this rule',
          oninput: (e: Event) => owner.set((e.target as HTMLInputElement).value),
        })),
        field(id('note'), 'Note (optional)', h('input', {
          id: id('note'), class: 'drawer-input', maxlength: '500', autocomplete: 'off', placeholder: 'why the spend goes here',
          oninput: (e: Event) => note.set((e.target as HTMLInputElement).value),
        }))),
      h('p', { id: id('priority-hint'), class: 'form-hint', text: 'Rules are checked lowest number first, and the first rule that matches a request takes it. Dates are matched against when the spend happened; empty means from the start of your history and with no end.' })),
  ];

  return { children, build };
}
