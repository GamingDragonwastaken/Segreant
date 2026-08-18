from pathlib import Path
root=Path(__file__).resolve().parents[1]

def read(p): return (root/p).read_text(encoding='utf-8')
def write(p,s):
    q=root/p; q.parent.mkdir(parents=True,exist_ok=True); q.write_text(s,encoding='utf-8')
def replace_once(p,old,new):
    s=read(p)
    if s.count(old)!=1: raise SystemExit(f'{p}: expected one target, found {s.count(old)}')
    write(p,s.replace(old,new,1))

# Keep the pure claim model outside the browser/DOM module graph so Node tests
# and server-side typecheck do not acquire DOM globals as an accidental dependency.
write('src/dashboard/web/app/core/claimTypes.ts', '''export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';\nexport interface ClaimInspection {\n  provenance: string; scope: string; freshness: string; coverage: string;\n  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];\n}\nexport interface Layer {\n  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;\n  basis: string; nextStep?: string; inspection: ClaimInspection;\n}\n''')

p='src/dashboard/web/app/core/claimLayers.ts'; s=read(p)
s=s.replace("import type { Layer } from '../components/spine.ts';", "import type { Layer } from './claimTypes.ts';")
write(p,s)

p='src/dashboard/web/app/components/spine.ts'; s=read(p)
old="export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';\nexport interface ClaimInspection {\n  provenance: string; scope: string; freshness: string; coverage: string;\n  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];\n}\nexport interface Layer {\n  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;\n  basis: string; nextStep?: string; inspection: ClaimInspection;\n}\n"
new="import type { Layer, LayerId } from '../core/claimTypes.ts';\nexport type { Layer, LayerId, ClaimInspection } from '../core/claimTypes.ts';\n"
if s.count(old)!=1: raise SystemExit('spine claim type block missing')
s=s.replace(old,new,1); write(p,s)

# Coverage metadata is a total invariant: a non-full row is never allowed to
# reach the UI without an explanation and a safe path, even if a future author
# forgets to add a tailored GAP_DETAILS entry.
replace_once('src/dashboard/web/app/core/registry.ts',
"  const detail = GAP_DETAILS[cap.id];\n  return detail ? { ...cap, ...detail } : cap;",
"  const detail = GAP_DETAILS[cap.id] ?? {\n    reason: 'GUI coverage is incomplete for this capability and no narrower reviewed browser workflow exists yet.',\n    safeAlternative: `Use ${cap.command} explicitly.`,\n  };\n  return { ...cap, gapReason: detail.reason, safeAlternative: detail.safeAlternative };")

# The old regression test intentionally grepped the source location that held
# the realized-value meaning. Phase 4 moves that meaning into a pure builder;
# follow the canonical source rather than demanding a meaningless returnRatio
# string remain in the transport wrapper.
p='test/dashboard-script.test.ts'; s=read(p)
old="  const chain = readFileSync(join(WEB_SRC, 'app', 'core', 'chain.ts'), 'utf8');"
new="  const claimLayers = readFileSync(join(WEB_SRC, 'app', 'core', 'claimLayers.ts'), 'utf8');"
if s.count(old)!=1: raise SystemExit('dashboard-script realized-source declaration missing')
s=s.replace(old,new,1)
s=s.replace("    chain,\n    /returnRatio/,\n    'chain.ts must read the realized figure from roi.returnRatio',",
            "    claimLayers,\n    /returnRatio/,\n    'claimLayers.ts must read the realized figure from roi.returnRatio',",1)
s=s.replace("/valueUsd:\\s*matured[?.]*\\.realizedValueUsd/.test(chain)", "/valueUsd:\\s*matured[?.]*\\.realizedValueUsd/.test(claimLayers)",1)
s=s.replace("'chain.ts must not use matured.realizedValueUsd as the realized VALUE figure — that field is attributed spend'",
            "'claimLayers.ts must not use matured.realizedValueUsd as the realized VALUE figure — that field is attributed spend'",1)
s=s.replace("    chain,\n    /basis === 'usd'/,\n    'chain.ts must require the payload to declare a usd basis before showing dollars',",
            "    claimLayers,\n    /basis === 'usd'/,\n    'claimLayers.ts must require the payload to declare a usd basis before showing dollars',",1)
write(p,s)

print('phase4 DOM-free claim types and regression-source fixups applied')
