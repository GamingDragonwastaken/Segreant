export type CapitalBucket = 'production' | 'exploration' | 'reserve';

export interface CapitalBuckets {
  productionMicros: number;
  explorationMicros: number;
  reserveMicros: number;
}

export interface CapitalAccount extends CapitalBuckets {
  id: string;
  parentId: string | null;
}

export interface ConsumedCapital extends CapitalBuckets {}

export interface CapitalState {
  accounts: CapitalAccount[];
  consumedByAccount: Record<string, ConsumedCapital>;
}

export type CapitalTransaction =
  | { kind: 'transfer'; from: string; to: string; bucket: CapitalBucket; amountMicros: number; reason: string }
  | { kind: 'spend'; account: string; bucket: CapitalBucket; amountMicros: number; reason: string };

const ZERO_CONSUMED: Readonly<ConsumedCapital> = {
  productionMicros: 0,
  explorationMicros: 0,
  reserveMicros: 0,
};

function bucketField(bucket: CapitalBucket): keyof CapitalBuckets {
  switch (bucket) {
    case 'production': return 'productionMicros';
    case 'exploration': return 'explorationMicros';
    case 'reserve': return 'reserveMicros';
  }
}

function assertMicros(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe-integer microdollar amount`);
}

export function validateCapitalHierarchy(accounts: readonly CapitalAccount[]): void {
  const byId = new Map<string, CapitalAccount>();
  for (const account of accounts) {
    if (!account.id.trim()) throw new Error('capital account id is required');
    if (byId.has(account.id)) throw new Error(`duplicate capital account: ${account.id}`);
    assertMicros(account.productionMicros, `${account.id}.productionMicros`);
    assertMicros(account.explorationMicros, `${account.id}.explorationMicros`);
    assertMicros(account.reserveMicros, `${account.id}.reserveMicros`);
    byId.set(account.id, account);
  }
  for (const account of accounts) {
    if (account.parentId !== null && !byId.has(account.parentId)) throw new Error(`unknown parent ${account.parentId} for ${account.id}`);
    const seen = new Set<string>([account.id]);
    let cursor = account.parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error(`capital hierarchy cycle involving ${account.id}`);
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
}

export function createCapitalState(accounts: readonly CapitalAccount[]): CapitalState {
  validateCapitalHierarchy(accounts);
  return {
    accounts: accounts.map((account) => ({ ...account })),
    consumedByAccount: Object.fromEntries(accounts.map((account) => [account.id, { ...ZERO_CONSUMED }])),
  };
}

export function totalAvailableCapital(state: CapitalState): number {
  return state.accounts.reduce(
    (sum, account) => sum + account.productionMicros + account.explorationMicros + account.reserveMicros,
    0,
  );
}

function cloneState(state: CapitalState): CapitalState {
  return {
    accounts: state.accounts.map((account) => ({ ...account })),
    consumedByAccount: Object.fromEntries(
      Object.entries(state.consumedByAccount).map(([id, consumed]) => [id, { ...consumed }]),
    ),
  };
}

/**
 * Apply one explicit internal-capital transaction. Buckets never cross-subsidize
 * implicitly: an exhausted production bucket cannot silently consume protected
 * exploration or reserve capital.
 */
export function applyCapitalTransaction(state: CapitalState, transaction: CapitalTransaction): CapitalState {
  validateCapitalHierarchy(state.accounts);
  assertMicros(transaction.amountMicros, 'transaction.amountMicros');
  if (transaction.amountMicros === 0) return cloneState(state);
  if (!transaction.reason.trim()) throw new Error('capital transaction reason is required');

  const next = cloneState(state);
  const field = bucketField(transaction.bucket);
  const byId = new Map(next.accounts.map((account) => [account.id, account]));

  if (transaction.kind === 'transfer') {
    if (transaction.from === transaction.to) throw new Error('capital transfer requires different accounts');
    const from = byId.get(transaction.from);
    const to = byId.get(transaction.to);
    if (!from || !to) throw new Error('capital transfer references an unknown account');
    if (from[field] < transaction.amountMicros) throw new Error(`insufficient ${transaction.bucket} capital in ${from.id}`);
    from[field] -= transaction.amountMicros;
    to[field] += transaction.amountMicros;
    if (!Number.isSafeInteger(to[field])) throw new Error('capital transfer exceeds safe integer range');
    return next;
  }

  const account = byId.get(transaction.account);
  if (!account) throw new Error(`unknown capital account: ${transaction.account}`);
  if (account[field] < transaction.amountMicros) throw new Error(`insufficient ${transaction.bucket} capital in ${account.id}`);
  account[field] -= transaction.amountMicros;
  const consumed = next.consumedByAccount[account.id] ?? { ...ZERO_CONSUMED };
  const updatedConsumed = consumed[field] + transaction.amountMicros;
  if (!Number.isSafeInteger(updatedConsumed)) throw new Error('consumed capital exceeds safe integer range');
  consumed[field] = updatedConsumed;
  next.consumedByAccount[account.id] = consumed;
  return next;
}

/**
 * Outcome value is intentionally a separate posting type. It is not accepted by
 * applyCapitalTransaction and therefore cannot erase historical spend by being
 * netted into a budget balance.
 */
export interface OutcomeValuePosting {
  accountId: string;
  valueMicros: number | null;
  evidenceBasis: string;
  observedAtMs: number;
}
