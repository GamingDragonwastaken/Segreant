/**
 * Action specs — the bridge between a capability and what actually happens.
 *
 * A capability in the registry says what exists and what it costs you to run.
 * This module says how to preview it and how to commit it. Capabilities without
 * an entry here fall back to an informational drawer that shows the consequence
 * and the command, and reports honestly that the GUI cannot run it yet — which
 * is better than a button that silently does nothing.
 */

import { api } from './api.ts';
import { h } from './dom.ts';
import { signal } from './signal.ts';
import { isPrecise, usd, count } from './fmt.ts';
import type { Capability } from './registry.ts';
import type { ActionSpec, PreviewResult } from '../components/drawer.ts';

type Builder = (cap: Capability) => ActionSpec;

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
          : 'This deletes the AI suggestions Fiscus has recorded. Anything that measured how many suggestions you accepted will stop working, and cannot be recalculated.',
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
          : `Reads usage that ${found.length} of your tools already recorded on this computer, and adds anything new to Fiscus.`,
        rows: found.map((i) => ({ label: i.label, value: 'found', note: i.blurb })),
        notes: [
          'This import reads files already on this machine and does not invoke a Fiscus outbound path; provider/tool traffic is outside this read.',
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
          : 'We have looked around and found the following. Applying will bring this usage into Fiscus.',
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

    return {
      capability: cap,
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
          oninput: (event: Event) => entered.set((event.target as HTMLInputElement).value),
        }),
        h('p', { class: 'drawer-note', text: 'Leave this empty to change nothing. Enter 0 to block all spend.' })),

      preview: async (): Promise<PreviewResult> => {
        const [settings, value] = await Promise.all([api.settings(), api.value()]);
        const current = settings.budget?.dailyUsd ?? null;
        const advice = value.budget ?? null;
        return {
          applicable: true,
          summary: isPrecise()
            ? 'Writes the daily cap to the local config file. Enforcement happens at the proxy, so only spend routed through it can be blocked.'
            : 'Saves a new daily limit on this machine. Fiscus can only actually block spend that goes through it.',
          rows: [
            { label: 'Current cap', value: current === null ? 'unlimited' : usd(current) },
            {
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
        const raw = entered().trim();
        if (raw === '') return { ok: false, message: 'No value entered, so nothing was changed.' };
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
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

  export: (cap) => ({
    capability: cap,
    preview: async () => ({
      applicable: false,
      blockedReason: 'Nothing to apply — the download starts from the link below.',
      summary: isPrecise()
        ? 'Streams the request ledger as CSV from this local server. One row per request, with the recorded attribution basis and pricing basis on each.'
        : 'Downloads every request we recorded as a spreadsheet file, including where each cost figure came from.',
      notes: [
        'The file is generated locally; sharing it is an explicit operator export action. Fiscus egress rules do not make this machine-wide.',
        'Each row carries its own attribution and pricing basis, so the export can be checked the same way the screens can.',
      ],
    }),
    download: '/api/export.csv',
  }),

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
            : 'receipt history INVALID; outbound requests refuse before dial until it is repaired. Restore the history; if the lock is stale, confirm no Fiscus writer is active, then remove only that lock and rerun verify: ' + (settings.egress.receipts.errors[0] ?? 'history could not be verified'),
        },
        { label: 'Egress scope', value: 'Fiscus process only', note: settings.egress.scope },
      ];
      return {
        applicable: false,
        blockedReason: 'Use fiscus egress plan to review a cloud permission and fiscus egress apply --apply to persist it. The GUI exposes status and receipt-chain health only.',
        summary: isPrecise() ? 'Current local configuration.' : 'How Fiscus is set up on this machine right now.',
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
