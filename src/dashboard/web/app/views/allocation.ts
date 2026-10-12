/**
 * Allocate — whose budget the money lands on, and what that number is not.
 *
 * Allocated cost is the third claim in the spine, and the one most often
 * mistaken for the first. It is a DERIVED split of local estimates: a rule said
 * this request belongs to that cost centre. It is not a provider bill, it is not
 * what anyone owes, and it is excluded from budget enforcement, RoI and model
 * recommendations, because a showback split is not evidence about value or about
 * money actually charged.
 *
 * This page used to describe allocation and send you to the terminal to do it.
 * It is now the job itself, in the order the engine needs it: cost centres, then
 * rules, then a run. A run is previewed first and recorded only on a second,
 * separate action, the GUI's form of the CLI's `--apply`. The basis and the
 * exclusions stay at the top, in one strip, so the figure is never met without
 * them.
 */

import { h } from '../core/dom.ts';
import { signal, scopedEffect } from '../core/signal.ts';
import { api, type AllocationPayload, type AllocationRunResultPayload, type AllocationRule, type CostCentre } from '../core/api.ts';
import { isPrecise, relative, count, usdFromMicros, date, pct } from '../core/fmt.ts';

/** The payload's `excludedFrom` ids, said in words an operator can act on. */
const EXCLUSION_WORDS: Record<string, string> = {
  request_metered_spend: 'the metered spend figure',
  budget_enforcement: 'budget caps and blocking',
  roi: 'return on investment',
  model_recommendations: 'which model we suggest',
};

const REASON_WORDS: Record<string, string> = {
  no_matching_rule: 'no rule claimed it',
  no_driver_for_proportional_pool: 'a shared pool with nothing directly allocated to split it by',
  target_cost_centre_archived: 'its cost centre was archived',
};

const METHOD_WORDS: Record<AllocationRule['method'], { plain: string; precise: string }> = {
  direct: { plain: 'all of it to one centre', precise: 'direct' },
  fixed_split: { plain: 'split by fixed shares', precise: 'fixed_split' },
  proportional_to_direct: { plain: 'shared, split like the direct spend', precise: 'proportional_to_direct' },
};

/** The engine's id format (src/alloc/rules.ts), derived from a typed name. */
function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 64);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Month boundaries in local time, as ISO strings the server parses. */
function monthRange(offset: number): { from: string; to: string; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = offset === 0 ? now : new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + (offset === 0 ? ' so far' : ''),
  };
}

