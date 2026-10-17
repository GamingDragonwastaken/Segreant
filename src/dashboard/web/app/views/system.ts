/**
 * System — settings, maintenance, and the parity table.
 *
 * The parity table is not documentation. Segreant's argument is that an important
 * claim should be inspectable, and "the GUI can do everything the CLI can" is an
 * important claim — so it is rendered from the same registry the rest of the GUI
 * routes through. A capability with no screen says so here, inside the product,
 * rather than in a README nobody opens.
 */

import { themeChoice, setTheme, type ThemeChoice } from '../core/theme.ts';
import { viewPrefs, setView, setJobShown, jobShown, type Density } from '../core/view.ts';
import { JOBS } from '../core/jobs.ts';
import { h } from '../core/dom.ts';
import { CAPABILITY_SPECS, TERRITORIES, paritySummary } from '../core/registry.ts';
import { isPrecise } from '../core/fmt.ts';
import { actionCard } from './spend.ts';
import { actionSpec, hasRunner } from '../core/actions.ts';
import { openAction } from '../components/drawer.ts';

const COVERAGE_WORDS: Record<string, string> = {
  full: 'in the GUI',
  partial: 'partly in the GUI',
  planned: 'command line only',
  // Deliberately not "command line only": that phrasing tells the reader a
  // screen has not been built, and here one cannot be.
  not_applicable: 'cannot have a screen',
};

const THEME_WORDS: ReadonlyArray<[ThemeChoice, string]> = [['system', 'Match this computer'], ['light', 'Light'], ['dark', 'Dark']];

/** Appearance is kept in this browser only; nothing about it reaches the ledger or the config file. */
function appearance(): Node {
  return h('div', { class: 'card appearance' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title', id: 'appearance-title', text: 'Appearance' })),
    h('div', { class: 'register-switch theme-switch', role: 'group', 'aria-labelledby': 'appearance-title' },
      ...THEME_WORDS.map(([choice, label]) => h('button', {
        type: 'button',
        'aria-pressed': () => (themeChoice() === choice ? 'true' : 'false'),
        onclick: () => setTheme(choice),
        text: label,
      }))),
    h('p', { class: 'basis', text: 'Saved in this browser only.' }));
}

const DENSITY_WORDS: ReadonlyArray<[Density, string]> = [['comfortable', 'Comfortable'], ['compact', 'Compact']];

function check(label: string, on: boolean, change: (on: boolean) => void): Node {
  return h('label', { class: 'pref' },
    h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }),
    h('span', { text: label }));
}

