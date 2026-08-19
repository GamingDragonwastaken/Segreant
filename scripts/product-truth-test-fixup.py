from pathlib import Path

root = Path(__file__).resolve().parents[1]
p = root / 'test' / 'product-truth-copy.test.ts'
s = p.read_text(encoding='utf-8')
old = "assert.match(readme, /Coding-agent workflows currently have the deepest validated outcome instrumentation/);"
new = "assert.match(readme, /Coding-agent workflows currently\\s+have the deepest validated outcome instrumentation/);"
if s.count(old) != 1:
    raise SystemExit(f'expected one README whitespace assertion, found {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('truth-copy whitespace assertion fixed')