export function allocationView(): Node {
  const data = signal<AllocationPayload | null>(null);
  const error = signal<string | null>(null);
  const projects = signal<string[]>([]);
  const reloads = signal(0);
  const reload = (): void => reloads.set(reloads() + 1);
  // Outside the data region on purpose: a save reloads the payload, which
  // rebuilds every form, and a message held by the form would vanish with it.
  const notice = signal<{ ok: boolean; text: string } | null>(null);
  const reloadAll = (): void => {
    reload();
    // The spine above this page reads /api/allocation once. Without this it kept
    // saying "no cost centres and no rules yet" under a page that had just saved both.
    window.dispatchEvent(new CustomEvent('segreant:ledger-changed', { detail: { claim: 'allocation' } }));
  };
  const say: Say = (ok, text) => {
    const shown = { ok, text };
    notice.set(shown);
    // A confirmation can go; a refusal stays until the next action replaces it.
    if (ok) setTimeout(() => { if (notice() === shown) notice.set(null); }, 6000);
  };

  scopedEffect(() => {
    reloads();
    void api.allocation()
      .then((payload) => { error.set(null); data.set(payload); })
      .catch((e: unknown) => error.set(errorText(e)));
  });
  // Project names to match on. A typo in a match makes a rule that claims
  // nothing, and the run would only say "no rule claimed it" afterwards.
  void api.overview('all')
    .then((o) => projects.set(o.byProject.map((p) => p.label).filter((l) => l && l !== '(unattributed)')))
    .catch(() => projects.set([]));

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Allocate' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'A derived split of locally estimated cost across cost centres, by recorded rule. Showback only: no settlement, no chargeback.'
        : 'Decide which team or budget each dollar of AI spend is attributed to. This splits our own estimate. It is not a bill, and nobody is charged.' })),

    h('p', {
      class: () => `form-msg page-notice${notice()?.ok === false ? ' drawer-error' : ''}`,
      role: 'status', 'aria-live': 'polite',
      hidden: () => notice() === null,
      text: () => notice()?.text ?? '',
    }),

    () => {
      const err = error();
      const d = data();
      if (!d && err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', role: 'alert', text: err }));
      if (!d) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', role: 'status', 'aria-busy': 'true', text: 'Loading…' }));

      const open = d.costCentres.filter((c) => c.archivedAtMs == null);
      const live = d.rules.filter((r) => r.revokedAtMs == null && r.effectiveToMs == null);
      // People type names; the engine keys on ids. Show what they typed.
      const names = new Map(d.costCentres.map((c) => [c.costCentreId, c.name]));
      const nameOf = (id: string): string => names.get(id) ?? id;

      return h('div', null,
        basisStrip(d),
        d.demo
          ? h('p', { class: 'section-note', role: 'note', text: 'This is sample data, so centres and rules cannot be saved here. You can still preview a run. Start Segreant without --demo to set up your own.' })
          : null,
        step(1, () => (isPrecise() ? 'Cost centres' : 'Who carries the cost'),
          () => (isPrecise() ? 'Accounting positions that receive allocated spend.' : 'The teams, clients or budgets spend can be attributed to.'),
          centreList(d.costCentres, d.demo, reloadAll, say),
          d.demo ? null : centreForm(reloadAll, say)),
        step(2, () => (isPrecise() ? 'Rules' : 'What goes where'),
          () => (isPrecise() ? 'Priority-ordered; lower wins. Edits create a new version; old versions stay for past periods.' : 'Each rule picks some spend and says which centre it belongs to. Changing a rule keeps the old version, so past months still add up the same.'),
          ruleList(d.rules, d.demo, reloadAll, say, nameOf),
          d.demo ? null : open.length > 0
            ? ruleForm(open, projects, reloadAll, say)
            : h('p', { class: 'drawer-muted', text: 'Add a cost centre first. A rule needs somewhere to send spend.' })),
        step(3, () => (isPrecise() ? 'Run' : 'Work out the split'),
          () => (isPrecise() ? 'Preview computes; Record persists an immutable run.' : 'Preview the split for a month. Nothing is saved until you record it.'),
          live.length > 0 || d.demo
            ? runPanel(d.demo, reloadAll, say, nameOf)
            : h('p', { class: 'drawer-muted', text: 'Add a rule first. Without one, every dollar would show as unallocated.' })),
        history(d.runs));
    });
}

function basisStrip(d: AllocationPayload): Node {
  const checked = d.reconciliation?.everRun;
  return h('div', { class: 'card card-basis basis-strip' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title', text: () => (isPrecise() ? 'Basis' : 'What this number is') }),
      h('span', { class: 'pill pill-estimate', text: 'showback only' }),
      h('span', { class: `pill ${checked ? 'pill-ok' : 'pill-unverified'}`, text: checked ? 'ledger checked against a bill' : 'ledger not checked against a bill' })),
    h('p', { text: () => (checked
      ? `A split of our own cost estimate, which was last compared with a provider bill ${relative(d.reconciliation.latestComputedAtMs)}.`
      : 'A split of our own cost estimate. Nobody has compared that estimate with a provider bill yet, so the split is exact arithmetic on an unchecked total.') }),
    h('p', { class: 'basis', text: () => `Never feeds ${(d.excludedFrom ?? []).map((id) => EXCLUSION_WORDS[id] ?? id.replace(/_/g, ' ')).join(', ')}.` }));
}

function step(n: number, title: () => string, lede: () => string, ...body: Array<Node | null>): Node {
  return h('section', { class: 'section step' },
    h('h2', { class: 'step-title' },
      h('span', { class: 'step-n', 'aria-hidden': 'true', text: String(n) }),
      h('span', { text: title })),
    h('p', { class: 'step-lede', text: lede }),
    ...body);
}

/** Report what the server said, in its words, on the page-level notice. */
type Say = (ok: boolean, text: string) => void;

