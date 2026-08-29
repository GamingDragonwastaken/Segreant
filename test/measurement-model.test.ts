import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';
import {
  measurementModel,
  assessMeasurementFitness,
} from '../src/measurement/model.ts';

test('measurement model makes construct, measurand, observable, procedure, scope, population, uncertainty and validity explicit', () => {
  const model = measurementModel({
    id: 'resolution-time-v1',
    targetConstruct: 'task_resolution_time',
    measurand: 'elapsed minutes from ticket open to resolved status',
    observable: 'ticket timestamps',
    procedure: 'difference resolved_at - opened_at',
    scope: scope({ organization: 'acme' }),
    population: 'support tickets handled by the AI-assisted queue',
    validation: 'validated',
    calibration: 'ticket-system clock synchronization checked daily',
    uncertainty: { kind: 'bounded', description: 'timestamp rounding', bound: '1 minute' },
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  });

  assert.equal(model.targetConstruct, 'task_resolution_time');
  assert.equal(model.validation, 'validated');
  assert.equal(model.uncertainty.kind, 'bounded');
});

test('statistical precision cannot upgrade an unvalidated proxy construct', () => {
  const proxy = measurementModel({
    id: 'lines-v1',
    targetConstruct: 'software_quality',
    measurand: 'lines surviving blame',
    observable: 'git blame line identity',
    procedure: 'count added lines still blamed to source commit',
    scope: scope({ organization: 'acme' }),
    population: 'commits',
    validation: 'proxy_unvalidated',
    calibration: null,
    uncertainty: { kind: 'statistical', description: 'sampling error', standardError: 0.000001 },
  });

  const fitness = assessMeasurementFitness(proxy, { requiredConstruct: 'software_quality' });
  assert.equal(fitness.fitForConstructClaim, false);
  assert.ok(fitness.reasons.some((reason) => /unvalidated proxy/.test(reason)));
});

test('construct mismatch remains unfit even for a validated measurement procedure', () => {
  const validCost = measurementModel({
    id: 'cost-v1',
    targetConstruct: 'provider_billed_cost',
    measurand: 'invoice line amount',
    observable: 'provider invoice export',
    procedure: 'parse provider decimal amount',
    scope: scope({ organization: 'acme' }),
    population: 'provider invoice lines',
    validation: 'validated',
    calibration: null,
    uncertainty: { kind: 'none', description: 'provider-stated decimal amount' },
  });

  const fitness = assessMeasurementFitness(validCost, { requiredConstruct: 'developer_productivity' });
  assert.equal(fitness.fitForConstructClaim, false);
  assert.ok(fitness.reasons.some((reason) => /construct mismatch/.test(reason)));
});

test('validated direct measurement of the requested construct can be construct-fit without claiming broader decision fitness', () => {
  const model = measurementModel({
    id: 'invoice-v1',
    targetConstruct: 'provider_billed_cost',
    measurand: 'invoice line amount',
    observable: 'authenticated provider invoice export',
    procedure: 'exact decimal parse with provider account and period identity',
    scope: scope({ organization: 'acme' }),
    population: 'provider invoice lines',
    validation: 'validated',
    calibration: null,
    uncertainty: { kind: 'none', description: 'provider-stated amount' },
  });
  assert.deepEqual(assessMeasurementFitness(model, { requiredConstruct: 'provider_billed_cost' }), {
    fitForConstructClaim: true,
    reasons: [],
  });
});

test('measurement models reject empty identity/construct fields and malformed statistical uncertainty', () => {
  assert.throws(() => measurementModel({
    id: '', targetConstruct: 'x', measurand: 'm', observable: 'o', procedure: 'p',
    scope: scope({}), population: 'all', validation: 'validated', calibration: null,
    uncertainty: { kind: 'none', description: 'none' },
  }), /id must be non-empty/);

  assert.throws(() => measurementModel({
    id: 'x', targetConstruct: 'x', measurand: 'm', observable: 'o', procedure: 'p',
    scope: scope({}), population: 'all', validation: 'validated', calibration: null,
    uncertainty: { kind: 'statistical', description: 'bad', standardError: -1 },
  }), /standard error/);
});
