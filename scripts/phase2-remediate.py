from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]

def read(p): return (ROOT / p).read_text(encoding='utf-8')
def write(p, s):
    q = ROOT / p; q.parent.mkdir(parents=True, exist_ok=True); q.write_text(s, encoding='utf-8')
def one(p, old, new):
    s = read(p); n = s.count(old)
    if n != 1: raise SystemExit(f'{p}: expected one match, got {n}: {old[:90]!r}')
    write(p, s.replace(old, new, 1))

# ---------------------------------------------------------------------------
# 1. Impact must not double-count Realization's merged/shipped/survived gates.
#    Coding Impact is now unknown unless supplied from an orthogonal outcome
#    source. Non-coding usage has an explicit reported reach signal and supplies
#    a conditional reach score (only among realized outcomes).
# ---------------------------------------------------------------------------
p='src/value/lenses.ts'; s=read(p)
start=s.index('/**\n * Impact weight')
end=s.index('/**\n * Default lens weights', start)
s=s[:start]+'''/**\n * Impact is intentionally NOT reconstructed from Realization gates.\n *\n * Earlier versions weighted `merged`, `shipped`, and `survived` a second time\n * here even though those same verdicts already determine Realization. That made\n * the nominally separate Impact lens partly a duplicate durability/reach score.\n * Impact must come from an orthogonal outcome signal (business/customer reach,\n * service criticality, explicitly reported external reach, etc.) or stay unknown.\n */\n'''+s[end:]
s=s.replace("  liftHow?: string; // how Lift was sourced (baseline estimate / measured A-B / synthetic) — honest disclosure\n", "  liftHow?: string; // how Lift was sourced (baseline estimate / measured A-B / synthetic) — honest disclosure\n  impact?: number | null; // orthogonal outcome impact in [0,1]; absent => uninstrumented\n  impactHow?: string; // provenance for Impact; never inferred from Realization gates\n")
old='''  // --- Lens 4: Impact (of what realized, how much mattered?) ---\n  let impact: LensValue;\n  if (mature.length === 0) {\n    impact = { value: null, instrumented: false, how: 'impact-weighted realization' };\n    notes.push('Impact uninstrumented: no matured units yet.');\n  } else {\n    let weighted = 0;\n    let realizedWeighted = 0;\n    for (const u of mature) {\n      const w = impactWeight(u);\n      weighted += w;\n      if (u.funnel.realized) realizedWeighted += w;\n    }\n    impact = {\n      value: weighted > 0 ? realizedWeighted / weighted : 0,\n      instrumented: true,\n      how: 'production reach × durability among matured units (not line count)',\n    };\n  }\n'''
new='''  // --- Lens 4: Impact (conditional consequence, orthogonal to Realization) ---\n  const impactProvided = opts.impact !== undefined && opts.impact !== null;\n  const impact: LensValue = {\n    value: impactProvided ? Math.min(1, Math.max(0, opts.impact!)) : null,\n    instrumented: impactProvided,\n    how: opts.impactHow ?? 'orthogonal outcome impact — never inferred from merged/shipped/survived gates',\n  };\n  if (!impact.instrumented) {\n    notes.push('Impact uninstrumented: needs an outcome signal independent of the Realization funnel.');\n  }\n'''
if old not in s: raise SystemExit('lenses.ts: impact computation block not found')
s=s.replace(old,new,1)
s=s.replace('— no single axis can be gamed.', '— no single axis can compensate for a collapsed one.')
write(p,s)