/** What you see. Display only: hiding a part never changes a figure. */
function viewChoices(): Node {
  const p = viewPrefs();
  return h('div', { class: 'card view-prefs' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-title', id: 'view-title', text: 'What you see' })),
    h('div', { class: 'register-switch theme-switch', role: 'group', 'aria-label': 'Density' },
      ...DENSITY_WORDS.map(([d, label]) => h('button', {
        type: 'button',
        'aria-pressed': () => (viewPrefs().density === d ? 'true' : 'false'),
        onclick: () => setView({ density: d }),
        text: label,
      }))),
    h('fieldset', { class: 'pref-group' },
      h('legend', { text: 'On every page' }),
      check('The four figures above the money pages', p.strip, (on) => setView({ strip: on })),
      check('A short explanation under each page title', p.intros, (on) => setView({ intros: on }))),
    h('fieldset', { class: 'pref-group' },
      h('legend', { text: 'Jobs in the top bar' }),
      ...JOBS.map((j) => check(j.label, jobShown(j.id), (on) => setJobShown(j.id, on))),
      h('p', { class: 'form-hint', text: 'A hidden job still opens from here, and the job you are in always shows.' }),
      () => h('div', { class: 'pref-links' }, ...JOBS.filter((j) => !jobShown(j.id)).map((j) => h('a', { href: `#/${j.id}`, text: `Open ${j.label}` })))),
    h('p', { class: 'basis', text: 'Saved in this browser only. Hiding something never changes a figure.' }));
}

export function systemView(): Node {
  const parity = paritySummary();

  return h('div', null,
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: 'Settings' }),
      h('p', { class: 'view-plain', text: () => isPrecise()
        ? 'Local configuration, rate cards, maintenance, and the CLI/GUI parity map rendered from the same registry the GUI routes through.'
        : 'Settings for this machine, plus a list of everything Segreant can do and whether it is done here or from the command line.' })),

    // The settings come first: this is the page someone opens to change one.
    // The parity map used to lead, a 60-row table that made this the longest page
    // in the product (10,140 px) with the settings at the very bottom.
    appearance(),
    viewChoices(),

    h('div', { class: 'actions', style: 'margin-top: var(--s5)' },
      actionCard('settings'),
      actionCard('features'),
      actionCard('doctor'),
      actionCard('clear-proposals'),
      actionCard('prune')),

    // Kept, and kept complete: the map is a claim the product makes about itself.
    // Closed by default, with its counts in the summary so the answer to "how
    // much can the GUI do" is readable without opening it.
    h('details', { class: 'section parity-details' },
      h('summary', { class: 'parity-summary' },
        h('span', { class: 'section-title', text: () => (isPrecise() ? 'CLI/GUI parity' : 'What this dashboard can and cannot do') }),
        h('span', { class: 'parity-counts', text: `${parity.full} in the GUI · ${parity.partial} partly · ${parity.planned} command line only · ${parity.notApplicable} cannot have a screen · of ${parity.total}` })),
      h('div', { class: 'grid' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'In the GUI' })),
          h('div', { class: 'stat', text: String(parity.full) }),
          h('span', { class: 'basis', text: `of ${parity.total} capabilities` })),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Partly' })),
          h('div', { class: 'stat', text: String(parity.partial) }),
          h('span', { class: 'basis', text: 'usable, with options only on the CLI' })),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Command line only' })),
          h('div', { class: 'stat', text: String(parity.planned) }),
          h('span', { class: 'basis', text: 'no screen yet — the command is listed' })),
        // The fourth state gets its own card rather than being folded into
        // "command line only". A capability the GUI cannot offer is not a gap in
        // the GUI, and counting it as one would make the parity fraction read
        // worse than the truth -- while leaving it out of `total` altogether was
        // the error this card exists to correct.
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Cannot have a screen' })),
          h('div', { class: 'stat', text: String(parity.notApplicable) }),
          h('span', { class: 'basis', text: 'structurally unavailable here — each row says why' }))),

      h('div', { class: 'card', style: 'margin-top: var(--s4)' },
        h('div', { class: 'card-head' }, h('span', { class: 'card-title', text: 'Parity map' })),
        h('p', { class: 'view-plain', style: 'margin-bottom: var(--s4)', text: 'Every capability Segreant has, where it lives, what it costs you to run it, and whether this interface covers it. Generated from the same registry the navigation uses, and checked against the command line\u2019s own dispatch, so it cannot drift from what the GUI does or quietly leave a command out.' }),
        h('div', { class: 'table-wrap' },
          h('table', { class: 'parity-table', 'aria-label': 'CLI/GUI parity map' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col', text: 'Capability' }),
              h('th', { scope: 'col', text: 'Section' }),
              h('th', { scope: 'col', text: 'Consequence' }),
              h('th', { scope: 'col', text: 'Here' }),
              h('th', { scope: 'col', text: 'Command' }))),
            h('tbody', null, ...CAPABILITY_SPECS.map((c) => h('tr', null,
              h('td', null, h('strong', { text: c.label }), h('br'), h('span', { class: 'action-plain', text: c.plain })),
              h('td', { text: TERRITORIES.find((t) => t.id === c.territory)?.label ?? c.territory }),
              h('td', null, h('span', { class: `tag tag-${c.consequence}`, text: c.consequence === 'read' ? 'reads only' : c.consequence })),
              h('td', null,
                h('span', {
                  class: c.coverage === 'planned' || c.coverage === 'not_applicable' ? 'tag tag-planned' : 'tag',
                  text: COVERAGE_WORDS[c.coverage] ?? c.coverage,
                }),
                // The reason travels with the state, in the same cell. A row that
                // says the GUI cannot do something and does not say why is the
                // assertion without its basis.
                ...(c.coverageNote ? [h('br'), h('span', { class: 'action-plain', text: c.coverageNote })] : []),
                // The map is where a reader learns a capability exists, so a row
                // the GUI can run opens its drawer right here, preview first.
                ...(hasRunner(c) ? [h('br'), h('button', { class: 'link-btn parity-open', type: 'button', 'aria-label': `Open ${c.label}`, text: 'Open', onclick: () => openAction(actionSpec(c)) })] : [])),
              h('td', null, h('code', { class: 'cmd', style: 'white-space: nowrap', text: c.command }))))))))));
}
