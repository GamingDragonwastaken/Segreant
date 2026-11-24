/** How much finished work stayed in the code, as counts and list cost. The Statement and Value pages show the same table. */
import { h } from '../core/dom.ts';
import { count, usd } from '../core/fmt.ts';
import type { KeptWork } from '../core/api.ts';

export function keptTable(k: Omit<KeptWork, 'windowDays'>): Node {
  const pieces = (n: number): string => `${count(n)} ${n === 1 ? 'piece' : 'pieces'} of work`;
  const row = (label: string, tone: string, value: string): Node =>
    h('div', { class: 'statement-kept-row' },
      h('span', { class: `statement-kept-key ${tone}`, text: label }),
      h('span', { class: 'statement-kept-val', text: value }));
  const line = (label: string, c: { units: number; costUsd: number }, tone: string): Node =>
    row(label, tone, `${pieces(c.units)} · ${usd(c.costUsd)} list cost`);
  const due = k.tooEarly.nextCheckMs === null ? '' : `, first check ${new Date(k.tooEarly.nextCheckMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  return h('div', { class: 'statement-kept' },
    line('Kept', k.kept, 'gate-pass'),
    line('Not kept', k.notKept, 'gate-fail'),
    k.contested.units > 0 ? line('Results disagree', k.contested, 'gate-unchecked') : null,
    k.unknown.units > 0 ? line('No signal', k.unknown, 'gate-unchecked') : null,
    k.tooEarly.units > 0 ? row('Too early to tell', 'gate-unchecked', `${pieces(k.tooEarly.units)}${due}`) : null);
}