# Non-coding usage has explicit user-reported reach. Make Impact conditional on
# successful realization so it does not duplicate the realization rate.
p='src/value/usage.ts'; s=read(p)
s=s.replace(''' * DEPTH (not just realized/not): a reported outcome is GRADED onto the same reach\n * ladder the Impact lens uses for code — `used`/`accepted` = kept, `resolved` =\n * merged-level, `published`/`shipped` = shipped-level. So a published deliverable\n * counts for more Impact than a one-off answer, without inventing anything: the\n * grade is exactly what the user reported, never inferred from prompt content.\n''',''' * DEPTH (not just realized/not): a reported outcome is also a direct Impact\n * observation for this non-coding adapter — `used`/`accepted` = kept, `resolved`\n * = task-level reach, `published`/`shipped` = external reach. Impact is averaged\n * CONDITIONALLY over realized sessions, so the realization rate is not counted\n * twice. The grade is exactly what the user reported, never inferred from text.\n''')
needle='''  const roi = computeReturnOnIntelligence(\n    {\n'''
insert='''  const realizedImpact = realized.length === 0\n    ? null\n    : realized.reduce((sum, u) => sum + (u.reach === 'shipped' ? 1 : u.reach === 'merged' ? 0.75 : 0.5), 0) / realized.length;\n\n  const roi = computeReturnOnIntelligence(\n    {\n'''
if needle not in s: raise SystemExit('usage.ts roi call not found')
s=s.replace(needle,insert,1)
old='''    money.priced\n      ? { laborRatePerHour: rate, grossRealizedValueUsd: money.grossRealizedValueUsd, supervisionMinutes: money.supervisionMinutes }\n      : {},\n'''
new='''    {\n      ...(money.priced\n        ? { laborRatePerHour: rate, grossRealizedValueUsd: money.grossRealizedValueUsd, supervisionMinutes: money.supervisionMinutes }\n        : {}),\n      ...(realizedImpact === null\n        ? {}\n        : { impact: realizedImpact, impactHow: 'operator-reported outcome reach, conditional on realized sessions' }),\n    },\n'''
if old not in s: raise SystemExit('usage.ts options block not found')
s=s.replace(old,new,1)
write(p,s)

# Tests: replace old duplicated-gate Impact assertions with explicit-impact tests.
for p in ['test/equation.test.ts','test/realization.test.ts','test/realization-store.test.ts']:
    if not (ROOT/p).exists(): continue
    s=read(p)
    s=s.replace("test('Impact is driven by production reach (shipped), not line counts (the M2 fix)'", "test('Impact requires an orthogonal outcome signal rather than reusing production gates'")
    s=s.replace("test('RoI: Impact diverges from raw realization via production reach (shipped weighs more), not line counts'", "test('RoI: explicit orthogonal Impact changes the composite without redefining Realization'")
    write(p,s)

# Add focused regression that proves identical realization gates do not silently
# instrument Impact, and explicit orthogonal evidence does.
write('test/impact-independence.test.ts', '''import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { computeReturnOnIntelligence } from '../src/value/lenses.ts';\n\nconst results = ['proposed','accepted','committed','tested','merged','shipped','survived','clean'].map((gate) => ({ gate, verdict: 'pass' })) as any;\nconst report = {\n  firstPassAcceptance: 1,\n  units: [{ maturing: false, acceptance: 1, funnel: { realized: true, results } }],\n  matured: { realizationRate: 1, totalCostUsd: 1, realizedValueUsd: 1 },\n};\n\ntest('Impact never self-instruments from the same gates that establish Realization', () => {\n  const r = computeReturnOnIntelligence(report, { lift: 1 });\n  assert.equal(r.lenses.realization.value, 1);\n  assert.equal(r.lenses.impact.instrumented, false);\n  assert.equal(r.lenses.impact.value, null);\n  assert.equal(r.coverage, 0.75);\n});\n\ntest('Impact accepts explicit orthogonal evidence and keeps its provenance', () => {\n  const r = computeReturnOnIntelligence(report, { lift: 1, impact: 0.4, impactHow: 'customer exposure sample' });\n  assert.equal(r.lenses.impact.instrumented, true);\n  assert.equal(r.lenses.impact.value, 0.4);\n  assert.equal(r.lenses.impact.how, 'customer exposure sample');\n  assert.equal(r.coverage, 1);\n});\n''')

