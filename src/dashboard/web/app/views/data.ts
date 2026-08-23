/**
 * Data — getting real usage in, for someone who will never open a terminal.
 *
 * This is the first screen that matters to a new operator, because every other
 * claim in the product is empty until something has been imported. It is written
 * for the person who has an AI subscription and no idea where its usage is
 * recorded, so it leads with what was actually found on THIS machine rather than
 * with a list of integrations that might exist somewhere.
 *
 * Two honesty notes are built into the surface:
 *
 *   - Detection is a bounded filesystem walk. When it hits its visit budget the
 *     counts are a floor, not a total, and the screen says so — an operator who
 *     reads "3 repositories" as complete will draw a wrong conclusion about
 *     coverage that no later screen can correct.
 *   - Running detection records the result as the new baseline for change
 *     reporting. That is a local write, small but real, so it is not presented
 *     as a pure read.
 */

import { h } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { api, type Importer, type ScanPayload, type Overview } from '../core/api.ts';
import { count, usd, isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';

export function dataView(): Node {
  const importers = signal<Importer[] | null>(null);
  const overview = signal<Overview | null>(null);
  const scan = signal<ScanPayload | null>(null);
  const scanning = signal(false);
  const scanError = signal<string | null>(null);
  const error = signal<string | null>(null);

  effect(() => {
    void Promise.allSettled([api.importers(), api.overview('all')])
      .then(([i, o]) => {
        if (i.status === 'fulfilled') importers.set(i.value.importers);
        else error.set(i.reason instanceof Error ? i.reason.message : String(i.reason));
        if (o.status === 'fulfilled') overview.set(o.value);
      });
  });

  const runDetect = (): void => {
    scanning.set(true);
    scanError.set(null);
    void api.scan()
      .then((payload) => scan.set(payload))
      .catch((e: unknown) => scanError.set(e instanceof Error ? e.message : String(e)))
      .finally(() => scanning.set(false));
  };

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Data' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Local acquisition routes: native tool-log importers, provider connections, and the bounded filesystem detector.'
        : 'Where your AI usage comes from. Fiscus reads what your tools have already recorded on this machine — it does not need your passwords.' })),

    () => {
      const err = error();
      if (err) return h('div', { class: 'card' }, h('p', { class: 'drawer-error', text: err }));
      const list = importers();
      if (!list) return h('div', { class: 'card' }, h('p', { class: 'drawer-muted', text: 'Loading…' }));

      const found = list.filter((i) => i.available);
      const missing = list.filter((i) => !i.available);
      const o = overview();
      const isDemo = o?.demo === true;
      const empty = (o?.summary.requests ?? 0) === 0;

      return h('div', null,
        isDemo
          ? h('div', { class: 'banner banner-demo' },
              h('span', { class: 'pill pill-demo', text: 'demo' }),
              h('p', null,
                h('strong', { text: 'You are looking at sample data. ' }),
                'Importing below replaces it with your own usage.'))
          : empty
            ? h('div', { class: 'banner' },
                h('p', null, h('strong', { text: 'Nothing imported yet. ' }),
                  'Every other screen will stay empty until something here brings usage in.'))
            : null,

        // What is actually on this machine, found or not. Both halves are shown:
        // knowing a tool was looked for and NOT found is information.
        h('section', { class: 'section' },
          h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Native importers' : 'Tools we can read on this machine') }),
          found.length === 0
            ? h('p', { class: 'drawer-muted', text: () => (isPrecise()
                ? 'No supported tool logs were located in their default paths.'
                : 'We could not find recorded usage from any of the tools Fiscus knows how to read.') })
            : h('div', { class: 'facts' },
                ...found.map((i) => h('div', { class: 'fact' },
                  h('span', { class: 'fact-key' },
                    h('span', { class: 'dot dot-on', 'aria-hidden': 'true' }),
                    i.label),
                  h('span', { class: 'fact-val', text: () => (isPrecise() ? 'located' : 'found') })))),

          missing.length > 0
            ? h('details', { class: 'more' },
                h('summary', { text: () => (isPrecise()
                  ? `${count(missing.length)} supported tool(s) not present`
                  : `${count(missing.length)} other tools Fiscus supports, not found here`) }),
                h('div', { class: 'facts' },
                  ...missing.map((i) => h('div', { class: 'fact fact-off' },
                    h('span', { class: 'fact-key' },
                      h('span', { class: 'dot', 'aria-hidden': 'true' }),
                      i.label),
                    h('span', { class: 'fact-val', text: i.blurb })))))
            : null),

        // Detection, run on demand rather than on load: it walks the filesystem,
        // and a screen should not do that to someone who only opened a tab.
        h('section', { class: 'section' },
          h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Detect what is on this machine' : 'Look around this computer') }),
          h('p', { class: 'view-plain', text: () => (isPrecise()
            ? 'A bounded walk of your home directory for AI tools and git repositories. Imports nothing; records the result as the baseline for change reporting.'
            : 'Fiscus can look through your files for AI tools and projects. This detection reads local paths; local imports remain local, while provider requests follow the configured egress boundary.') }),

          h('div', { class: 'cmd-row' },
            h('button', {
              class: 'btn-commit',
              disabled: () => scanning(),
              text: () => (scanning() ? 'Looking…' : isPrecise() ? 'Run detection' : 'Look around'),
              onclick: runDetect,
            }),
            h('code', { class: 'cmd', text: 'fiscus scan' })),

          () => {
            const e = scanError();
            if (e) return h('p', { class: 'drawer-error', text: e });
            const sc = scan();
            if (!sc) return null;

            const tools = (sc.tools ?? []).filter((t) => t.present !== false);
            return h('div', { class: 'card', style: 'margin-top: var(--s3)' },
              h('div', { class: 'facts' },
                h('div', { class: 'fact' },
                  h('span', { class: 'fact-key', text: () => (isPrecise() ? 'AI tools detected' : 'AI tools found') }),
                  h('span', { class: 'fact-val', text: count(tools.length) })),
                h('div', { class: 'fact' },
                  h('span', { class: 'fact-key', text: () => (isPrecise() ? 'git repositories' : 'projects found') }),
                  h('span', { class: 'fact-val', text: count(sc.repoCount) })),
                h('div', { class: 'fact' },
                  h('span', { class: 'fact-key', text: () => (isPrecise() ? 'repositories with attributed spend' : 'projects with spend attached') }),
                  h('span', { class: 'fact-val', text: count(sc.reposWithSpend) })),
                h('div', { class: 'fact' },
                  h('span', { class: 'fact-key', text: () => (isPrecise() ? 'directories visited' : 'folders checked') }),
                  h('span', { class: 'fact-val', text: count(sc.dirsVisited) }))),

              // The floor caveat. Without it the counts read as complete.
              sc.hitBudget
                ? h('p', { class: 'scope-note', text: () => (isPrecise()
                    ? 'The walk stopped at its visit budget. These counts are a lower bound, not a total.'
                    : 'There was too much to look through, so we stopped early. There may be more than this — treat these as "at least".') })
                : null,
              sc.unreadableDirs > 0
                ? h('span', { class: 'basis', text: () => (isPrecise()
                    ? `${count(sc.unreadableDirs)} directory/directories could not be read (permissions).`
                    : `${count(sc.unreadableDirs)} folders could not be opened, so anything inside them was missed.`) })
                : null);
          }),

        o && !empty
          ? h('div', { class: 'card' },
              h('div', { class: 'card-head' },
                h('span', { class: 'card-title', text: () => (isPrecise() ? 'Currently held' : 'What Fiscus has so far') })),
              h('div', { class: 'stat', text: count(o.summary.requests) }),
              h('span', { class: 'basis', text: () => (isPrecise()
                ? `recorded requests totalling ${usd(o.summary.costUsd)} of metered cost`
                : `AI calls recorded, worth ${usd(o.summary.costUsd)} by our own measurement`) }))
          : null,

        h('section', { class: 'section' },
          h('h2', { class: 'section-title', text: () => (isPrecise() ? 'Actions on this layer' : 'Things you can do with this') }),
          h('div', { class: 'actions' },
            actionCard('import'),
            actionCard('scan'),
            actionCard('connect'),
            actionCard('sources'),
            actionCard('baseline'),
            actionCard('demo'))));
    });
}
