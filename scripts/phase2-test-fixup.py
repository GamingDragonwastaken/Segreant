from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def r(p): return (ROOT/p).read_text(encoding='utf-8')
def w(p,s): (ROOT/p).write_text(s,encoding='utf-8')
def one(p,old,new):
    s=r(p); n=s.count(old)
    if n!=1: raise SystemExit(f'{p}: expected one match, got {n}: {old[:100]!r}')
    w(p,s.replace(old,new,1))

# Dashboard contract test now has two sources: endpoint declarations remain in
# api.ts, while the canonical interface declarations live in contracts.ts.
p='test/dashboard-contract.test.ts'; s=r(p)
s=s.replace(" * `src/dashboard/web/app/core/api.ts`. Nothing checks those declarations against\n * what the server actually sends: the browser tsconfig cannot see the node\n * source, so the two sides are structurally unrelated to the typechecker, and a\n * field name invented in the GUI is not a compile error.\n", " * `src/dashboard/web/app/core/contracts.ts`, which the browser client imports and\n * the server can type against. This runtime check remains defense in depth: JSON\n * is not runtime-validated by TypeScript, and endpoint wiring can still drift.\n")
needle="""const API_SRC = join(
  import.meta.dirname,
  '..',
  'src',
  'dashboard',
  'web',
  'app',
  'core',
  'api.ts',
);
"""
replacement=needle+"""
const CONTRACTS_SRC = join(
  import.meta.dirname,
  '..',
  'src',
  'dashboard',
  'web',
  'app',
  'core',
  'contracts.ts',
);
"""
if needle not in s: raise SystemExit('dashboard contract API path block missing')
s=s.replace(needle,replacement,1)
s=s.replace("  const source = readFileSync(API_SRC, 'utf8');\n  const interfaces = parseInterfaces(source);\n  const endpoints = parseEndpoints(source);", "  const apiSource = readFileSync(API_SRC, 'utf8');\n  const contractSource = readFileSync(CONTRACTS_SRC, 'utf8');\n  const interfaces = parseInterfaces(contractSource);\n  const endpoints = parseEndpoints(apiSource);")
w(p,s)

# Source-level semantic guards should follow the type to its canonical home.
p='test/dashboard-script.test.ts'; s=r(p)
s=s.replace("  const api = readFileSync(join(WEB_SRC, 'app', 'core', 'api.ts'), 'utf8');\n  assert.match(\n    api,", "  const contracts = readFileSync(join(WEB_SRC, 'app', 'core', 'contracts.ts'), 'utf8');\n  assert.match(\n    contracts,")
s=s.replace("'api.ts must warn that matured.realizedValueUsd is a cost, not a value'", "'contracts.ts must warn that matured.realizedValueUsd is a cost, not a value'")
s=s.replace("  const gui = readFileSync(join(WEB_SRC, 'app', 'core', 'api.ts'), 'utf8');", "  const gui = readFileSync(join(WEB_SRC, 'app', 'core', 'contracts.ts'), 'utf8');")
s=s.replace(" * The GUI declares its own copy of BudgetConfig, and a wrong field name there is\n * SILENT in both directions:", " * The shared dashboard contract declares BudgetConfig. A wrong field name there is\n * SILENT at runtime despite compile-time sharing:")
s=s.replace(" * No typecheck can catch it — the browser tsconfig cannot see the node\n * source, so the two interfaces are structurally unrelated.\n *\n * So the contract is pinned across the boundary:", " * The shared declaration now lets typecheck catch direct drift, and this source-level\n * guard keeps the server config field names pinned as defense in depth.\n *\n * So the contract is pinned across the boundary:")
w(p,s)

