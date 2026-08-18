from pathlib import Path
root=Path(__file__).resolve().parents[1]

def read(p): return (root/p).read_text(encoding='utf-8')
def write(p,s):
    q=root/p; q.parent.mkdir(parents=True,exist_ok=True); q.write_text(s,encoding='utf-8')

write('src/dashboard/web/app/core/claimTypes.ts', '''export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';\nexport interface ClaimInspection {\n  provenance: string; scope: string; freshness: string; coverage: string;\n  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];\n}\nexport interface Layer {\n  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;\n  basis: string; nextStep?: string; inspection: ClaimInspection;\n}\n''')

p='src/dashboard/web/app/core/claimLayers.ts'; s=read(p)
s=s.replace("import type { Layer } from '../components/spine.ts';", "import type { Layer } from './claimTypes.ts';")
write(p,s)

p='src/dashboard/web/app/components/spine.ts'; s=read(p)
old="export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';\nexport interface ClaimInspection {\n  provenance: string; scope: string; freshness: string; coverage: string;\n  enforceability: string; evidenceSource: string; assumptions: string[]; missingEvidence: string[];\n}\nexport interface Layer {\n  id: LayerId; label: string; claim: string; valueUsd: number | null; established: boolean;\n  basis: string; nextStep?: string; inspection: ClaimInspection;\n}\n"
new="import type { Layer, LayerId } from '../core/claimTypes.ts';\nexport type { Layer, LayerId, ClaimInspection } from '../core/claimTypes.ts';\n"
if s.count(old)!=1: raise SystemExit('spine claim type block missing')
s=s.replace(old,new,1); write(p,s)
print('phase4 DOM-free claim types applied')
