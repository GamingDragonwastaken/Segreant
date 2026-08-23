/**
 * The action drawer — the one place anything in Fiscus happens.
 *
 * The CLI's signature is preview-by-default, `--apply` to persist. That is not a
 * safety feature bolted onto the product; it IS the product's argument, that a
 * claim should be inspectable before you accept it. So the GUI does not confirm
 * with a modal that says "Are you sure?" — a question nobody reads. It shows the
 * preview, states what will change, names the consequence out loud, prints the
 * equivalent command, and only then offers the commit.
 *
 * The commit control's weight scales with the consequence tier:
 *
 *   read         nothing to commit; the drawer is a viewer
 *   local        one button, after a preview has actually loaded
 *   credential   what is read and where it goes, stated before the button appears
 *   egress       what leaves this machine, stated in bytes and kind
 *   destructive  the operator types the id of the thing being destroyed
 *
 * A tier is never softened because an action feels routine. `prune` deleting
 * three rows uses the same gate as `prune` deleting three hundred thousand.
 */

import { h, render, trapFocus } from '../core/dom.ts';
import { signal, effect } from '../core/signal.ts';
import { isPrecise } from '../core/fmt.ts';
import type { Capability, Consequence } from '../core/registry.ts';

export interface PreviewResult {
  /** Plain-language statement of what the commit would do. Required. */
  summary: string;
  /** Rows of the computed preview: what changes, from what, to what. */
  rows?: Array<{ label: string; value: string; note?: string }>;
  /** Anything the operator should know that is not a change — exclusions, refusals. */
  notes?: string[];
  /** False when there is genuinely nothing to apply; the commit is then disabled with a reason. */
  applicable: boolean;
  /** Why it is not applicable, when it is not. */
  blockedReason?: string;
}

export interface ActionSpec {
  capability: Capability;
  /** Compute the preview. Must not write. Runs when the drawer opens. */
  preview: () => Promise<PreviewResult>;
  /** Persist. Only reachable after a preview reported `applicable`. */
  commit?: () => Promise<{ ok: boolean; message: string }>;
  /** Extra fields rendered above the preview (a period picker, a file choice). */
  fields?: () => Node;
  /** A same-origin path the operator can download instead of committing. */
  download?: string;
}

const CONSEQUENCE_COPY: Record<Consequence, { badge: string; plain: string; tone: string }> = {
  read: { badge: 'reads only', plain: 'This looks at your data. It changes nothing.', tone: 'calm' },
  local: { badge: 'writes locally', plain: 'This action writes to the ledger on this machine. It does not itself send data to another service.', tone: 'local' },
  credential: { badge: 'uses a credential', plain: 'This reads a provider credential and contacts the provider.', tone: 'warn' },
  egress: { badge: 'sends data off this machine', plain: 'This transmits data to a server you configured.', tone: 'warn' },
  destructive: { badge: 'cannot be undone', plain: 'This permanently changes or deletes recorded data.', tone: 'danger' },
};

const open = signal<ActionSpec | null>(null);

export function openAction(spec: ActionSpec): void {
  open.set(spec);
}

export function closeAction(): void {
  open.set(null);
}

export function mountDrawer(root: HTMLElement): void {
  const host = h('div', { class: 'drawer-host' });
  root.appendChild(host);

  effect(() => {
    const spec = open();
    render(host);
    if (!spec) {
      document.body.classList.remove('drawer-open');
      return;
    }
    document.body.classList.add('drawer-open');
    render(host, panel(spec));
  });
}