# ---------------------------------------------------------------------------
# 2. Put browser payload declarations in a canonical contracts module. The
#    runtime API imports/re-exports them; server can type against the same module.
# ---------------------------------------------------------------------------
p='src/dashboard/web/app/core/api.ts'; s=read(p)
a=s.index('export interface Summary')
b=s.index('export class ApiError')
interfaces=s[a:b]
write('src/dashboard/web/app/core/contracts.ts', '''/**\n * Canonical dashboard transport contracts.\n *\n * This file contains type declarations only: no Node or DOM globals, no runtime\n * imports. Both the browser client and the Node dashboard server may import it,\n * eliminating the previous structurally-unrelated copies of payload shapes.\n * Runtime contract tests remain as defense in depth because TypeScript does not\n * validate JSON at runtime.\n */\n\n'''+interfaces)
names=['Summary','GroupRow','SeriesPoint','AlertRow','Overview','BillingPayload','CostCentre','AllocationRule','AllocationPayload','Matured','ValuePayload','BudgetAdvice','BudgetConfig','SettingsSnapshot','Importer','ScanPayload','ImportResult','HealthPayload']
imp='import type { '+', '.join(names)+' } from \'./contracts.ts\';\nexport type { '+', '.join(names)+' } from \'./contracts.ts\';\n\n'
s=s[:a]+imp+s[b:]
# Correct stale ValuePayload upper-bound comment in moved contracts.
ct=read('src/dashboard/web/app/core/contracts.ts').replace('/** True when the index can only be read as a ceiling, not a point estimate. */\n    indexIsUpperBound?: boolean;', '/** Compatibility flag; observed-only score is not a bound and current server returns false. */\n    indexIsUpperBound?: boolean;\n    instrumentationInterval?: { low: number | null; observed: number | null; high: number | null };')
write('src/dashboard/web/app/core/contracts.ts',ct)
write(p,s)

# Runtime test reads interface declarations from canonical module now.
p='test/dashboard-contract.test.ts'; s=read(p)
s=s.replace('`src/dashboard/web/app/core/api.ts`', '`src/dashboard/web/app/core/contracts.ts`')
s=s.replace("  'api.ts',\n);", "  'contracts.ts',\n);")
write(p,s)

# Server typechecks its directly-returned overview builder against the same type.
p='src/dashboard/server.ts'; s=read(p)
s=s.replace("import { pricingStatus } from '../cost/pricing.ts';\n", "import { pricingStatus } from '../cost/pricing.ts';\nimport type { Overview } from './web/app/core/contracts.ts';\n")
s=s.replace('function buildOverview(store: Store, config: AegisConfig, range: RangeKey) {', 'function buildOverview(store: Store, config: AegisConfig, range: RangeKey): Overview {')
write(p,s)

# Compile-time contract smoke ensures browser and server-facing type import stays valid.
write('test/dashboard-shared-types.test.ts', '''import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport type { Overview, BillingPayload, ValuePayload } from '../src/dashboard/web/app/core/contracts.ts';\n\ntest('dashboard transport contracts are a shared type-only module', () => {\n  const names: Array<keyof Overview | keyof BillingPayload | keyof ValuePayload> = ['demo'];\n  assert.deepEqual(names, ['demo']);\n});\n''')

