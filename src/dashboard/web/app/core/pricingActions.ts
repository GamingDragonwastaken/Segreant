/** Local price declarations and audited history corrections, preview first. */
import { api } from './api.ts';
import type { DeclaredPrice, UnknownPricingPayload, UnknownPricingModel, RepricePayload } from './generated-types.ts';
import { h } from './dom.ts';
import { signal } from './signal.ts';
import { usd, count } from './fmt.ts';
import { capability, type Capability } from './registry.ts';
import { openAction, type ActionSpec, type PreviewResult } from '../components/drawer.ts';

const AFTER_DECLARATION = 'Recorded requests keep their estimate until you re-price them';
const matchWords = (kind: string): string => kind.startsWith('family_') ? 'nearest model on the card' : 'generic rate';
const decimal = (raw: string): boolean => /^(0|[1-9]\d{0,6})(\.\d{1,12})?$/.test(raw) && Number(raw) > 0;

export function pricingUnknownAction(cap: Capability): ActionSpec {
  const data = signal<UnknownPricingPayload | null>(null);
  const saved = signal(false);
  const selected = signal<string | null>(null);
  /** A price the user set and chose to remove; exclusive with a model being priced. */
  const removal = signal<string | null>(null);
  const drafts = new Map<string, ReturnType<typeof draft>>();
  let read: Promise<UnknownPricingPayload> | null = null;
  const key = (model: UnknownPricingModel): string => JSON.stringify([model.provider, model.model]);
  /** A declared price is edited in place: a model already on the card, or whose guessed rows were re-priced, never returns to the list above. */
  const declaredKey = (model: string): string => JSON.stringify(['declared', model]);
  /** A declared price's draft starts from its stored numbers, so changing the input price keeps the cache prices (PR #146 review). */
  function draft(model: { model: string; rate?: DeclaredPrice['rate']; like?: string }) {
    const r = model.rate;
    return { model: model.model, mode: signal('skip'), like: signal(model.like ?? ''), input: signal(r?.input ?? ''), output: signal(r?.output ?? ''),
      cacheRead: signal(r?.cacheRead ?? ''), cacheWrite: signal(r?.cacheWrite ?? '') };
  }
  const load = async (): Promise<UnknownPricingPayload> => {
    if (!read) read = api.pricingUnknown().then((payload) => {
      for (const model of payload.models) if (!drafts.has(key(model))) drafts.set(key(model), draft(model));
      for (const declared of payload.declared) if (!drafts.has(declaredKey(declared.model))) drafts.set(declaredKey(declared.model), draft(declared));
      data.set(payload);
      return payload;
    }).catch((error: unknown) => { read = null; throw error; });
    return read;
  };
  const choice = () => {
    const chosen = selected.peek();
    return chosen ? drafts.get(chosen) : undefined;
  };
  const priceBody = (): Record<string, unknown> | null => {
    const d = choice();
    if (!d) return null;
    switch (d.mode.peek()) {
      case 'free': return { model: d.model, kind: 'free' };
      case 'like': return d.like.peek().trim() ? { model: d.model, kind: 'like', like: d.like.peek().trim() } : null;
      case 'rate': {
        // Cache prices are optional; left blank, the engine's defaults apply
        // (reads at 0.1x input, writes at 1.25x). A filled one must be valid.
        const read = d.cacheRead.peek().trim();
        const write = d.cacheWrite.peek().trim();
        if (!decimal(d.input.peek()) || !decimal(d.output.peek())) return null;
        if ((read !== '' && !decimal(read)) || (write !== '' && !decimal(write))) return null;
        return { model: d.model, kind: 'rate', input: d.input.peek(), output: d.output.peek(),
          ...(read === '' ? {} : { cacheRead: read }), ...(write === '' ? {} : { cacheWrite: write }) };
      }
      default: return null;
    }
  };
  return {
    capability: cap,
    command: () => {
      const id = selected();
      const d = id ? drafts.get(id) : undefined;
      const removing = removal();
      if (removing) return /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(removing) ? `segreant pricing unset ${removing}` : null;
      if (!d || d.mode() === 'skip') return 'segreant pricing unknown';
      // Model names and prices are validated server-side; do not interpolate untrusted shell words.
      const word = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(s) ? s : null;
      const model = word(d.model);
      if (!model) return null;
      if (d.mode() === 'free') return `segreant pricing set ${model} --free`;
      if (d.mode() === 'like') return word(d.like()) ? `segreant pricing set ${model} --like ${d.like()}` : null;
      const read = d.cacheRead().trim();
      const write = d.cacheWrite().trim();
      if ((read !== '' && !decimal(read)) || (write !== '' && !decimal(write))) return null;
      return decimal(d.input()) && decimal(d.output())
        ? `segreant pricing set ${model} --input ${d.input()} --output ${d.output()}${read ? ` --cache-read ${read}` : ''}${write ? ` --cache-write ${write}` : ''}`
        : null;
    },
    fields: () => h('div', null,
      h('p', { class: 'drawer-note', text: 'Choose one model and review its price below. Skip keeps its estimate. Prices apply to future requests; re-pricing history is a separate step.' }),
      () => data()?.models.map((model, i) => {
        const id = key(model);
        const d = drafts.get(id)!;
        const change = (field: typeof d.input, event: Event) => {
          field.set((event.target as HTMLInputElement).value);
          selected.set(id);
          removal.set(null);
        };
        const input = (label: string, suffix: string, field: typeof d.input, placeholder: string) => h('div', null,
          h('label', { class: 'drawer-h3', for: `price-${i}-${suffix}`, text: label }),
          h('input', { id: `price-${i}-${suffix}`, class: 'drawer-input', type: 'text',
            inputmode: suffix === 'like' ? 'text' : 'decimal', maxlength: suffix === 'like' ? '200' : '20',
            value: field.peek(), placeholder, oninput: (event: Event) => change(field, event) }));
        return h('section', { class: 'pricing-model' },
          h('h3', { class: 'drawer-h3', text: `${model.provider} / ${model.model}` }),
          h('p', { class: 'drawer-note', text: `${count(model.requests)} requests · ${usd(model.costUsd)} recorded (estimated)` }),
          h('p', { class: 'drawer-note', text: matchWords(model.rateMatchKind) }),
          h('label', { class: 'drawer-h3', for: `price-${i}-mode`, text: `Price for ${model.model}` }),
          h('select', { id: `price-${i}-mode`, class: 'drawer-input', onchange: (event: Event) => {
            d.mode.set((event.target as HTMLSelectElement).value);
            selected.set(d.mode.peek() === 'skip' ? null : id);
            if (d.mode.peek() !== 'skip') removal.set(null);
          } },
            h('option', { value: 'skip', selected: d.mode.peek() === 'skip', text: 'Skip' }), h('option', { value: 'like', selected: d.mode.peek() === 'like', text: 'Price like…' }),
            h('option', { value: 'rate', selected: d.mode.peek() === 'rate', text: 'Set a price' }), h('option', { value: 'free', selected: d.mode.peek() === 'free', text: 'Free (local model)' })),
          () => d.mode() === 'like'
            ? input(`Exact card model for ${model.model}`, 'like', d.like, 'claude-haiku-4-5')
            : d.mode() === 'rate' ? h('div', null,
              input(`Input for ${model.model} (USD per 1M tokens)`, 'input', d.input, '1.00'),
              input(`Output for ${model.model} (USD per 1M tokens)`, 'output', d.output, '3.00'),
              input(`Cache read for ${model.model}, optional (USD per 1M tokens)`, 'read', d.cacheRead, '0.10 x input if blank'),
              input(`Cache write for ${model.model}, optional (USD per 1M tokens)`, 'write', d.cacheWrite, '1.25 x input if blank')) : null);
      }) ?? null,
      () => (data()?.declared.length ?? 0) > 0 ? h('section', { class: 'pricing-declared' },
        h('h3', { class: 'drawer-h3', text: 'Your prices' }),
        h('p', { class: 'drawer-note', text: 'Change or remove a price you set. Apply saves the one you changed last.' }),
        ...data()!.declared.map((p, i) => {
          const id = declaredKey(p.model);
          const d = drafts.get(id) ?? draft(p);
          if (!drafts.has(id)) drafts.set(id, d);
          const field = (label: string, suffix: string, sig: typeof d.input, placeholder: string) => h('div', null,
            h('label', { class: 'drawer-h3', for: `declared-${i}-${suffix}`, text: label }),
            h('input', { id: `declared-${i}-${suffix}`, class: 'drawer-input', type: 'text',
              inputmode: suffix === 'like' ? 'text' : 'decimal', maxlength: suffix === 'like' ? '200' : '20',
              value: sig.peek(), placeholder, oninput: (event: Event) => { sig.set((event.target as HTMLInputElement).value); selected.set(id); removal.set(null); } }));
          return h('div', { class: 'pricing-model' },
            h('label', { class: 'drawer-h3', for: `declared-${i}-mode`, text: `${p.model}: ${p.summary}` }),
            h('select', { id: `declared-${i}-mode`, class: 'drawer-input', onchange: (event: Event) => {
              const mode = (event.target as HTMLSelectElement).value;
              if (mode === 'remove') {
                d.mode.set('skip');
                removal.set(p.model);
                selected.set(null);
                return;
              }
              if (removal.peek() === p.model) removal.set(null);
              d.mode.set(mode === 'keep' ? 'skip' : mode);
              selected.set(mode === 'keep' ? (selected.peek() === id ? null : selected.peek()) : id);
            } },
              h('option', { value: 'keep', selected: removal.peek() !== p.model && d.mode.peek() === 'skip', text: 'Keep' }),
              h('option', { value: 'like', selected: d.mode.peek() === 'like', text: 'Change: price like…' }),
              h('option', { value: 'rate', selected: d.mode.peek() === 'rate', text: 'Change: set a price' }),
              h('option', { value: 'free', selected: d.mode.peek() === 'free', text: 'Change: free (local model)' }),
              h('option', { value: 'remove', selected: removal.peek() === p.model, text: 'Remove price' })),
            () => d.mode() === 'like'
              ? field(`Exact card model for ${p.model}`, 'like', d.like, 'claude-haiku-4-5')
              : d.mode() === 'rate' ? h('div', null,
                field(`New input for ${p.model} (USD per 1M tokens)`, 'input', d.input, '1.00'),
                field(`New output for ${p.model} (USD per 1M tokens)`, 'output', d.output, '3.00'),
                field(`New cache read for ${p.model}, optional (USD per 1M tokens)`, 'read', d.cacheRead, '0.10 x input if blank'),
                field(`New cache write for ${p.model}, optional (USD per 1M tokens)`, 'write', d.cacheWrite, '1.25 x input if blank')) : null);
        })) : null,
      h('div', { role: 'status', 'aria-live': 'polite' }, () => saved() ? h('div', null,
        h('p', { class: 'drawer-note', text: AFTER_DECLARATION }),
        h('button', { class: 'btn-ghost', text: 'Re-price recorded requests', onclick: () => openAction(repriceAction(capability('reprice')!)) })) : null)),
    preview: async (): Promise<PreviewResult> => {
      const payload = await load();
      const removing = removal.peek();
      if (removing) {
        return {
          applicable: !payload.demo,
          summary: `Remove your price for ${removing}. New requests go back to the rate card, or to an estimate if the card does not know the model; recorded requests are unchanged.`,
          blockedReason: 'Sample data: start without --demo to change a price.',
          notes: [payload.boundary],
        };
      }
      const body = priceBody();
      const d = choice();
      const description = !body ? '' : body.kind === 'free' ? 'Free (local model): $0 your price per request.'
        : body.kind === 'like' ? `Your price follows ${body.like}, an exact model on the current card.`
        : `Your price: input $${body.input}, output $${body.output}${body.cacheRead ? `, cache read $${body.cacheRead}` : ''}${body.cacheWrite ? `, cache write $${body.cacheWrite}` : ''} USD per 1M tokens.`;
      return {
        applicable: !payload.demo && body !== null,
        summary: body ? `Save your price for ${d!.model}. ${description}`
          : payload.models.length ? `${count(payload.models.length)} models still use guessed prices. Choose a price for one model to review it here.`
          : 'No unpriced models remain. Recorded requests may still need re-pricing.',
        blockedReason: payload.demo ? 'Sample data: start without --demo to save a price.' : 'Choose a price for one model. A rate needs positive input and output prices; Price like needs an exact card model name.',
        notes: [payload.boundary, 'The most recently changed model is the one Apply saves. Other choices stay here until you apply them.'],
      };
    },
    commit: async () => {
      const removing = removal.peek();
      if (removing) {
        const removed = await api.write.pricingUnset(removing);
        removal.set(null);
        read = null;
        try { await load(); } catch { /* the message below still holds */ }
        return { ok: removed.ok, message: removed.removed ? `Removed your price for ${removing}.` : `${removing} had no price of yours.` };
      }
      const body = priceBody();
      if (!body) return { ok: false, message: 'Choose a price for one model first.' };
      const result = await api.write.pricingDeclare(body);
      choice()?.mode.set('skip');
      saved.set(true);
      selected.set(null);
      read = null;
      try { await load(); }
      catch { return { ok: true, message: `Saved your price for ${result.model}. Reopen this drawer to refresh the list.` }; }
      return { ok: result.ok, message: `Saved your price for ${result.model}.` };
    },
  };
}

