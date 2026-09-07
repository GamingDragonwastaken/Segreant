import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import { measurementModel, type MeasurementModel, type MeasurementValidation } from '../src/measurement/model.ts';
import { measurementRegistry } from '../src/measurement/registry.ts';
import {
  surrogateBridge,
  surrogateBridgeRegistry,
  bridgeCeiling,
  assessBridgedMeasurementBacking,
  assertBridgedMeasurementBacking,
  type SurrogateBridge,
  type SurrogateBridgeInput,
  type SurrogateDirection,
} from '../src/measurement/surrogate.ts';
import { ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL } from '../src/git/quality.ts';

/**
 * The surrogate under test throughout: reviewer acceptance rate standing in for
 * code quality. It is the shape of the reference `src/causal/epistemic.ts`
 * actually writes onto two `measurement: 'proxy_validated'` claims.
 */
function surrogateModel(overrides: Partial<MeasurementModel> = {}): MeasurementModel {
  return {
    ...measurementModel({
      id: 'acceptance-rate-v1',
      targetConstruct: 'code_quality',
      measurand: 'share of AI-authored diffs accepted by a reviewer',
      observable: 'reviewer acceptance events',
      procedure: 'accepted diffs divided by submitted diffs in the study window',
      scope: scope({ ledger: 'fiscus-causal' }),
      population: 'decisions in the declared causal study',
      validation: 'validated',
      calibration: null,
      uncertainty: { kind: 'none', description: 'exact event counts' },
    }),
    validation: 'proxy_validated',
    ...overrides,
  };
}

/** An independent, direct measurement of the target construct. */
function referenceModel(overrides: Partial<MeasurementModel> = {}): MeasurementModel {
  return {
    ...measurementModel({
      id: 'defect-audit-v1',
      targetConstruct: 'code_quality',
      measurand: 'defects found by blind expert audit per thousand lines',
      observable: 'audit findings',
      procedure: 'two independent auditors, blind to authorship, adjudicated',
      scope: scope({ ledger: 'fiscus-causal' }),
      population: 'a sampled subset of the declared causal study',
      validation: 'validated',
      calibration: 'inter-rater agreement recorded per audit round',
      uncertainty: { kind: 'bounded', description: 'audit sampling', bound: 'the audited subset only' },
    }),
    ...overrides,
  };
}

function bridge(overrides: Partial<SurrogateBridgeInput> = {}): SurrogateBridge {
  return surrogateBridge({
    id: 'acceptance-rate-stands-for-quality-v1',
    surrogateModelRef: 'acceptance-rate-v1',
    targetConstruct: 'code_quality',
    surrogateConstruct: 'reviewer_acceptance',
    direction: 'increases_with_target',
    basis: {
      kind: 'empirical_association',
      argument: 'acceptance rate tracked audited defect density across the sampled subset',
      referenceMeasurementRef: 'defect-audit-v1',
      sample: '412 adjudicated diffs, 2026-Q1, two auditors',
    },
    failureModes: [
      'reviewers who know a diff is AI-authored accept differently',
      'acceptance saturates once diffs are small enough to skim',
    ],
    status: 'supported',
    contest: null,
    ...overrides,
  });
}

function registries(models: readonly MeasurementModel[], bridges: readonly SurrogateBridge[]) {
  return { models: measurementRegistry(models), bridges: surrogateBridgeRegistry(bridges) };
}

// ---------------------------------------------------------------------------
// THE COUNTEREXAMPLE. Measured against the pre-fix tree, a `proxy_validated`
// surrogate cited for its target construct was admissible with zero reasons and
// no field anywhere stating what had been checked, against what, or how
// strongly. `proxy_validated` means "this surrogate's relationship to the
// construct has been checked"; it was granted because the string was written.
// ---------------------------------------------------------------------------

test('a proxy_validated surrogate that names no bridge is not a checked surrogate', () => {
  const { models, bridges } = registries([surrogateModel()], []);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: null,
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.equal(backing.degraded, true);
  assert.equal(backing.bridge, null);
  assert.ok(backing.reasons.some((reason) => /names no surrogate bridge/.test(reason)));
});