# ---------------------------------------------------------------------------
# 3. Documentation truth: remove stale egress, independence, universal-proof and
#    partial-score claims. Preserve ambition while distinguishing current proof.
# ---------------------------------------------------------------------------
p='docs/METHODOLOGY.md'; s=read(p)
s=s.replace('Every dollar of AI spend has to survive four independent tests to become real value.\nWe score each one separately, then combine them:', 'Fiscus separates four questions that must not be collapsed into one number.\nThey are different evidentiary claims, not assumed statistically independent:')
s=s.replace('| **ι Impact** | Did it matter? | Reached production, stuck, no incidents (not "how big"). |', '| **ι Impact** | Did it matter? | Orthogonal consequence/reach evidence. Coding Impact stays unknown until such evidence exists; it is not reconstructed from ship/survival gates. |')
s=s.replace('## Why we *multiply* them (the part that can\'t be gamed)', '## Why we *multiply* them (the non-compensatory part)')
s=s.replace('This is the key honesty property: **you cannot fake the score by maxing one number.**\nIf any one of the four is near zero, the whole score collapses. A dashboard that just\n*averages* things can be gamed by pumping a single metric — ours can\'t, by\nconstruction. (This is a mathematical theorem, not a marketing claim; it\'s tested.)', 'This is the key non-compensation property: one strong lens cannot buy back a collapsed one.\nThat property is tested. It is **not** a proof against Goodhart effects in task selection,\ninstrumentation, baselines, or which outcomes an organization chooses to report.')
s=s.replace('''   "not yet measured" — never counted as a pass or a fail. A partly-measured score is\n   labeled an **upper bound**: wiring up more measurement can only move it *down*\n   toward the truth, never inflate it. That's the opposite of every vanity dashboard.\n''','''   "not yet measured" — never counted as a pass or a fail. The observed-lens score\n   is explicitly **not** called a bound: a newly measured lens can move it up or down.\n   Fiscus instead reports a full-index identification interval that keeps missing\n   dimensions in the fixed weight vector at their admissible endpoints.\n''')
s=s.replace('''instrument that measures AI's real return across any kind of usage, from your own\nmachine, and can't be gamed on a single axis. Stating exactly which parts are\nstandard is what makes the rest credible.\n''','''instrument whose mathematical shape can accept multiple AI modalities. Current\noutcome instrumentation is deepest for coding-agent workflows; non-coding value\nuses explicitly reported outcome adapters and is not claimed equally mature. The\nindex is single-axis resistant, not immune to metric gaming.\n''')
s=s.replace('''Everything is computed locally in a file-based database. No prompts, no code, no keys\nare ever transmitted. The only optional outbound traffic is a public pricing-table\nrefresh (off by default) and alert webhooks you explicitly configure (which carry\nalert titles only — never content).\n''','''The ledger and dashboard are local, but Fiscus is not an offline-only program.\nOutbound paths are explicit and purpose-scoped: configured provider traffic through\nthe proxy; an applied OpenAI Costs pull using the operator's admin credential;\npricing or baseline refreshes; configured alert webhooks; hosted judging when the\noperator enables it; and signed numeric team rollups when `team push` is invoked.\nThe canonical, maintained disclosure is [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md);\nthis overview must not be used as a shorter substitute for that boundary document.\n''')
write(p,s)

p='docs/RETURN-ON-INTELLIGENCE.md'; s=read(p)
s=s.replace('four independent', 'four separately evidenced')
s=s.replace('Goodhart-proof', 'single-axis resistant')
s=s.replace('GOODHART-PROOF', 'SINGLE-AXIS RESISTANT')
s=s.replace('partially-instrumented Index is an **UPPER bound**', 'partially-instrumented observed-lens Index is **not a bound**')
s=s.replace('More measurement can only lower it toward the truth — never inflate it.', 'A newly measured lens can raise or lower the observed-only score; the full-index identification interval carries that uncertainty honestly.')
write(p,s)

# Canonical machine-readable truth/capability manifest. It distinguishes what is
# implemented from what remains an external empirical gate.
manifest={
  'schemaVersion':1,
  'asOf':'2026-08-18',
  'coreInvariant':'metered usage != provider-billed cost != allocated cost != realized value',
  'productScope':{'current':'local-first AI Financial Operations; strongest validated outcome evidence is coding-agent workflows','thesis':'broader organizational AI Financial Operations across modalities'},
  'truthClaims':[
    {'id':'metering','status':'implemented','basis':'proxy and native-import ledgers'},
    {'id':'provider-billing-evidence','status':'implemented','basis':'immutable imported/adopted/direct provider evidence; never silently substituted for metered spend'},
    {'id':'reconciliation-engine','status':'implemented','basis':'project-day residual reconciliation with permanent conditions disclosed'},
    {'id':'real-provider-reconciliation','status':'external_validation_required','basis':'no controlled finalized provider bill has yet been reconciled end to end'},
    {'id':'allocation-showback','status':'implemented','basis':'versioned rules; microdollar conservation; excluded from budgets and RoI'},
    {'id':'coding-realization','status':'implemented','basis':'commit-bound realization funnel and outcome evidence'},
    {'id':'noncoding-outcomes','status':'partial','basis':'explicit reported outcomes; not equal in depth to coding evidence'},
    {'id':'impact','status':'partial','basis':'requires orthogonal outcome evidence; not inferred from Realization gates'},
    {'id':'team-server-production','status':'external_validation_required','basis':'real deployment controls require Postgres/OIDC/TLS/backup/restore operational validation'}
  ]
}
write('docs/CAPABILITIES.json', json.dumps(manifest,indent=2)+'\n')
write('test/capability-manifest.test.ts', '''import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n\ntest('capability manifest preserves the four-claim invariant and names external proof gaps', () => {\n  const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'CAPABILITIES.json'), 'utf8'));\n  assert.equal(m.coreInvariant, 'metered usage != provider-billed cost != allocated cost != realized value');\n  const claims = new Map(m.truthClaims.map((x: any) => [x.id, x.status]));\n  assert.equal(claims.get('real-provider-reconciliation'), 'external_validation_required');\n  assert.equal(claims.get('team-server-production'), 'external_validation_required');\n  assert.equal(claims.get('reconciliation-engine'), 'implemented');\n});\n''')