const afterWords = (result: RepricePayload): string => [...new Set(result.byModel.map((m) => m.afterBasis))].join(' + ') || 'list price';
const changedRows = (result: RepricePayload) => [
  ...result.byModel.map((m) => ({ label: `${m.provider} / ${m.model}`, value: `${count(m.rows)} requests · ${usd(m.beforeUsd)} recorded (estimated) → ${usd(m.afterUsd)} ${m.afterBasis}` })),
  { label: 'Total', value: `${usd(result.totalBeforeUsd)} recorded (estimated) → ${usd(result.totalAfterUsd)} ${afterWords(result)}` },
];

export function repriceAction(cap: Capability): ActionSpec {
  const applied = signal<RepricePayload | null>(null);
  return {
    capability: cap,
    command: () => 'segreant reprice --apply',
    commitLabel: 'Apply re-pricing',
    fields: () => h('div', null, () => {
      const result = applied();
      return result ? h('section', null,
        h('h3', { class: 'drawer-h3', text: 'Changes applied' }),
        h('dl', { class: 'drawer-rows' }, ...changedRows(result).flatMap((r) => [h('dt', { text: r.label }), h('dd', { text: r.value })]))) : null;
    }),
    preview: async () => {
      const result = await api.write.reprice(false);
      return {
        applicable: result.repriceable > 0,
        summary: `${count(result.repriceable)} requests can be re-priced. ${count(result.stillEstimated)} still use guesses and will keep their recorded amount.`,
        blockedReason: 'No recorded estimates can be replaced with a current list price or your price.',
        rows: changedRows(result),
        notes: ['Only recorded estimates change. Each previous amount is kept in the request’s price history.',
          'Apply uses the card, declarations and requests current at that moment. It shows the amounts it actually wrote.',
          'Value snapshot costs are updated on their recorded basis. Older snapshots whose basis cannot be recovered are marked stale. Outcomes stay the same.'],
      };
    },
    commit: async () => {
      const result = await api.write.reprice(true);
      applied.set(result);
      window.dispatchEvent(new CustomEvent('segreant:ledger-changed', { detail: { claim: 'pricing' } }));
      const sync = result.realizationSync;
      return { ok: true, message: `Re-priced ${count(result.repriceable)} requests: ${usd(result.totalBeforeUsd)} recorded (estimated) → ${usd(result.totalAfterUsd)} ${afterWords(result)}.${sync?.unresolvable ? ` ${count(sync.unresolvable)} older value snapshots keep their previous cost and are marked stale.` : ''}` };
    },
  };
}