test('a bridge reference that resolves to nothing is not a bridge', () => {
  const { models, bridges } = registries([surrogateModel(), referenceModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'no-such-bridge',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.bridge, null);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(backing.reasons.some((reason) => /resolves to no registered surrogate bridge/.test(reason)));
});

// ---------------------------------------------------------------------------
// The class, not the instance: every way a declared bridge can fail to license
// the reading the claim wants.
// ---------------------------------------------------------------------------

test('a bridge declared for another model does not bridge this one', () => {
  const other = bridge({ id: 'other-bridge', surrogateModelRef: 'some-other-model' });
  const { models, bridges } = registries([surrogateModel(), referenceModel()], [other]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'other-bridge',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /declared for measurement model/.test(reason)));
});

test('a bridge to another construct does not bridge to this one', () => {
  const elsewhere = bridge({ id: 'elsewhere', targetConstruct: 'developer_productivity' });
  const { models, bridges } = registries([surrogateModel(), referenceModel()], [elsewhere]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'elsewhere',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /bridge targets/.test(reason)));
});

test('an asserted bridge is an argument, not a check', () => {
  const asserted = bridge({
    id: 'asserted-bridge',
    basis: { kind: 'asserted', argument: 'reviewers accept good code; that is what review is for' },
  });
  assert.equal(bridgeCeiling(asserted), 'proxy_unvalidated');

  const { models, bridges } = registries([surrogateModel(), referenceModel()], [asserted]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'asserted-bridge',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.equal(backing.degraded, true);
  assert.ok(backing.reasons.some((reason) => /supports at most proxy_unvalidated/.test(reason)));
});

// Pre-registration defends against choosing the metric after seeing the data.
// It says nothing about whether the metric measures the construct. This is the
// exact basis `src/causal/epistemic.ts` offers for its two `proxy_validated`
// claims, so the rung it licenses is the load-bearing answer of this packet.
test('pre-registering a surrogate fixes it in advance; it does not validate it', () => {
  const preregistered = bridge({
    id: 'preregistered-bridge',
    basis: {
      kind: 'preregistered',
      argument: 'the metric, its finite range and its evidence class were fixed before collection',
      registrationRef: 'protocol-hash-abc',
    },
  });
  assert.equal(bridgeCeiling(preregistered), 'proxy_unvalidated');

  const { models, bridges } = registries([surrogateModel(), referenceModel()], [preregistered]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'preregistered-bridge',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(backing.reasons.some((reason) => /supports at most proxy_unvalidated/.test(reason)));
});

test('a contested or unsupported bridge degrades the claim rather than carrying it', () => {
  for (const status of ['contested', 'unsupported'] as const) {
    const shaky = bridge({
      id: `bridge-${status}`,
      status,
      contest: 'the 2026-Q2 audit round did not reproduce the association',
    });
    assert.equal(bridgeCeiling(shaky), 'proxy_unvalidated');

    const { models, bridges } = registries([surrogateModel(), referenceModel()], [shaky]);
    const backing = assessBridgedMeasurementBacking(models, bridges, {
      measurementModelRef: 'acceptance-rate-v1',
      surrogateBridgeRef: `bridge-${status}`,
      requiredConstruct: 'code_quality',
      assertedValidation: 'proxy_validated',
    });

    assert.equal(backing.admissible, false, status);
    assert.equal(backing.earnedValidation, 'proxy_unvalidated', status);
    assert.equal(backing.degraded, true, status);
    assert.ok(backing.reasons.some((reason) => new RegExp(`bridge is ${status}`).test(reason)), status);
  }
});

test('an empirical bridge whose reference measurement resolves to nothing is unvalidated', () => {
  const { models, bridges } = registries([surrogateModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(backing.reasons.some((reason) => /reference measurement defect-audit-v1 resolves to no registered measurement model/.test(reason)));
});

test('a surrogate validated against another surrogate is still unvalidated', () => {
  const chained = referenceModel({ validation: 'proxy_validated' });
  const { models, bridges } = registries([surrogateModel(), chained], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(backing.reasons.some((reason) => /is itself proxy_validated/.test(reason)));
});

test('a reference measurement of a different construct validates nothing about this one', () => {
  const wrong = referenceModel({ targetConstruct: 'artifact_persistence' });
  const { models, bridges } = registries([surrogateModel(), wrong], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /reference measurement defect-audit-v1 targets artifact_persistence/.test(reason)));
});

test('a bridge whose direction is unknown licenses no reading of a movement', () => {
  const undirected = bridge({ id: 'undirected', direction: 'unknown_direction' });
  assert.equal(bridgeCeiling(undirected), 'proxy_unvalidated');

  const { models, bridges } = registries([surrogateModel(), referenceModel()], [undirected]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'undirected',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });
  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
});

// ---------------------------------------------------------------------------
// Degrade, never upgrade. A bridge is a ceiling on what a surrogate may be read
// as; it is never a promotion.
// ---------------------------------------------------------------------------

test('a bridge never lifts a model above the strength its own author declared', () => {
  const own = surrogateModel({ validation: 'proxy_unvalidated' });
  const { models, bridges } = registries([own, referenceModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.equal(backing.degraded, true);
});

test('no bridge reaches validated, because a surrogate never becomes the construct', () => {
  for (const kind of ['asserted', 'preregistered', 'empirical_association'] as const) {
    for (const status of ['supported', 'contested', 'unsupported'] as const) {
      for (const direction of ['increases_with_target', 'decreases_with_target', 'unknown_direction'] as SurrogateDirection[]) {
        const basis: SurrogateBridgeInput['basis'] = kind === 'asserted'
          ? { kind, argument: 'a' }
          : kind === 'preregistered'
            ? { kind, argument: 'a', registrationRef: 'r' }
            : { kind, argument: 'a', referenceMeasurementRef: 'defect-audit-v1', sample: 's' };
        const candidate = bridge({
          id: `${kind}-${status}-${direction}`,
          basis,
          status,
          contest: status === 'supported' ? null : 'recorded contest',
          direction,
        });
        assert.notEqual(bridgeCeiling(candidate), 'validated', candidate.id);
      }
    }
  }

  const { models, bridges } = registries([surrogateModel(), referenceModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'validated',
  });
  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_validated');
});

test('a model declared validated does not stand on a surrogate bridge', () => {
  const direct = surrogateModel({ validation: 'validated' });
  const { models, bridges } = registries([direct, referenceModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'validated',
  });

  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /declared validated/.test(reason)));
});

// Fiscus's one real declared model, and the reading it must never be given.
test('the line-retention proxy cannot be bridged into developer productivity', () => {
  const productivityBridge = bridge({
    id: 'lines-stand-for-productivity',
    surrogateModelRef: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id,
    targetConstruct: 'developer_productivity',
    surrogateConstruct: 'artifact_persistence',
    basis: {
      kind: 'empirical_association',
      argument: 'retained lines tracked delivery in one team',
      referenceMeasurementRef: 'defect-audit-v1',
      sample: 'one team, one quarter',
    },
  });
  const { models, bridges } = registries(
    [ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL, referenceModel({ targetConstruct: 'developer_productivity' })],
    [productivityBridge],
  );

  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL.id,
    surrogateBridgeRef: 'lines-stand-for-productivity',
    requiredConstruct: 'developer_productivity',
    assertedValidation: 'proxy_validated',
  });

  assert.equal(backing.admissible, false);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.ok(backing.reasons.some((reason) => /construct mismatch/.test(reason)));
});

// ---------------------------------------------------------------------------
// The declaration itself has to be a record, not a gesture.
// ---------------------------------------------------------------------------

test('a bridge with no stated failure modes has not been examined', () => {
  assert.throws(() => bridge({ id: 'no-failure-modes', failureModes: [] }), /at least one known failure mode/);
  assert.throws(() => bridge({ id: 'blank-failure-mode', failureModes: ['  '] }), /failure mode must be non-empty/);
});

test('a bridge status that is not supported must say what contests it', () => {
  assert.throws(
    () => bridge({ id: 'silent-contest', status: 'contested', contest: null }),
    /contested surrogate bridge must record what contests it/,
  );
  assert.throws(
    () => bridge({ id: 'both', status: 'supported', contest: 'someone objected' }),
    /supported surrogate bridge cannot also record a contest/,
  );
});

test('a bridge from a construct to itself is not a bridge', () => {
  assert.throws(() => bridge({ id: 'self', surrogateConstruct: 'code_quality' }), /surrogate construct and target construct must differ/);
});

test('a surrogate cannot be its own reference measurement', () => {
  assert.throws(
    () => bridge({
      id: 'circular',
      basis: { kind: 'empirical_association', argument: 'a', referenceMeasurementRef: 'acceptance-rate-v1', sample: 's' },
    }),
    /cannot be validated against itself/,
  );
});

test('an unrecognized direction, basis kind or status is refused at declaration', () => {
  assert.throws(() => bridge({ id: 'bad-direction', direction: 'sort_of_up' as SurrogateDirection }), /invalid surrogate bridge direction/);
  assert.throws(
    () => bridge({ id: 'bad-basis', basis: { kind: 'vibes', argument: 'a' } as unknown as SurrogateBridgeInput['basis'] }),
    /invalid surrogate bridge basis kind/,
  );
  assert.throws(
    () => bridge({ id: 'bad-status', status: 'fine' as SurrogateBridge['status'], contest: null }),
    /invalid surrogate bridge status/,
  );
});

test('the bridge registry refuses two different bridges sharing one reference', () => {
  assert.throws(
    () => surrogateBridgeRegistry([bridge(), bridge({ direction: 'decreases_with_target' })]),
    /conflicting surrogate bridges registered under id/,
  );
  assert.doesNotThrow(() => surrogateBridgeRegistry([bridge(), bridge()]));
});

test('the bridge registry re-validates entries that never passed through the constructor', () => {
  assert.throws(
    () => surrogateBridgeRegistry([{ ...bridge(), failureModes: [] } as unknown as SurrogateBridge]),
    /at least one known failure mode/,
  );
  assert.deepEqual(surrogateBridgeRegistry([bridge()]).ids, ['acceptance-rate-stands-for-quality-v1']);
});

// ---------------------------------------------------------------------------
// Guard rails. A gate that refused everything would satisfy every test above
// while making the surface useless, and would be its own epistemic failure:
// withholding a figure that was in fact earned.
// ---------------------------------------------------------------------------

test('a supported empirical bridge to a registered direct measurement carries a validated surrogate', () => {
  const { models, bridges } = registries([surrogateModel(), referenceModel()], [bridge()]);
  const request = {
    measurementModelRef: 'acceptance-rate-v1',
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_validated' as MeasurementValidation,
  };

  const backing = assessBridgedMeasurementBacking(models, bridges, request);
  assert.equal(backing.admissible, true);
  assert.deepEqual(backing.reasons, []);
  assert.equal(backing.earnedValidation, 'proxy_validated');
  assert.equal(backing.degraded, false);
  assert.equal(backing.model?.id, 'acceptance-rate-v1');
  assert.equal(backing.bridge?.id, 'acceptance-rate-stands-for-quality-v1');

  const asserted = assertBridgedMeasurementBacking(models, bridges, request);
  assert.equal(asserted.model?.id, 'acceptance-rate-v1');
  assert.equal(asserted.bridge?.id, 'acceptance-rate-stands-for-quality-v1');
});

test('a directly validated model needs no bridge and is not penalised for lacking one', () => {
  const { models, bridges } = registries([referenceModel()], []);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: 'defect-audit-v1',
    surrogateBridgeRef: null,
    requiredConstruct: 'code_quality',
    assertedValidation: 'validated',
  });

  assert.equal(backing.admissible, true);
  assert.deepEqual(backing.reasons, []);
  assert.equal(backing.earnedValidation, 'validated');
  assert.equal(backing.degraded, false);
  assert.equal(backing.bridge, null);
});

