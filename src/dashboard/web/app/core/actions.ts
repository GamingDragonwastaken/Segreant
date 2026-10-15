/**
 * Action specs — the bridge between a capability and what actually happens.
 *
 * A capability in the registry says what exists and what it costs you to run.
 * This module says how to preview it and how to commit it. Capabilities without
 * an entry here fall back to an informational drawer that shows the consequence
 * and the command, and reports honestly that the GUI cannot run it yet — which
 * is better than a button that silently does nothing.
 */

import { api, type AllocationPayload, type BillingPayload } from './api.ts';
import { h } from './dom.ts';
import { signal } from './signal.ts';
import { isPrecise, usd, usdFromMicros, share, count } from './fmt.ts';
import { localMidnightIso, dayAfterIso, monthRange, REASON_WORDS } from './periods.ts';
import { slug } from './slug.ts';
import type { Capability } from './registry.ts';
import type { ActionSpec, PreviewResult } from '../components/drawer.ts';

type Builder = (cap: Capability) => ActionSpec;

/**
 * Sample data runs against a read-only configuration: the server refuses every
 * settings write. The preview says so before Apply is offered, instead of
 * enabling a button whose only outcome is a refusal (H005).
 */
const DEMO_SETTINGS_BLOCKED = 'This dashboard is showing sample data, so settings can\'t be changed here. Start Segreant without --demo to change your own.';

/** Sample data refuses every ledger write; the preview says so before Apply. */
const DEMO_LEDGER_BLOCKED = 'This dashboard is showing sample data, so nothing can be saved here. Start Segreant without --demo to change your own.';