function centreList(centres: CostCentre[], demo: boolean, reload: () => void, say: Say): Node {
  if (centres.length === 0) return h('p', { class: 'drawer-muted', text: 'No cost centres yet.' });
  return h('div', { class: 'facts' },
    ...centres.map((c) => {
      const archived = c.archivedAtMs != null;
      return h('div', { class: `fact${archived ? ' fact-off' : ''}` },
        h('span', { class: 'fact-key' },
          h('span', { text: c.name }),
          c.owner ? h('span', { class: 'fact-sub', text: c.owner }) : null),
        h('span', { class: 'fact-val' },
          h('span', { text: archived ? `archived · ${c.costCentreId}` : c.costCentreId }),
          !archived && !demo
            ? h('button', {
                class: 'link-btn',
                'aria-label': `Archive ${c.name}`,
                onclick: async () => {
                  try { say(true, (await api.write.allocation({ op: 'archive', id: c.costCentreId })).message); reload(); } catch (e) { say(false, errorText(e)); }
                },
                text: 'Archive',
              })
            : null));
    }));
}

function centreForm(reload: () => void, say: Say): Node {
  const name = signal('');
  const owner = signal('');
  const id = (): string => slug(name());
  return h('form', {
    class: 'inline-form',
    onsubmit: async (event: Event) => {
      event.preventDefault();
      if (!id()) return say(false, 'Give the cost centre a name with at least one letter or number.');
      try {
        const r = await api.write.allocation({ op: 'centre', id: id(), name: name().trim(), ...(owner().trim() ? { owner: owner().trim() } : {}) });
        say(true, r.message);
        name.set(''); owner.set('');
        (event.target as HTMLFormElement).reset();
        reload();
      } catch (e) { say(false, errorText(e)); }
    },
  },
    h('div', { class: 'form-row' },
      field('centre-name', 'Name', h('input', { id: 'centre-name', class: 'drawer-input', required: true, maxlength: '120', placeholder: 'for example Engineering', autocomplete: 'off', oninput: (e: Event) => name.set((e.target as HTMLInputElement).value) })),
      field('centre-owner', 'Owner (optional)', h('input', { id: 'centre-owner', class: 'drawer-input', maxlength: '120', placeholder: 'who answers for it', autocomplete: 'off', oninput: (e: Event) => owner.set((e.target as HTMLInputElement).value) })),
      h('button', { class: 'btn-commit', type: 'submit', text: 'Add cost centre' })),
    h('p', { class: 'form-hint', text: () => (id() ? `Saved as "${id()}".` : '') }),
  );
}

function field(id: string, label: string, control: Node): Node {
  return h('div', { class: 'form-field' }, h('label', { for: id, text: label }), control);
}