test('an honest proxy_unvalidated boundary still needs neither model nor bridge', () => {
  const { models, bridges } = registries([], []);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: null,
    surrogateBridgeRef: null,
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_unvalidated',
  });

  assert.equal(backing.admissible, true);
  assert.deepEqual(backing.reasons, []);
  assert.equal(backing.earnedValidation, 'proxy_unvalidated');
  assert.equal(backing.degraded, false);
});

test('a bridge cited without a measurement model bridges from nothing', () => {
  const { models, bridges } = registries([surrogateModel(), referenceModel()], [bridge()]);
  const backing = assessBridgedMeasurementBacking(models, bridges, {
    measurementModelRef: null,
    surrogateBridgeRef: 'acceptance-rate-stands-for-quality-v1',
    requiredConstruct: 'code_quality',
    assertedValidation: 'proxy_unvalidated',
  });

  assert.equal(backing.admissible, false);
  assert.ok(backing.reasons.some((reason) => /cited without a measurement model/.test(reason)));
});

test('the refusing form names every reason it refused for', () => {
  const { models, bridges } = registries([surrogateModel()], []);
  assert.throws(
    () => assertBridgedMeasurementBacking(models, bridges, {
      measurementModelRef: 'acceptance-rate-v1',
      surrogateBridgeRef: null,
      requiredConstruct: 'code_quality',
      assertedValidation: 'proxy_validated',
    }),
    /inadmissible bridged measurement backing: .*names no surrogate bridge/,
  );
});