# The old Impact tests asserted the bug we are removing. Replace them with the
# intended orthogonal evidence contract.
p='test/roi-return.test.ts'; s=r(p)
old="""test('Impact is driven by production reach (shipped), not line counts (the M2 fix)', () => {
  // Same realization (one realized unit + one not), differing only in whether the
  // realized unit reached production. No size input exists on the lens at all.
  const matured = { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3, netRealizedValueUsd: 3 };
  const reached = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }));
  const notReached = computeReturnOnIntelligence(rep({ units: [unit(true, false), unit(false)], matured }));
  assert.ok(reached.lenses.impact.value !== null && notReached.lenses.impact.value !== null);
  assert.ok(
    reached.lenses.impact.value! > notReached.lenses.impact.value!,
    `shipped ${reached.lenses.impact.value} should outweigh non-shipped ${notReached.lenses.impact.value}`,
  );
});
"""
new="""test('Impact is not reconstructed from production gates already counted by Realization', () => {
  const matured = { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3, netRealizedValueUsd: 3 };
  const reached = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }));
  const notReached = computeReturnOnIntelligence(rep({ units: [unit(true, false), unit(false)], matured }));
  assert.equal(reached.lenses.impact.value, null);
  assert.equal(notReached.lenses.impact.value, null);
  const measured = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }), {
    impact: 0.8,
    impactHow: 'customer exposure sample',
  });
  assert.equal(measured.lenses.impact.value, 0.8);
  assert.equal(measured.lenses.impact.how, 'customer exposure sample');
});
"""
if old not in s: raise SystemExit('roi-return old Impact test missing')
s=s.replace(old,new,1); w(p,s)

p='test/value.test.ts'; s=r(p)
s=s.replace("  assert.ok(Math.abs(r.coverage - 3 / 4) < 1e-9, 'lift excluded from coverage');", "  assert.ok(Math.abs(r.coverage - 2 / 4) < 1e-9, 'Lift and orthogonal Impact are both uninstrumented');")
s=s.replace("  const r = computeReturnOnIntelligence(report, { lift: 0.5 });\n  assert.equal(r.coverage, 1, 'all four lenses instrumented');", "  const r = computeReturnOnIntelligence(report, { lift: 0.5, impact: 0.8, impactHow: 'external outcome signal' });\n  assert.equal(r.coverage, 1, 'all four lenses instrumented only when Impact is supplied independently');",1)
old="""test('RoI: Impact diverges from raw realization via production reach (shipped weighs more), not line counts', () => {
  const report: RealizationLike = {
    firstPassAcceptance: null,
    units: [
      ru({ realized: true, acceptance: null, shipped: true }), // realized AND reached production
      ru({ realized: false, acceptance: null }), // not realized
    ],
    matured: { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3 },
  };
  const r = computeReturnOnIntelligence(report);
  assert.ok(r.lenses.impact.value !== null);
  // The realized unit shipped (reach 1.5) while the other didn't realize → impact
  // is pulled above the raw 0.5 realization purely by production reach. No LOC input
  // exists on the lens anymore, so this divergence cannot come from size.
  assert.ok(r.lenses.impact.value! > 0.5, `impact ${r.lenses.impact.value} should exceed raw 0.5 realization`);
});
"""
new="""test('RoI: Impact is independently supplied and can diverge from raw realization without double-counting gates', () => {
  const report: RealizationLike = {
    firstPassAcceptance: null,
    units: [ru({ realized: true, acceptance: null, shipped: true }), ru({ realized: false, acceptance: null })],
    matured: { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3 },
  };
  const absent = computeReturnOnIntelligence(report);
  assert.equal(absent.lenses.impact.value, null);
  const measured = computeReturnOnIntelligence(report, { impact: 0.9, impactHow: 'business outcome adapter' });
  assert.equal(measured.lenses.impact.value, 0.9);
  assert.equal(measured.lenses.realization.value, 0.5);
});
"""
if old not in s: raise SystemExit('value old Impact test missing')
s=s.replace(old,new,1); w(p,s)

# VoI fixtures now instrument Impact explicitly when the test means it is known.
p='test/voi.test.ts'; s=r(p)
s=s.replace("/** A matured, realized unit (all gates pass) and a failed one — enough to instrument ρ and ι. */", "/** Matured units instrument Realization; Impact is supplied separately when known. */")
s=s.replace("  // Realization + Impact instrumented; Acceptance + Lift honestly missing.\n  return computeReturnOnIntelligence({\n", "  // Realization + explicit orthogonal Impact instrumented; Acceptance + Lift missing.\n  return computeReturnOnIntelligence({\n")
s=s.replace("    matured: { realizationRate: 0.7, totalCostUsd: 10, realizedValueUsd: 7 },\n  });", "    matured: { realizationRate: 0.7, totalCostUsd: 10, realizedValueUsd: 7 },\n  }, { impact: 0.7, impactHow: 'fixture outcome signal' });",1)
s=s.replace("    { lift: 0.6 },\n  );", "    { lift: 0.6, impact: 0.7, impactHow: 'fixture outcome signal' },\n  );")
w(p,s)

print('phase2 test fixups applied')
