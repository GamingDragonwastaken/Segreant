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
import { isPrecise } from './fmt.ts';
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

  export: (cap) => ({
    capability: cap,
    preview: async () => ({
      applicable: false,
      blockedReason: 'Nothing to apply — the download starts from the link below.',
      summary: isPrecise()
        ? 'Streams the request ledger as CSV from this local server. One row per request, with the recorded attribution basis and pricing basis on each.'
        : 'Downloads every request we recorded as a spreadsheet file, including where each cost figure came from.',
      notes: [
        'The file is generated on this machine and never leaves it unless you send it somewhere.',
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
        { label: 'Retention', value: `${String(settings['retentionDays'] ?? '—')} days` },
        { label: 'Metadata only', value: settings['metadataOnly'] ? 'yes' : 'no', note: 'prompt and response bodies are never stored when on' },
      ];
      return {
        applicable: false,
        blockedReason: 'Editing settings from the GUI is not built yet.',
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
