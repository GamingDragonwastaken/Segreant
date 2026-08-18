from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
p = ROOT / 'src/dashboard/web/app/core/chain.ts'
text = p.read_text(encoding='utf-8')
old = """  const runs = b?.reconciliation?.runs ?? 0;
  const billed: Layer = {
"""
new = """  const runs = b?.reconciliation?.runs?.length ?? 0;
  const billed: Layer = {
"""
if text.count(old) != 1:
    raise SystemExit(f'chain.ts: expected one stale reconciliation run-count consumer, found {text.count(old)}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
print('follow-up reconciliation consumer fix applied')
