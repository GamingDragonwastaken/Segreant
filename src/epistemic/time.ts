/** Canonical UTC ISO-8601 instant. */
export type Instant = string;

export interface TimeInterval {
  readonly from: Instant;
  readonly to: Instant;
}

export interface BitemporalCoordinates {
  /** When the represented fact/event is valid in the modeled world. */
  readonly validTime: TimeInterval;
  /** When Fiscus learned/recorded the evidence. */
  readonly observedAt: Instant;
}

export type IntervalRelation = 'equal' | 'contains' | 'within' | 'disjoint' | 'overlaps';

export function instant(value: string): Instant {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new Error(`timestamp must be canonical UTC ISO-8601: ${value}`);
  return canonical;
}

export function interval(from: string, to: string): TimeInterval {
  const canonicalFrom = instant(from);
  const canonicalTo = instant(to);
  if (Date.parse(canonicalFrom) >= Date.parse(canonicalTo)) {
    throw new Error('time interval start must be before end');
  }
  return Object.freeze({ from: canonicalFrom, to: canonicalTo });
}

/** Intervals are half-open: [from, to). */
export function intervalContains(value: TimeInterval, at: Instant): boolean {
  const point = Date.parse(instant(at));
  return Date.parse(value.from) <= point && point < Date.parse(value.to);
}

export function intervalRelation(a: TimeInterval, b: TimeInterval): IntervalRelation {
  const af = Date.parse(a.from);
  const at = Date.parse(a.to);
  const bf = Date.parse(b.from);
  const bt = Date.parse(b.to);

  if (af === bf && at === bt) return 'equal';
  if (af <= bf && at >= bt) return 'contains';
  if (bf <= af && bt >= at) return 'within';
  if (at <= bf || bt <= af) return 'disjoint';
  return 'overlaps';
}
