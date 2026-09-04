import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { evidence, type Evidence } from '../src/epistemic/evidence.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';

const base = {
  id: 'claim:negative:1',
  proposition: { predicate: 'ops.no_incident', value: { project: 'atlas' } },
  subject: 'atlas',
  scope: { constraints: [{ key: 'project', value: 'atlas' }] },
  grain: { dimensions: ['project', 'period'] },
  time: { asOf: '2026-09-03T00:00:00.000Z' },
  epistemic: 'supported',
  profile: { epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'established', coverage: 'complete', measurement: 'validated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'sufficient' },
  measurementModelRef: 'model:ops-v1',
  evidenceIds: ['evidence:scan'],
  derivationRule: 'negative-claim.v1',
  derivationVersion: 1,
  causalStatus: 'none',
  issuedAt: '2026-09-03T00:00:00.000Z',
  schemaVersion: 1,
} satisfies ClaimInput;

const negativePeriod = interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
const negativeScope = scope({ organization: 'acme', project: 'atlas' });

function completenessEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return evidence({
    id: 'evidence:complete:incidents',
    evidenceType: 'ops.incident-feed',
    sourceIdentity: 'pager:atlas',
    sourceClass: 'operator_export',
    payload: { rows: [] },
    scope: negativeScope,
    grain: grain(['project', 'period']),
    occurredAt: '2026-09-01T00:00:00.000Z',
    validTime: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    observedAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-01T00:00:00.000Z',
    assertedAt: '2026-09-01T00:00:00.000Z',
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'pinned',
    completeness: {
      status: 'complete',
      method: 'operator_export_complete',
      coveredEventTypes: ['linked_incident'],
      coveredScope: scope({ organization: 'acme' }),
      coveredTime: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
    ...overrides,
  });
}

function negativeClaim(input: Partial<ClaimInput> = {}) {
  return claim({
    ...base,
    id: 'claim:negative:semantic',
    scope: negativeScope,
    time: { validTime: negativePeriod, asOf: '2026-09-01T00:00:00.000Z' },
    evidenceIds: ['evidence:complete:incidents'],
    negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: ['evidence:complete:incidents'] },
    ...input,
  });
}

test('negative claims require a typed completeness witness contract', () => {
  assert.throws(() => claim({ ...base, negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: [] } } as ClaimInput), /completenessWitnessIds must contain at least one entry/);
  const item = claim({ ...base, evidenceIds: ['cw:incidents'], negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: ['cw:incidents'] } } as ClaimInput);
  assert.deepEqual(item.negativeClaim, { eventType: 'linked_incident', completenessWitnessIds: ['cw:incidents'] });
});

test('positive claims remain valid without the opt-in contract', () => {
  assert.equal(claim(base).negativeClaim, undefined);
});

test('append boundary refuses a negative claim whose witness ID is not cited', () => {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  const item = claim({ ...base, negativeClaim: { eventType: 'linked_incident', completenessWitnessIds: ['cw:missing'] } });
  assert.throws(() => ledger.appendClaim(item), /must be cited in evidenceIds/);
});

test('append boundary refuses an as-of-only negative claim without a declared absence period', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EpistemicLedger(db);
  try {
    const source = completenessEvidence();
    ledger.appendEvidence(source);
    const item = negativeClaim({ time: { asOf: '2026-09-01T00:00:00.000Z' } });
    assert.throws(() => ledger.appendClaim(item), /negative claim.*validTime/i);
  } finally {
    db.close();
  }
});

test('append boundary refuses incomplete or semantically mismatched completeness evidence', () => {
  const cases = [
    { label: 'partial', evidence: completenessEvidence({ completeness: { ...completenessEvidence().completeness, status: 'partial' } }), pattern: /coverage complete|declare complete coverage/i },
    { label: 'wrong event', evidence: completenessEvidence({ completeness: { ...completenessEvidence().completeness, coveredEventTypes: ['deployment'] } }), pattern: /event type/i },
    { label: 'narrow scope', evidence: completenessEvidence({ completeness: { ...completenessEvidence().completeness, coveredScope: scope({ organization: 'acme', project: 'other' }) } }), pattern: /scope/i },
    { label: 'short period', evidence: completenessEvidence({ completeness: { ...completenessEvidence().completeness, coveredTime: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z') } }), pattern: /period|time/i },
  ] as const;

  for (const candidate of cases) {
    const db = new DatabaseSync(':memory:');
    const ledger = new EpistemicLedger(db);
    try {
      ledger.appendEvidence(candidate.evidence);
      assert.throws(() => ledger.appendClaim(negativeClaim({
        id: `claim:negative:${candidate.label.replaceAll(' ', '-')}`,
      })), candidate.pattern, candidate.label);
    } finally {
      db.close();
    }
  }
});

test('a broader complete completeness witness supports the negative claim and exact replay is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EpistemicLedger(db);
  try {
    ledger.appendEvidence(completenessEvidence());
    const item = negativeClaim();
    assert.equal(ledger.appendClaim(item), 'inserted');
    assert.equal(ledger.appendClaim(item), 'duplicate');
    assert.deepEqual(ledger.readClaim(item.id)?.negativeClaim, item.negativeClaim);
  } finally {
    db.close();
  }
});