function panel(spec: ActionSpec): Node {
  const { capability: cap } = spec;
  const consequence = CONSEQUENCE_COPY[cap.consequence];

  const preview = signal<PreviewResult | null>(null);
  const error = signal<string | null>(null);
  const busy = signal(true);
  const committing = signal(false);
  const result = signal<{ ok: boolean; message: string } | null>(null);
  const typed = signal('');

  void spec.preview()
    .then((p) => preview.set(p))
    .catch((e: unknown) => error.set(e instanceof Error ? e.message : String(e)))
    .finally(() => busy.set(false));

  const confirmPhrase = cap.id;
  const confirmed = (): boolean => cap.consequence !== 'destructive' || typed().trim() === confirmPhrase;

  const scrim = h('div', {
    class: 'drawer-scrim',
    onclick: () => closeAction(),
  });

  const body = h(
    'aside',
    {
      class: `drawer tone-${consequence.tone}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'drawer-title',
    },

    h(
      'header',
      { class: 'drawer-head' },
      h('div', { class: 'drawer-badge', text: consequence.badge }),
      h('h2', { id: 'drawer-title', class: 'drawer-title', text: cap.label }),
      h('p', { class: 'drawer-plain', text: cap.plain }),
      h('button', { class: 'drawer-close', 'aria-label': 'Close', onclick: () => closeAction() }, '×'),
    ),

    h('p', { class: 'drawer-consequence', text: consequence.plain }),

    cap.warning ? h('div', { class: 'drawer-warning', role: 'note' }, h('strong', { text: 'Before you do this' }), h('p', { text: cap.warning })) : null,

    spec.fields ? h('div', { class: 'drawer-fields' }, spec.fields()) : null,

    h(
      'section',
      { class: 'drawer-preview' },
      h('h3', { class: 'drawer-h3', text: 'Preview' }),
      () => {
        if (busy()) return h('p', { class: 'drawer-muted', text: 'Working it out…' });
        const err = error();
        if (err) return h('p', { class: 'drawer-error', text: err });
        const p = preview();
        if (!p) return null;
        return h(
          'div',
          null,
          h('p', { class: 'drawer-summary', text: p.summary }),
          p.rows && p.rows.length
            ? h(
                'dl',
                { class: 'drawer-rows' },
                ...p.rows.flatMap((row) => [
                  h('dt', { text: row.label }),
                  h('dd', null, h('span', { text: row.value }), row.note ? h('span', { class: 'drawer-note', text: row.note }) : null),
                ]),
              )
            : null,
          p.notes && p.notes.length
            ? h('ul', { class: 'drawer-notes' }, ...p.notes.map((n) => h('li', { text: n })))
            : null,
        );
      },
    ),

    // The command is always shown. For the developer it is the faster path; for
    // everyone it is the audit trail — what this button is about to do, in a form
    // that can be pasted into an issue, a runbook, or a code review.
    h(
      'section',
      { class: 'drawer-command' },
      h('h3', { class: 'drawer-h3', text: isPrecise() ? 'Equivalent command' : 'The same thing, as a command' }),
      h(
        'div',
        { class: 'cmd-row' },
        h('code', { class: 'cmd', text: cap.command }),
        h('button', {
          class: 'cmd-copy',
          text: 'Copy',
          onclick: (event: Event) => {
            void navigator.clipboard?.writeText(cap.command);
            const button = event.currentTarget as HTMLButtonElement;
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = 'Copy'; }, 1400);
          },
        }),
      ),
    ),

    cap.consequence === 'destructive'
      ? h(
          'section',
          { class: 'drawer-confirm' },
          h('label', { class: 'drawer-h3', for: 'drawer-confirm-input' }, `Type `, h('code', { text: confirmPhrase }), ` to enable the button`),
          h('input', {
            id: 'drawer-confirm-input',
            class: 'drawer-input',
            type: 'text',
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: confirmPhrase,
            oninput: (event: Event) => typed.set((event.target as HTMLInputElement).value),
          }),
        )
      : null,

    h(
      'footer',
      { class: 'drawer-foot' },
      () => {
        const r = result();
        if (r) return h('p', { class: r.ok ? 'drawer-done' : 'drawer-error', text: r.message });
        return null;
      },
      h('div', { class: 'drawer-actions' },
        h('button', { class: 'btn-ghost', text: 'Close', onclick: () => closeAction() }),
        spec.download
          ? h('a', { class: 'btn-commit', href: spec.download, download: '', text: 'Download' })
          : null,
        () => {
          if (!spec.commit) return null;
          const p = preview();
          const ready = !busy() && p !== null && p.applicable && confirmed() && !committing() && result() === null;
          return h('button', {
            class: `btn-commit tone-${consequence.tone}`,
            disabled: !ready,
            title: p && !p.applicable ? (p.blockedReason ?? 'Nothing to apply') : undefined,
            text: () => (committing() ? 'Working…' : commitLabel(cap.consequence)),
            onclick: () => {
              if (!ready || !spec.commit) return;
              committing.set(true);
              void spec.commit()
                .then((r) => result.set(r))
                .catch((e: unknown) => result.set({ ok: false, message: e instanceof Error ? e.message : String(e) }))
                .finally(() => committing.set(false));
            },
          });
        },
      ),
    ),
  );

  const release = trapFocus(body as HTMLElement);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeAction();
  };
  document.addEventListener('keydown', onKey);

  // Focus lands on the dialog, not on the commit button: the preview is the
  // point, and a focused primary action invites Enter before reading.
  queueMicrotask(() => (body as HTMLElement).focus());
  (body as HTMLElement).tabIndex = -1;

  effect(() => {
    if (open() === null) {
      release();
      document.removeEventListener('keydown', onKey);
    }
  });

  return h('div', { class: 'drawer-wrap' }, scrim, body);
}

function commitLabel(consequence: Consequence): string {
  switch (consequence) {
    case 'local': return 'Apply';
    case 'credential': return 'Contact provider';
    case 'egress': return 'Send';
    case 'destructive': return 'Delete permanently';
    default: return 'Apply';
  }
}