/** A value as one shell word, so a pasted command keeps names with spaces intact. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9._:/@-]+$/.test(text) ? text : JSON.stringify(text);
}

/** Read a typed dollar amount: null for empty, NaN for anything unusable. */
function enteredUsd(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

const BUILDERS: Record<string, Builder> = {
  'clear-proposals': (cap) => ({
    capability: cap,
    preview: async (): Promise<PreviewResult> => {
      const settings = await api.settings();
      const retention = settings['proposalRetentionDays'];
      return {
        applicable: true,
        summary: isPrecise()
          ? 'Deletes every captured proposal row. Acceptance and first-pass-accept rates derived from them become uncomputable.'
          : 'This deletes the AI suggestions Segreant has recorded. Anything that measured how many suggestions you accepted will stop working, and cannot be recalculated.',
        rows: [
          { label: 'Kept for', value: typeof retention === 'number' ? `${retention} days` : 'unset', note: 'current retention setting' },
          { label: 'Reversible', value: 'no', note: 'there is no undo and no automatic backup' },
        ],
        notes: [
          'Cost and request records are untouched — this only removes captured proposals.',
          'Metrics already written into a value snapshot keep their recorded numbers; they simply cannot be recomputed.',
        ],
      };
    },
    commit: async () => {
      const result = await api.write.clearProposals();
      return {
        ok: result.ok,
        message: result.ok
          ? `Done. ${result.removed} proposal record${result.removed === 1 ? '' : 's'} deleted.`
          : 'The server refused the request.',
      };
    },
  }),

  /**
   * Import every tool log this machine actually has. The preview names the tools
   * that were LOCATED, not the tools that are supported -- an operator deciding
   * whether to run this needs to know what it will find, and a list of
   * integrations that exist somewhere else answers a different question.
   */
  import: (cap) => ({
    capability: cap,
    preview: async (): Promise<PreviewResult> => {
      const { importers } = await api.importers();
      const found = importers.filter((i) => i.available);
      return {
        applicable: found.length > 0,
        blockedReason: found.length === 0 ? 'No supported tool logs were located on this machine.' : undefined,
        summary: isPrecise()
          ? `Reads ${found.length} located tool log(s) and inserts previously unseen usage records into the local ledger. Existing records are not duplicated.`
          : `Reads usage that ${found.length} of your tools already recorded on this computer, and adds anything new to Segreant.`,
        rows: found.map((i) => ({ label: i.label, value: 'found', note: i.blurb })),
        notes: [
          'This import reads files already on this machine and does not invoke a Segreant outbound path; provider/tool traffic is outside this read.',
          'Imported subscription usage is observed after the fact, so by default it does not count toward budget enforcement.',
        ],
      };
    },
    commit: async () => {
      const result = await api.write.runImport('all');
      return {
        ok: result.ok,
        message: result.totalNew > 0
          ? `Done. ${count(result.totalNew)} new record${result.totalNew === 1 ? '' : 's'} imported.`
          : 'Done. Nothing new — everything these tools recorded was already in the ledger.',
      };
    },
  }),

  /**
   * The full onboarding step: detect, import everything found, then correlate
   * projects into per-project outcomes. The preview runs the real dry run, so
   * what the operator reads is what the machine actually found.
   */
  scan: (cap) => ({
    capability: cap,
    preview: async (): Promise<PreviewResult> => {
      const sc = await api.scan();
      const tools = (sc.tools ?? []).filter((t) => t.present !== false);
      const notes = [
        'The walk stays on this machine and reads file locations, never file contents.',
        'Applying this imports every detected tool log, then correlates discovered projects into per-project outcomes.',
      ];
      // A bounded walk that stopped early reports a floor. Saying so BEFORE the
      // commit is the difference between "we found 3" and "there are 3".
      if (sc.hitBudget) {
        notes.unshift('The walk stopped at its visit budget, so these counts are a lower bound rather than a total.');
      }
      if (sc.unreadableDirs > 0) {
        notes.push(`${count(sc.unreadableDirs)} directory or directories could not be read, so anything inside them was not counted.`);
      }
      return {
        applicable: true,
        summary: isPrecise()
          ? 'Detection is read-only and has already run to produce this preview. Applying performs the import and correlation passes.'
          : 'We have looked around and found the following. Applying will bring this usage into Segreant.',
        rows: [
          { label: 'AI tools detected', value: count(tools.length) },
          { label: 'Git repositories', value: count(sc.repoCount) },
          { label: 'With attributed spend', value: count(sc.reposWithSpend) },
          { label: 'Directories visited', value: count(sc.dirsVisited) },
        ],
        notes,
      };
    },
    commit: async () => {
      const result = await api.write.runScan();
      return {
        ok: result.ok,
        message: `Done. ${count(result.totalNew)} new record${result.totalNew === 1 ? '' : 's'} imported, ${count(result.correlated)} project(s) correlated.`,
      };
    },
  }),

  /**
   * Set the daily cap. The only field-bearing action in the GUI, and the one
   * place a number typed by an operator becomes enforcement configuration. The
   * running proxy reads this config from the live settings object, so the
   * preview states that the saved value is enforced immediately.
   */
  budget: (cap) => {
    const entered = signal<string>('');
    // The recommendation comes from the value read, which can take tens of
    // seconds on a cold ledger (27.8 s measured on a fresh home). It is fetched
    // once per drawer, and the preview waits for it only briefly: the preview
    // re-runs on every edit, and checking an amount must not queue behind it.
    type Advice = Awaited<ReturnType<typeof api.value>>['budget'];
    let adviceRead: Promise<Advice | null> | null = null;
    let advice: Advice | null | undefined;
    const adviceSoon = (): Promise<Advice | null | undefined> => {
      adviceRead ??= api.value().then((v) => (advice = v.budget ?? null), () => (advice = null));
      if (advice !== undefined) return Promise.resolve(advice);
      return Promise.race([adviceRead, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1200))]);
    };

    return {
      capability: cap,
      command: () => {
        const amount = enteredUsd(entered());
        return amount === null || Number.isNaN(amount) ? null : `segreant budget --daily ${amount}`;
      },
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'budget-cap-input' },
          isPrecise() ? 'New daily cap (USD)' : 'New daily limit, in dollars'),
        h('input', {
          id: 'budget-cap-input',
          class: 'drawer-input',
          type: 'number',
          min: '0',
          step: '0.01',
          inputmode: 'decimal',
          autocomplete: 'off',
          placeholder: 'for example 5.00',
          // Empty and `0` mean opposite things in this field — one changes
          // nothing, the other blocks all spend — and the sentence saying so
          // was a loose sibling paragraph. An operator who tabbed to the input
          // heard the label alone ("New daily limit, in dollars") and never the
          // half that carries the consequence. This is the only free-text field
          // in the GUI and the only one whose empty value is not a no-op by
          // accident, so the instruction has to reach the control it governs.
          'aria-describedby': 'budget-cap-note',
          oninput: (event: Event) => entered.set((event.target as HTMLInputElement).value),
        }),
        h('p', { id: 'budget-cap-note', class: 'drawer-note', text: 'Leave this empty to change nothing. Enter 0 to block all spend.' })),

      preview: async (): Promise<PreviewResult> => {
        const [settings, advice] = await Promise.all([api.settings(), adviceSoon()]);
        const current = settings.budget?.dailyUsd ?? null;
        // Validation is part of the preview, so a wrong amount is named before
        // Apply and a corrected one re-enables it (H004).
        const amount = enteredUsd(entered());
        const blockedReason = settings.demo
          ? DEMO_SETTINGS_BLOCKED
          : amount === null
            ? 'Enter an amount to see the change. An empty field changes nothing.'
            : Number.isNaN(amount)
              ? 'That is not a usable amount. Enter a number of dollars, or 0 to block everything.'
              : amount === current
                ? 'The cap is already that amount, so nothing would change.'
                : undefined;
        return {
          applicable: blockedReason === undefined,
          blockedReason,
          summary: isPrecise()
            ? 'Writes the daily cap to the local config file. Enforcement happens at the proxy, so only spend routed through it can be blocked.'
            : 'Saves a new daily limit on this machine. Segreant can only actually block spend that goes through it.',
          rows: [
            { label: 'Current cap', value: current === null ? 'unlimited' : usd(current) },
            ...(amount !== null && !Number.isNaN(amount)
              ? [{ label: 'New cap', value: usd(amount), note: amount === 0 ? 'blocks every proxied request' : undefined }]
              : []),
            advice === undefined
              ? { label: 'Recommended', value: 'still being worked out', note: 'it comes from the value read; edit the amount or reopen to see it' }
              : {
                  label: 'Recommended',
                  value: advice?.recommendedDailyUsd != null ? usd(advice.recommendedDailyUsd) : 'not established',
                  note: advice?.canApply
                    ? `from ${count(advice.basisDays)} days of observed spend`
                    : 'not enough observed history to recommend acting on',
                },
            {
              label: 'Counts toward the cap',
              value: settings.budget?.capIncludesImported ? 'all observed spend' : 'live proxy spend only',
              note: settings.budget?.capIncludesImported
                ? 'includes imported usage, which cannot actually be blocked'
                : 'imported subscription usage is excluded from enforcement',
            },
            {
              label: 'Takes effect',
              value: 'immediately',
              note: 'the running proxy uses the saved cap for future requests',
            },
          ],
          notes: [
            'A cap does not reduce spend already recorded. It stops future requests once the day total passes it.',
          ],
        };
      },

      commit: async () => {
        // The preview already refused these; this guards a commit that races
        // a field edit.
        const parsed = enteredUsd(entered());
        if (parsed === null) return { ok: false, message: 'No value entered, so nothing was changed.' };
        if (Number.isNaN(parsed)) {
          return { ok: false, message: 'That is not a usable amount. Enter a number of dollars, or 0 to block everything.' };
        }
        // `dailyUsd`, not `dailyCapUsd`. applySettingsPatch only copies keys it
        // recognises, so a wrong name here is not an error -- the request
        // succeeds, the response looks healthy, and nothing changes.
        const next = await api.write.settings({ budget: { dailyUsd: parsed } });
        const saved = next.budget?.dailyUsd ?? null;
        return {
          ok: true,
          message: `Saved. The daily cap is now ${saved === null ? 'unlimited' : usd(saved)}. The running proxy will enforce it for future requests immediately.`,
        };
      },
    };
  },

  /**
   * Add, rename or archive a cost centre: everything `segreant alloc centre`
   * does. The Allocate page adds and archives; only here can an existing
   * centre's name or owner change, because the page derives the id from the
   * name and so can never reach a centre under a new name.
   */
  'alloc-centres': (cap) => {
    const target = signal('');
    // Separate from `target`: the regions below re-render only when whether a
    // centre is chosen changes, never on the choice itself, so a keyboard user
    // arrowing through the select keeps focus on it.
    const editing = signal(false);
    const archive = signal(false);
    const name = signal('');
    const owner = signal('');
    let read: Promise<AllocationPayload> | null = null;
    const allocation = (): Promise<AllocationPayload> => (read ??= api.allocation());
    let open: AllocationPayload['costCentres'] = [];
    const id = (): string => target() || slug(name());
    const fill = (inputId: string, value: string): void => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      if (input) input.value = value;
    };

    return {
      capability: cap,
      command: () => {
        if (!id()) return null;
        if (archive()) return `segreant alloc centre ${id()} --archive`;
        if (!name().trim()) return null;
        return `segreant alloc centre ${id()} --name ${shellWord(name().trim())}${owner().trim() ? ` --owner ${shellWord(owner().trim())}` : ''}`;
      },
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'centre-target' }, 'Cost centre'),
        h('select', {
          id: 'centre-target',
          class: 'drawer-input',
          onchange: (event: Event) => {
            const chosen = (event.target as HTMLSelectElement).value;
            const centre = open.find((c) => c.costCentreId === chosen);
            target.set(chosen);
            if (editing() !== (chosen !== '')) editing.set(chosen !== '');
            archive.set(false);
            name.set(centre?.name ?? '');
            owner.set(centre?.owner ?? '');
            fill('centre-drawer-name', name());
            fill('centre-drawer-owner', owner());
            fill('centre-change', 'save');
          },
        },
          // Built once; the centres are appended when they arrive. Rebuilding the
          // select on arrival took focus, and the choice, from a reader who had
          // already reached it.
          (() => {
            const placeholder = h('option', { value: '', text: 'A new cost centre' });
            void allocation().then((d) => {
              open = d.costCentres.filter((c) => c.archivedAtMs == null);
              placeholder.after(...open.map((c) => h('option', { value: c.costCentreId, text: `${c.name} (${c.costCentreId})` })));
            }, () => undefined);
            return placeholder;
          })()),
        () => editing()
          ? h('div', null,
              h('label', { class: 'drawer-h3', for: 'centre-change' }, 'Change'),
              h('select', { id: 'centre-change', class: 'drawer-input', onchange: (event: Event) => archive.set((event.target as HTMLSelectElement).value === 'archive') },
                h('option', { value: 'save', text: 'Its name or owner' }),
                h('option', { value: 'archive', text: 'Archive it' })))
          : null,
        h('label', { class: 'drawer-h3', for: 'centre-drawer-name' }, 'Name'),
        h('input', {
          id: 'centre-drawer-name', class: 'drawer-input', maxlength: '120', autocomplete: 'off', placeholder: 'for example Engineering',
          oninput: (event: Event) => name.set((event.target as HTMLInputElement).value),
        }),
        h('label', { class: 'drawer-h3', for: 'centre-drawer-owner' }, 'Owner (optional)'),
        h('input', {
          id: 'centre-drawer-owner', class: 'drawer-input', maxlength: '120', autocomplete: 'off', placeholder: 'who answers for it',
          'aria-describedby': 'centre-drawer-note',
          oninput: (event: Event) => owner.set((event.target as HTMLInputElement).value),
        }),
        h('p', { id: 'centre-drawer-note', class: 'drawer-note', text: 'Saving replaces the owner, so an empty owner field clears it, as the command does.' })),

      preview: async (): Promise<PreviewResult> => {
        const d = await allocation();
        const key = id();
        const existing = d.costCentres.find((c) => c.costCentreId === key) ?? null;
        const now = Date.now();
        const namedBy = d.rules.filter((r) =>
          r.revokedAtMs == null
          && (r.effectiveToMs == null || r.effectiveToMs > now)
          && !d.rules.some((o) => o.ruleId === r.ruleId && o.version > r.version)
          && r.targets.some((t) => t.costCentreId === key)).length;

        if (archive()) {
          return {
            applicable: !d.demo && existing?.archivedAtMs == null,
            blockedReason: d.demo ? DEMO_LEDGER_BLOCKED : existing?.archivedAtMs != null ? 'This cost centre is already archived.' : undefined,
            summary: isPrecise()
              ? 'Sets archived_at_ms on the centre. Recorded runs keep it; later runs do not allocate to it.'
              : 'Stops this cost centre receiving spend. Splits already recorded keep it, so they still add up.',
            rows: [
              { label: 'Cost centre', value: existing ? existing.name : key, note: key },
              { label: 'Rules that name it', value: count(namedBy), note: namedBy > 0 ? 'revise them on the Allocate page, or their share has nowhere to go' : undefined },
              { label: 'Reversible', value: 'not from here', note: 'an archived centre stays archived; saving it again only changes its name' },
            ],
          };
        }

        const typed = name().trim();
        const blockedReason = d.demo
          ? DEMO_LEDGER_BLOCKED
          : !key
            ? 'Give the cost centre a name with at least one letter or number.'
            : !typed
              ? 'A cost centre needs a name.'
              : existing && existing.name === typed && (existing.owner ?? '') === owner().trim()
                ? 'Nothing would change yet: the name and owner are already these.'
                : undefined;
        const unchanged = existing !== null && existing.name === typed && (existing.owner ?? '') === owner().trim();
        const effect = !existing
          ? 'adds a new cost centre'
          : unchanged
            ? 'none yet; edit the name or owner'
            : existing.archivedAtMs != null
            ? 'renames an archived centre; it stays archived and still receives no spend'
            : 'changes its name or owner';
        return {
          applicable: blockedReason === undefined,
          blockedReason,
          summary: isPrecise()
            ? 'Upserts one cost_centres row by id. Recorded runs keep the figures they were computed with.'
            : 'Saves this cost centre on this machine. Splits already recorded are not changed.',
          rows: [
            { label: 'Saved as', value: key || '—', note: target() ? 'the id stays the same' : 'derived from the name' },
            { label: 'Effect', value: effect },
            ...(existing ? [{ label: 'Now', value: existing.name, note: existing.owner ? `owner ${existing.owner}` : 'no owner' }] : []),
            { label: 'Rules that name it', value: count(namedBy) },
          ],
        };
      },

      commit: async () => {
        const key = id();
        const result = archive()
          ? await api.write.allocation({ op: 'archive', id: key })
          : await api.write.allocation({ op: 'centre', id: key, name: name().trim(), ...(owner().trim() ? { owner: owner().trim() } : {}) });
        read = null;
        return { ok: result.ok, message: result.message ?? 'Saved.' };
      },
    };
  },

  /**
   * Run an allocation: `segreant alloc run --from --to [--apply]`. The preview
   * is the server's own computation for the period, refused if it does not
   * conserve its input; Apply records exactly that run.
   */
  'alloc-run': (cap) => {
    const ranges = [monthRange(-1), monthRange(0)];
    const CUSTOM = String(ranges.length);
    const chosen = signal('0');
    const custom = signal(false);
    const first = signal('');
    const last = signal('');
    let read: Promise<AllocationPayload> | null = null;
    const allocation = (): Promise<AllocationPayload> => (read ??= api.allocation());
    /** The period the fields name, or the reason they name none. */
    const period = (): { from: string; to: string } | string => {
      if (chosen() !== CUSTOM) return ranges[Number(chosen())]!;
      if (!first() || !last()) return 'Choose both the first and the last day of the period.';
      if (last() < first()) return 'The last day must not be before the first day.';
      // Both days are included: the period ends at the local midnight after the last one.
      return { from: localMidnightIso(first()), to: dayAfterIso(last()) };
    };

    return {
      capability: cap,
      command: () => {
        const p = period();
        return typeof p === 'string' ? null : `segreant alloc run --from ${p.from} --to ${p.to} --apply`;
      },
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'run-drawer-period' }, 'Period'),
        h('select', {
          id: 'run-drawer-period', class: 'drawer-input',
          onchange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            chosen.set(value);
            if (custom() !== (value === CUSTOM)) custom.set(value === CUSTOM);
          },
        },
          ...ranges.map((r, i) => h('option', { value: String(i), text: r.label })),
          h('option', { value: CUSTOM, text: 'Choose dates…' })),
        () => custom()
          ? h('div', null,
              h('label', { class: 'drawer-h3', for: 'run-drawer-first' }, 'First day'),
              h('input', { id: 'run-drawer-first', class: 'drawer-input', type: 'date', oninput: (event: Event) => first.set((event.target as HTMLInputElement).value) }),
              h('label', { class: 'drawer-h3', for: 'run-drawer-last' }, 'Last day (included)'),
              h('input', { id: 'run-drawer-last', class: 'drawer-input', type: 'date', oninput: (event: Event) => last.set((event.target as HTMLInputElement).value) }))
          : null),

      preview: async (): Promise<PreviewResult> => {
        const p = period();
        if (typeof p === 'string') return { applicable: false, blockedReason: p, summary: 'Splits the spend in a period across your cost centres, by your rules.' };
        const [d, r] = await Promise.all([allocation(), api.write.allocation({ op: 'run', from: p.from, to: p.to })]);
        const result = r.result;
        if (!result) return { applicable: false, blockedReason: 'The server returned no split for this period.', summary: r.message };
        const nameOf = (id: string): string => d.costCentres.find((c) => c.costCentreId === id)?.name ?? id;
        const shareOf = (m: number): string => (result.totalMicros > 0 ? share(m / result.totalMicros, 1) : '—');
        const blockedReason = d.demo
          ? DEMO_LEDGER_BLOCKED
          : !result.conserves
            ? 'This split does not add up to the spend it divides, so it cannot be recorded. Please report it.'
            : undefined;
        return {
          applicable: blockedReason === undefined,
          blockedReason,
          summary: isPrecise()
            ? 'Previews alloc run for the period. Apply appends an immutable allocation run; recorded runs are never recomputed.'
            : 'This is how the estimated spend in the period would be split. Recording it saves this split; it is never recalculated later.',
          rows: [
            ...result.byCostCentre.map((c) => ({ label: nameOf(c.costCentreId), value: usdFromMicros(c.allocatedMicros), note: `${shareOf(c.allocatedMicros)} · ${count(c.requestCount)} requests` })),
            ...result.unallocated.map((u) => ({ label: `Unallocated: ${REASON_WORDS[u.reason] ?? u.reason.replace(/_/g, ' ')}`, value: usdFromMicros(u.micros), note: `${shareOf(u.micros)} · ${count(u.requestCount)} requests` })),
            { label: 'Total estimated spend', value: usdFromMicros(result.totalMicros), note: result.totalMicros > 0 ? 'list cost (estimate), not the provider bill' : 'no spend in this period' },
          ],
          notes: [
            ...(result.retention?.truncated ? ['Some records in this period were deleted by retention. The split covers what remains, so the unallocated part may be understated.'] : []),
            'Recorded splits are listed on the Allocate page, where each one downloads as CSV.',
          ],
        };
      },

      commit: async () => {
        const p = period();
        if (typeof p === 'string') return { ok: false, message: p };
        const r = await api.write.allocation({ op: 'run', from: p.from, to: p.to, apply: true });
        read = null;
        return {
          ok: r.ok,
          message: isPrecise() && r.allocationRunId
            ? `Recorded allocation run ${r.allocationRunId}.`
            : 'Recorded. The split is saved and listed under Saved splits on the Allocate page.',
        };
      },
    };
  },

  /**
   * Declare or clear the OpenAI organisation and project: `segreant billing
   * scope set` and `clear`. The preview is the server's own dry run, so what
   * the drawer shows is what the declaration would be, not a client guess.
   */
  'billing-scope': (cap) => {
    const clear = signal(false);
    const account = signal('');
    const project = signal('');
    let read: Promise<BillingPayload> | null = null;
    const billing = (): Promise<BillingPayload> => (read ??= api.billing());

    return {
      capability: cap,
      command: () => clear()
        ? 'segreant billing scope clear --apply'
        : account().trim()
          ? `segreant billing scope set --account-ref ${shellWord(account().trim())}${project().trim() ? ` --project-ref ${shellWord(project().trim())}` : ''} --apply`
          : null,
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'scope-change' }, 'Change'),
        h('select', { id: 'scope-change', class: 'drawer-input', onchange: (event: Event) => clear.set((event.target as HTMLSelectElement).value === 'clear') },
          h('option', { value: 'set', text: 'Declare an organisation and project', selected: true }),
          h('option', { value: 'clear', text: 'Clear the declaration' })),
        () => clear()
          ? null
          : h('div', null,
              h('label', { class: 'drawer-h3', for: 'scope-drawer-account' }, 'Organisation id'),
              h('input', {
                id: 'scope-drawer-account', class: 'drawer-input', maxlength: '200', autocomplete: 'off', spellcheck: 'false', placeholder: 'org_…',
                oninput: (event: Event) => account.set((event.target as HTMLInputElement).value),
              }),
              h('label', { class: 'drawer-h3', for: 'scope-drawer-project' }, 'Project id (optional)'),
              h('input', {
                id: 'scope-drawer-project', class: 'drawer-input', maxlength: '200', autocomplete: 'off', spellcheck: 'false', placeholder: 'proj_…',
                'aria-describedby': 'scope-drawer-note',
                oninput: (event: Event) => project.set((event.target as HTMLInputElement).value),
              }),
              h('p', { id: 'scope-drawer-note', class: 'drawer-note', text: 'These are ids, not keys. Segreant never asks for an OpenAI key here.' }))),

      preview: async (): Promise<PreviewResult> => {
        const d = await billing();
        const active = d.activeScope;
        const current = active
          ? { label: 'Declared now', value: active.providerProjectRef ? `${active.billingAccountRef} / ${active.providerProjectRef}` : active.billingAccountRef, note: `to ${active.upstreamDisplay}` }
          : { label: 'Declared now', value: 'nothing' };

        if (clear()) {
          const r = await api.write.billing({ op: 'scope-clear' });
          return {
            applicable: !d.demo && active != null,
            blockedReason: d.demo ? DEMO_LEDGER_BLOCKED : active == null ? 'No project is declared, so there is nothing to clear.' : undefined,
            summary: r.message ?? 'Clearing stops matching future OpenAI requests to this project.',
            rows: [current, { label: 'Already recorded', value: 'unchanged', note: 'requests and recorded comparisons keep their figures' }],
          };
        }

        const ref = account().trim();
        if (!ref) {
          return {
            applicable: false,
            blockedReason: d.demo ? DEMO_LEDGER_BLOCKED : 'Enter the organisation id to see the declaration.',
            summary: 'Names the OpenAI organisation, and optionally the project, that requests through Segreant go to from now on.',
            rows: [current],
          };
        }
        const r = await api.write.billing({ op: 'scope', accountRef: ref, ...(project().trim() ? { projectRef: project().trim() } : {}) });
        const p = r.scopePreview ?? {};
        return {
          applicable: !d.demo,
          blockedReason: d.demo ? DEMO_LEDGER_BLOCKED : undefined,
          summary: isPrecise()
            ? 'Writes an operator_declared_unverified scope. Only future OpenAI proxy rows to the exact configured endpoint are captured.'
            : 'Your declaration, not checked with OpenAI. It applies to OpenAI requests that go through Segreant from now on.',
          rows: [
            current,
            { label: 'Will declare', value: project().trim() ? `${ref} / ${project().trim()}` : ref, note: typeof p['upstreamDisplay'] === 'string' ? `to ${p['upstreamDisplay']}` : undefined },
            { label: 'Past and imported spend', value: 'unchanged', note: 'it cannot be matched to the bill' },
          ],
          notes: ['Declaring replaces any earlier declaration for future traffic.'],
        };
      },

      commit: async () => {
        const result = clear()
          ? await api.write.billing({ op: 'scope-clear', apply: true })
          : await api.write.billing({ op: 'scope', accountRef: account().trim(), ...(project().trim() ? { projectRef: project().trim() } : {}), apply: true });
        read = null;
        const plain = clear()
          ? 'Cleared. Future OpenAI requests through Segreant are no longer matched to a project. Past spend and recorded comparisons are unchanged.'
          : 'Declared for future OpenAI requests through Segreant. Past and imported spend is unchanged, and OpenAI has not checked this declaration.';
        return { ok: result.ok, message: isPrecise() ? result.message ?? plain : plain };
      },
    };
  },

  export: (cap) => ({
    capability: cap,
    preview: async () => ({
      applicable: false,
      blockedReason: 'Nothing to apply — the download starts from the link below.',
      summary: isPrecise()
        ? 'Streams the request ledger as CSV from this local server. One row per request, with the recorded attribution basis and pricing basis on each.'
        : 'Downloads every request we recorded as a spreadsheet file, including where each cost figure came from.',
      notes: [
        'The file is generated locally; sharing it is an explicit operator export action. Segreant egress rules do not make this machine-wide.',
        'Each row carries its own attribution and pricing basis, so the export can be checked the same way the screens can.',
      ],
    }),
    download: '/api/export.csv',
  }),

  features: (cap) => {
    const LABELS: Record<string, string> = {
      selfReportedOutcomes: 'Self-reported chat, image and other results',
      market: 'Public model market',
      marketLiteLLM: 'Market: LiteLLM list prices',
      marketAider: 'Market: Aider coding benchmark',
      marketArena: 'Market: LMArena ratings',
      marketEpoch: 'Market: Epoch AI benchmarks',
    };
    const key = signal('market');
    const turnOn = signal('off');
    return {
      capability: cap,
      fields: () => h('div', null,
        h('label', { class: 'drawer-h3', for: 'feature-key' }, 'Switch'),
        h('select', { id: 'feature-key', class: 'drawer-input', onchange: (event: Event) => key.set((event.target as HTMLSelectElement).value) },
          ...Object.entries(LABELS).map(([id, text]) => h('option', { value: id, text, selected: id === 'market' }))),
        h('label', { class: 'drawer-h3', for: 'feature-state' }, 'Set it to'),
        h('select', { id: 'feature-state', class: 'drawer-input', onchange: (event: Event) => turnOn.set((event.target as HTMLSelectElement).value) },
          h('option', { value: 'off', text: 'Off', selected: true }), h('option', { value: 'on', text: 'On' }))),
      preview: async (): Promise<PreviewResult> => {
        const settings = await api.settings();
        const current = settings.features ?? {};
        const target = turnOn() === 'on';
        const blockedReason = settings.demo
          ? DEMO_SETTINGS_BLOCKED
          : current[key()] === target ? 'That switch is already set that way, so nothing would change.' : undefined;
        return {
          applicable: blockedReason === undefined,
          blockedReason,
          summary: isPrecise()
            ? 'Writes one features.<key> boolean to the local config. A switched-off subsystem reports itself disabled wherever its output would appear.'
            : 'Turns one optional part of Segreant on or off on this machine. Anything switched off says so instead of showing empty results.',
          rows: [
            { label: LABELS[key()] ?? key(), value: `${current[key()] ? 'on' : 'off'} → ${target ? 'on' : 'off'}` },
            ...Object.entries(LABELS).filter(([id]) => id !== key()).map(([id, text]) => ({ label: text, value: current[id] ? 'on' : 'off' })),
          ],
          notes: ['Budget caps are not a feature switch: they are always enforced and fail closed.'],
        };
      },
      commit: async () => {
        const next = await api.write.settings({ features: { [key()]: turnOn() === 'on' } });
        return { ok: true, message: `Saved. ${LABELS[key()] ?? key()} is now ${next.features?.[key()] ? 'on' : 'off'}.` };
      },
    };
  },

  settings: (cap) => ({
    capability: cap,
    preview: async (): Promise<PreviewResult> => {
      const settings = await api.settings();
      const rows: Array<{ label: string; value: string; note?: string }> = [
        { label: 'Ledger', value: String(settings['dbPath'] ?? '—'), note: 'on this machine only' },
        { label: 'Proxy port', value: String(settings['proxyPort'] ?? '—') },
        { label: 'Dashboard port', value: String(settings['dashboardPort'] ?? '—') },
        { label: 'Retention', value: String(settings['retentionDays'] ?? '—') + ' days' },
        { label: 'Metadata only', value: settings['metadataOnly'] ? 'yes' : 'no', note: 'prompt and response bodies are never stored when on' },
        {
          label: 'Egress mode',
          value: settings.egress.mode === 'local_locked' ? 'local locked' : 'controlled cloud',
          note: settings.egress.receipts.ok
            ? settings.egress.rules.length + ' exact rule(s); ' + settings.egress.receipts.receiptCount + ' receipt(s); chain valid'
            : 'receipt history INVALID; outbound requests refuse before dial until it is repaired. Restore the history; if the lock is stale, confirm no Segreant writer is active, then remove only that lock and rerun verify: ' + (settings.egress.receipts.errors[0] ?? 'history could not be verified'),
        },
        { label: 'Egress scope', value: 'Segreant process only', note: settings.egress.scope },
      ];
      return {
        applicable: false,
        blockedReason: 'Use segreant egress plan to review a cloud permission and segreant egress apply --apply to persist it. The GUI exposes status and receipt-chain health only.',
        summary: isPrecise() ? 'Current local configuration.' : 'How Segreant is set up on this machine right now.',
        rows,
      };
    },
  }),
};

/** Build the spec for a capability, falling back to an honest informational drawer. */
export function actionSpec(cap: Capability): ActionSpec {
  const builder = BUILDERS[cap.id];
  if (builder) return builder(cap);

  return {
    capability: cap,
    preview: async (): Promise<PreviewResult> => ({
      applicable: false,
      blockedReason: cap.coverage === 'planned'
        ? 'This does not have a screen yet — run the command below.'
        : 'This part is not wired into the GUI yet — run the command below.',
      summary: cap.consequence === 'read'
        ? `${cap.plain} Reading this from the GUI is not built yet; the command below does it.`
        : `${cap.plain} Running this from the GUI is not built yet; the command below does it.`,
      notes: ['The System section lists exactly which capabilities the GUI covers and which it does not.'],
    }),
  };
}

/** True when the GUI can actually do this, by commit or by download. */
export function hasRunner(cap: Capability): boolean {
  return cap.id in BUILDERS;
}
