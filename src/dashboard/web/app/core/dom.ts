/**
 * DOM construction without a template language.
 *
 * `h()` builds real elements. Any prop or child may be a function, in which case
 * it becomes a reactive binding that updates in place. No virtual DOM, no diff:
 * the binding knows exactly which attribute or text node it owns.
 *
 * Text is set through `textContent` and attributes through `setAttribute`, so
 * there is no path in this module that parses a string as HTML. Ledger data is
 * operator-supplied — project names, model ids, cost-centre labels all arrive
 * from files on disk — and none of it should ever be able to become markup.
 */

import { effect, onCleanup } from './signal.ts';
import { captureFocus, restoreFocus, type FocusTarget } from './focus.ts';

export { captureFocus, restoreFocus } from './focus.ts';
export type { FocusTarget } from './focus.ts';

export type Child = Node | string | number | null | undefined | false | (() => Child) | Child[];

type Handler = (event: Event) => void;

export interface Props {
  class?: string | (() => string);
  style?: string | (() => string);
  text?: string | number | (() => string | number);
  html?: never; // deliberately unavailable — see the module comment
  [key: string]: unknown;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g', 'line', 'polyline', 'text', 'defs', 'linearGradient', 'stop', 'ellipse']);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): Element;
export function h(tag: string, props?: Props | null, ...children: Child[]): Element {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      const type = key.slice(2).toLowerCase();
      el.addEventListener(type, value as Handler);
      continue;
    }

    if (key === 'text') {
      bind(() => {
        el.textContent = String(typeof value === 'function' ? (value as () => unknown)() : value);
      });
      continue;
    }

    if (typeof value === 'function') {
      bind(() => setAttr(el, key, (value as () => unknown)()));
      continue;
    }

    setAttr(el, key, value);
  }

  append(el, children);
  return el;
}

function setAttr(el: Element, key: string, value: unknown): void {
  if (value === false || value === null || value === undefined) {
    el.removeAttribute(key);
    return;
  }
  if (value === true) {
    el.setAttribute(key, '');
    return;
  }
  el.setAttribute(key, String(value));
}

/** Append children, turning functions into reactive regions. */
export function append(parent: Element, children: Child[]): void {
  for (const child of children.flat(8)) {
    if (child === null || child === undefined || child === false) continue;

    if (typeof child === 'function') {
      // A reactive region is delimited by a comment anchor so it can replace its
      // own content without disturbing siblings.
      const anchor = document.createComment('');
      parent.appendChild(anchor);
      let owned: Node[] = [];
      bind(() => {
        for (const node of owned) node.parentNode?.removeChild(node);
        owned = [];
        const produced = child();
        const fragment = document.createDocumentFragment();
        collect(fragment, produced, owned);
        anchor.parentNode?.insertBefore(fragment, anchor);
      });
      continue;
    }

    if (child instanceof Node) {
      parent.appendChild(child);
      continue;
    }

    parent.appendChild(document.createTextNode(String(child)));
  }
}

function collect(target: DocumentFragment, child: Child, owned: Node[]): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) collect(target, c, owned);
    return;
  }
  if (typeof child === 'function') {
    collect(target, child(), owned);
    return;
  }
  const node = child instanceof Node ? child : document.createTextNode(String(child));
  owned.push(node);
  target.appendChild(node);
}

/** An effect whose lifetime is tied to the surrounding reactive scope. */
function bind(fn: () => void): void {
  const dispose = effect(fn);
  onCleanup(dispose);
}

/** Replace an element's entire contents. */
export function render(target: Element, ...children: Child[]): void {
  target.textContent = '';
  append(target, children);
}

export function $<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document): T | null {
  return scope.querySelector<T>(selector);
}

/** Trap focus inside a container — used by the action drawer. */
export function trapFocus(container: HTMLElement): () => void {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}