function describeRule(r: AllocationRule, nameOf: (id: string) => string): string {
  const match = Object.entries(r.match ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ');
  const what = match ? `Spend where ${match}` : 'All spend';
  if (r.method === 'proportional_to_direct') return `${what}: shared across centres in proportion to their direct spend`;
  if (r.method === 'fixed_split') return `${what}: ${r.targets.map((t) => `${Math.round(t.ratio * 1000) / 10}% to ${nameOf(t.costCentreId)}`).join(', ')}`;
  return `${what} goes to ${r.targets[0] ? nameOf(r.targets[0].costCentreId) : '—'}`;
}

function ruleList(rules: AllocationRule[], demo: boolean, reload: () => void, say: Say, nameOf: (id: string) => string): Node {
  if (rules.length === 0) return h('p', { class: 'drawer-muted', text: 'No rules yet.' });
  return h('div', { class: 'facts' },
    // A revoked or superseded version is shown, not hidden: a past run was
    // computed under it, and a reader comparing runs needs to see why the split
    // changed rather than find a rule silently absent.
    ...rules.map((r) => {
      const state = r.revokedAtMs != null ? 'revoked' : r.effectiveToMs != null ? 'superseded' : null;
      return h('div', { class: `fact${state ? ' fact-off' : ''}` },
        h('span', { class: 'fact-key' },
          h('span', { text: describeRule(r, nameOf) })),
        h('span', { class: 'fact-val' },
          h('span', { text: `${r.ruleId} v${r.version}${state ? ` · ${state}` : ` · p${r.priority}`}` }),
          !state && !demo
            ? h('button', {
                class: 'link-btn',
                'aria-label': `Revoke rule ${r.ruleId}`,
                onclick: async () => {
                  try { say(true, (await api.write.allocation({ op: 'revoke', id: r.ruleId })).message); reload(); } catch (e) { say(false, errorText(e)); }
                },
                text: 'Revoke',
              })
            : null));
    }));
}

function ruleForm(centres: CostCentre[], projects: () => string[], reload: () => void, say: Say): Node {
  const method = signal<AllocationRule['method']>('direct');
  const project = signal('');
  const target = signal(centres[0]!.costCentreId);
  const shares = signal<Record<string, string>>({});

  const shareTotal = (): number => Object.values(shares()).reduce((s, v) => s + (Number(v) || 0), 0);

  return h('form', {
    class: 'inline-form',
    onsubmit: async (event: Event) => {
      event.preventDefault();
      const p = project().trim();
      const targets = method() === 'fixed_split'
        ? Object.entries(shares()).filter(([, v]) => Number(v) > 0).map(([costCentreId, v]) => ({ costCentreId, ratio: Math.round(Number(v) * 10_000) / 1_000_000 }))
        : [{ costCentreId: target(), ratio: method() === 'direct' ? 1 : 0 }];
      if (method() === 'fixed_split' && Math.abs(shareTotal() - 100) > 1e-9) return say(false, `The shares add up to ${shareTotal()}%. They need to add up to 100%.`);
      const id = slug(`${p || 'all'}-${method() === 'direct' ? target() : method()}`);
      try {
        const r = await api.write.allocation({ op: 'rule', id, method: method(), targets, match: p ? { project: p } : {} });
        say(true, r.message);
        reload();
      } catch (e) { say(false, errorText(e)); }
    },
  },
    h('div', { class: 'form-row' },
      field('rule-project', 'Which spend', h('input', {
        id: 'rule-project', class: 'drawer-input', list: 'rule-projects', autocomplete: 'off',
        placeholder: 'a project name, or empty for all spend',
        oninput: (e: Event) => project.set((e.target as HTMLInputElement).value),
      })),
      h('datalist', { id: 'rule-projects' }, () => projects().map((p) => h('option', { value: p }))),
      field('rule-method', 'How', h('select', {
        id: 'rule-method', class: 'drawer-input',
        onchange: (e: Event) => method.set((e.target as HTMLSelectElement).value as AllocationRule['method']),
      }, ...(Object.keys(METHOD_WORDS) as Array<AllocationRule['method']>).map((m) =>
        h('option', { value: m, text: isPrecise() ? METHOD_WORDS[m].precise : METHOD_WORDS[m].plain })))),
      () => method() === 'direct'
        ? field('rule-target', 'To', h('select', {
            id: 'rule-target', class: 'drawer-input',
            onchange: (e: Event) => target.set((e.target as HTMLSelectElement).value),
          }, ...centres.map((c) => h('option', { value: c.costCentreId, text: c.name }))))
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
    h('div', { class: 'form-actions' }, h('button', { class: 'btn-commit', type: 'submit', text: 'Save rule' })),
  );
}

function runPanel(demo: boolean, reload: () => void, say: Say, nameOf: (id: string) => string): Node {
  const ranges = [monthRange(-1), monthRange(0)];
  const chosen = signal(0);
  const preview = signal<AllocationRunResultPayload | null>(null);
  const busy = signal(false);

  const run = async (apply: boolean): Promise<void> => {
    const r = ranges[chosen()]!;
    busy.set(true);
    try {
      const res = await api.write.allocation({ op: 'run', from: r.from, to: r.to, apply });
      if (res.result) preview.set(res.result);
      say(true, apply
        ? 'Recorded. The split is saved and listed under Saved splits.'
        : 'Preview only. Nothing is saved until you press Record this run.');
      if (apply) { preview.set(null); reload(); }
    } catch (e) { say(false, errorText(e)); } finally { busy.set(false); }
  };

  return h('div', { class: 'run-panel' },
    h('div', { class: 'form-row run-row' },
      field('run-period', 'Period', h('select', {
        id: 'run-period', class: 'drawer-input',
        onchange: (e: Event) => { chosen.set(Number((e.target as HTMLSelectElement).value)); preview.set(null); },
      }, ...ranges.map((r, i) => h('option', { value: String(i), text: r.label })))),
      h('button', { class: 'btn-ghost', disabled: () => busy(), onclick: () => void run(false), text: () => (busy() ? 'Working…' : 'Preview split') })),
    () => {
      const p = preview();
      if (!p) return null;
      return h('div', { class: 'run-result' },
        runTable(p, nameOf),
        p.retention?.truncated
          ? h('p', { class: 'section-note', role: 'note', text: 'Some records in this period were deleted by retention. The split covers what remains, so the unallocated part may be understated.' })
          : null,
        h('div', { class: 'form-actions' },
          demo
            ? h('p', { class: 'drawer-muted', text: 'Sample data: a run cannot be recorded here.' })
            : h('button', { class: 'btn-commit', disabled: () => busy(), onclick: () => void run(true), text: 'Record this run' })));
    },
  );
}

function runTable(p: AllocationRunResultPayload, nameOf: (id: string) => string): Node {
  const share = (m: number): string => (p.totalMicros > 0 ? pct(m / p.totalMicros) : '—');
  return h('div', { class: 'table-wrap' },
    h('table', null,
      h('caption', { class: 'sr-only', text: 'Allocation preview by cost centre' }),
      h('thead', null, h('tr', null,
        h('th', { text: 'Cost centre' }), h('th', { class: 'num', text: 'Amount' }), h('th', { class: 'num', text: 'Share' }), h('th', { class: 'num', text: 'Requests' }))),
      h('tbody', null,
        ...p.byCostCentre.map((c) => h('tr', null,
          h('td', { text: nameOf(c.costCentreId) }), h('td', { class: 'num', text: usdFromMicros(c.allocatedMicros) }),
          h('td', { class: 'num', text: share(c.allocatedMicros) }), h('td', { class: 'num', text: count(c.requestCount) }))),
        ...p.unallocated.map((u) => h('tr', { class: 'row-unalloc' },
          h('td', null,
            h('span', { text: `Unallocated: ${REASON_WORDS[u.reason] ?? u.reason.replace(/_/g, ' ')}` }),
            u.topProjects.length > 0
              ? h('span', { class: 'fact-sub', text: `mostly ${u.topProjects.slice(0, 3).map((t) => t.project).join(', ')}` })
              : null),
          h('td', { class: 'num', text: usdFromMicros(u.micros) }),
          h('td', { class: 'num', text: share(u.micros) }), h('td', { class: 'num', text: count(u.requestCount) })))),
      h('tfoot', null, h('tr', null,
        h('td', { text: 'Total estimated spend' }), h('td', { class: 'num', text: usdFromMicros(p.totalMicros) }),
        h('td', { class: 'num', text: p.totalMicros > 0 ? '100%' : '—' }), h('td', null)))));
}

function history(runs: AllocationPayload['runs']): Node {
  return h('section', { class: 'section' },
    h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Recorded runs' : 'Saved splits') }),
    runs.length === 0
      ? h('p', { class: 'drawer-muted', text: 'None recorded yet.' })
      : h('div', { class: 'table-wrap' },
          h('table', null,
            h('thead', null, h('tr', null,
              h('th', { text: 'Period' }), h('th', { class: 'num', text: 'Total' }), h('th', { class: 'num', text: 'Allocated' }), h('th', { text: 'Recorded' }))),
            h('tbody', null,
              ...runs.map((r) => h('tr', null,
                h('td', { text: `${date(r.result.periodStartMs)} – ${date(r.result.periodEndMs)}` }),
                h('td', { class: 'num', text: usdFromMicros(r.result.totalMicros) }),
                h('td', { class: 'num', text: r.result.totalMicros > 0 ? pct(r.result.allocatedMicros / r.result.totalMicros) : '—' }),
                h('td', { text: relative(r.computedAtMs) })))))));
}
