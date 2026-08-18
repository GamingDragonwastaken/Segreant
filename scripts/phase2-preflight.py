from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'src/value/lenses.ts'
s = p.read_text(encoding='utf-8')
old = "how: 'realized fraction weighted by production reach + durability (not lines)',"
new = "how: 'production reach × durability among matured units (not line count)',"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('unexpected Impact wording; refusing non-deterministic transform')
p.write_text(s, encoding='utf-8')
