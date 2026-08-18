from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'src' / 'dashboard' / 'web' / 'app' / 'views' / 'control.ts'
text = p.read_text(encoding='utf-8')
old = ": 'not checked by Fiscus') }))),"
new = ": 'not checked by Fiscus') })))),"
if text.count(old) != 1:
    raise SystemExit(f'expected one Control outer-container close target, found {text.count(old)}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
print('phase3 Control syntax fix applied')
