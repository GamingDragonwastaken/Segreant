from pathlib import Path

root = Path(__file__).resolve().parents[1]

p = root / 'src' / 'dashboard' / 'web' / 'app' / 'views' / 'control.ts'
text = p.read_text(encoding='utf-8')
old = ": 'not checked by Fiscus') }))),"
new = ": 'not checked by Fiscus') })))),"
if text.count(old) != 1:
    raise SystemExit(f'expected one Control outer-container close target, found {text.count(old)}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')

p = root / 'test' / 'property-invariants.test.ts'
text = p.read_text(encoding='utf-8')
old = "    if (ci?.low !== null && ci?.point !== null && ci?.high !== null) {\n"
new = "    if (ci && ci.low !== null && ci.point !== null && ci.high !== null) {\n"
if text.count(old) != 1:
    raise SystemExit(f'expected one composite interval narrowing target, found {text.count(old)}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')

print('phase3 compiler fixups applied')
