/**
 * Privacy — the statement, read from this machine like every other page, so it
 * is there with no network and says the same as docs/PRIVACY.md.
 */

import { h } from '../core/dom.ts';
import { PRIVACY_TITLE, PRIVACY_LEAD, PRIVACY_SECTIONS } from '../core/privacyText.ts';

/** Text with `backtick` spans as code. Built as nodes: no string is parsed as HTML. */
function prose(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? h('code', { class: 'inline-code', text: part }) : document.createTextNode(part)));
}

export function privacyView(): Node {
  return h('div', { class: 'privacy' },
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: PRIVACY_TITLE }),
      h('p', { class: 'privacy-lead' }, ...prose(PRIVACY_LEAD))),
    ...PRIVACY_SECTIONS.map((section) => h('section', { class: 'section privacy-section' },
      h('h2', { class: 'section-title', text: section.heading }),
      ...section.paragraphs.map((p) => h('p', null, ...prose(p))),
      section.items ? h('ul', null, ...section.items.map((item) => h('li', null, ...prose(item)))) : null)));
}