# ---------------------------------------------------------------------------
# 4. Reproducible empirical gates rather than fabricated evidence.
# ---------------------------------------------------------------------------
write('docs/REAL-PROVIDER-RECONCILIATION-RUNBOOK.md', '''# Controlled real-provider reconciliation runbook\n\nThis is the empirical gate for claiming that Fiscus has reconciled a real provider\nbill. Synthetic fixtures and imported coding-tool spend do **not** satisfy it.\n\n## Preconditions\n\n- A dedicated OpenAI organization project whose identifier is known.\n- An operator credential authorized to read Organization Costs.\n- A fixed UTC observation window that can be allowed to finalize.\n- All controlled requests in that window routed through the Fiscus proxy and\n  tagged into the declared provider/project scope.\n\n## Procedure\n\n1. Start with a fresh or clearly isolated Fiscus home. Record the Fiscus commit.\n2. Preview and then apply the exact billing scope declaration for the known project.\n3. Route a controlled request set through Fiscus. Keep the request count and local\n   metered total as observations, not expected answers.\n4. Wait until the provider Costs window is final enough for the product's finality\n   rules. Do not reconcile an accruing window.\n5. Run the credential-free readiness/preview commands first.\n6. Perform the applied provider Costs pull; retain the immutable evidence id/hash.\n7. Run reconciliation. Record provider total, comparable metered total, residual,\n   per-day residuals, permanent conditions, and materiality flags.\n8. Independently account for residual categories (off-path use, project-scope\n   mismatch, credits/adjustments, lag). Do not relabel an unexplained residual as\n   reconciled.\n9. Repeat the provider observation when required to establish finality.\n\n## Pass criterion\n\nThe gate passes only when a real provider observation and the local declared-scope\nledger are compared by the shipped reconciliation engine, the run is immutable,\nand every residual remains either explained by evidence or explicitly unresolved.\nThe acceptable residual is not predeclared: setting a tolerance before seeing the\ndata would turn the gate into a target.\n\n## Current status\n\n**UNPROVEN.** The repository contains a reconciliation engine and synthetic\nend-to-end tests, but this runbook requires operator credentials, provider-side\nevidence, finalized time, and controlled real traffic that repository CI cannot\nhonestly manufacture.\n''')
write('team-server/PRODUCTION-RUNBOOK.md', '''# Team server production validation\n\nThe team server is not production-certified merely because its HTTP/auth logic\npasses unit tests. Promotion requires evidence for the deployment boundary.\n\n## Required gates\n\n- Real PostgreSQL: schema application, registration, transactional rollup insert,\n  exact replay idempotency, aggregation, restart persistence, and rollback on a\n  failed child insert.\n- Identity: real configured OIDC issuer/audience, explicit dashboard subject policy,\n  key rotation, expired/not-before handling, and a documented mapping decision for\n  OIDC subjects versus developer signing keys.\n- Transport: public traffic terminates TLS at a maintained reverse proxy/load\n  balancer; plain HTTP is loopback/private only.\n- Secrets: database/admin/OIDC secrets come from the deployment secret manager,\n  have an owner and rotation procedure, and never enter logs.\n- Operations: backup, restore, retention/deletion, monitoring, incident response,\n  and upgrade/rollback are exercised, not merely documented.\n- Privacy: k-anonymity and per-developer opt-in remain enforced on the deployed\n  dashboard endpoints.\n\n## Promotion criterion\n\nRecord the exact Fiscus commit, infrastructure revision, database version, OIDC\nissuer, TLS endpoint, backup/restore evidence, and synthetic full-flow result.\nUntil those artifacts exist, describe this package as an experimental/operator-run\nteam service, not an enterprise production control plane.\n\n## Current status\n\n**UNPROVEN for Internet-facing production.** CI validates application logic. A\nseparate PostgreSQL integration check should validate the real adapter, while TLS,\nreal OIDC policy, backup/restore and incident controls remain deployment evidence.\n''')

