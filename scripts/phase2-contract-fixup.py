from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'src/dashboard/web/app/core/contracts.ts'
s = p.read_text(encoding='utf-8')
s = s.replace("  range: string;\n  summary: Summary;", "  range: string;\n  generatedAt?: string;\n  budget?: unknown;\n  summary: Summary;")
s = s.replace("    estimatedCostUsd: number;\n    estimatedSpendShare: number;\n", "    autoRefresh?: boolean;\n    estimatedCostUsd: number;\n    estimatedSpendShare: number;\n    provenance?: unknown;\n")
s = s.replace("  byModel: GroupRow[];\n  byProject: GroupRow[];\n  bySource: GroupRow[];", "  byModel: GroupRow[];\n  byProject: GroupRow[];\n  attributionEvidence?: unknown;\n  byUser?: GroupRow[];\n  bySource: GroupRow[];\n  characterization?: unknown;\n  dimensions?: unknown;")
s = s.replace("  recent: Array<Record<string, unknown>>;", "  recent: unknown[];")
p.write_text(s, encoding='utf-8')