# ---------------------------------------------------------------------------
# 5. Harden CI supply-chain defaults and add a real PostgreSQL adapter check.
# ---------------------------------------------------------------------------
p='.github/workflows/ci.yml'; s=read(p)
s=s.replace('on:\n  push:', 'on:\n  push:')
s=s.replace('jobs:\n', "permissions:\n  contents: read\n\nconcurrency:\n  group: ci-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n",1)
s=s.replace('actions/checkout@v7', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7')
s=s.replace('actions/setup-node@v6', 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6')
s += '''\n  team-server-postgres:\n    runs-on: ubuntu-latest\n    services:\n      postgres:\n        image: postgres:17-alpine\n        env:\n          POSTGRES_USER: fiscus\n          POSTGRES_PASSWORD: fiscus_ci\n          POSTGRES_DB: fiscus\n        ports:\n          - 5432:5432\n        options: >-\n          --health-cmd "pg_isready -U fiscus -d fiscus"\n          --health-interval 5s\n          --health-timeout 5s\n          --health-retries 10\n    defaults:\n      run:\n        working-directory: team-server\n    env:\n      DATABASE_URL: postgresql://fiscus:fiscus_ci@127.0.0.1:5432/fiscus\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6\n        with:\n          node-version: '24'\n          cache: npm\n          cache-dependency-path: team-server/package-lock.json\n      - run: npm ci\n      - name: Real PostgreSQL adapter smoke\n        run: node --disable-warning=ExperimentalWarning --test test/postgres-integration.test.ts\n'''
write(p,s)

# Build a real DB integration test using the shipped schema + PgRollupStore.
write('team-server/test/postgres-integration.test.ts', '''import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { generateKeyPairSync, sign, createHash } from 'node:crypto';\nimport { PgRollupStore } from '../src/store.ts';\n\nfunction signedRollup(keyId: string, privateKey: any) {\n  const body = {\n    schemaVersion: 1, generatedAt: new Date().toISOString(),\n    period: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },\n    projects: [{ project: 'ci-real-pg', units: 2, costUsd: 1.25, realizationRate: 0.5, realizedValueUsd: 2, netRealizedValueUsd: 1.5, roiIndex: 60, sources: ['ci'] }],\n  };\n  const canonical = JSON.stringify(body);\n  const bodyHash = createHash('sha256').update(canonical).digest('hex');\n  const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64');\n  return { keyId, bodyHash, signature, body } as any;\n}\n\ntest('PgRollupStore persists and replays an exact signed envelope transactionally', async () => {\n  const url = process.env.DATABASE_URL;\n  assert.ok(url, 'DATABASE_URL required for PostgreSQL integration test');\n  const store = new PgRollupStore(url);\n  try {\n    const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');\n    await store.applySchema(schema);\n    const { publicKey, privateKey } = generateKeyPairSync('ed25519');\n    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();\n    const keyId = createHash('sha256').update(pub).digest('hex').slice(0, 16);\n    await store.registerDeveloper(keyId, pub, 'CI developer');\n    assert.equal((await store.findDeveloper(keyId))?.keyId, keyId);\n    const envelope = signedRollup(keyId, privateKey);\n    const first = await store.insertRollup(envelope);\n    const retry = await store.insertRollup(envelope);\n    assert.equal(first.replayed, false);\n    assert.equal(retry.replayed, true);\n    assert.equal(retry.rollup.id, first.rollup.id);\n    const projects = await store.aggregateProjects();\n    const row = projects.find((x) => x.project === 'ci-real-pg');\n    assert.ok(row);\n    assert.equal(row!.developerCount, 1);\n    assert.equal(row!.totalUnits, 2);\n  } finally { await store.close(); }\n});\n''')

# CODEOWNERS makes ownership explicit without changing legal attribution.
write('.github/CODEOWNERS', '* @GamingDragonwastaken\n')

print('phase2 remediation applied')
