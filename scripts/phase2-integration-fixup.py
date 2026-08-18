from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

src = ROOT / 'team-server' / 'test' / 'postgres-integration.test.ts'
dst = ROOT / 'team-server' / 'integration' / 'postgres.test.ts'
if not src.exists():
    raise SystemExit('generated PostgreSQL integration test missing')
if dst.exists():
    raise SystemExit('dedicated PostgreSQL integration test already exists unexpectedly')
dst.parent.mkdir(parents=True, exist_ok=True)
src.replace(dst)

# Phase 2 also writes the permanent CI PostgreSQL lane. Keep that lane pointed at
# the dedicated integration directory so ordinary `npm test` never acquires an
# environment-dependent database test.
ci = ROOT / '.github' / 'workflows' / 'ci.yml'
text = ci.read_text(encoding='utf-8')
old = 'test/postgres-integration.test.ts'
new = 'integration/postgres.test.ts'
if old in text:
    text = text.replace(old, new)
elif new not in text:
    raise SystemExit('permanent CI PostgreSQL integration path missing after Phase 2 transform')
ci.write_text(text, encoding='utf-8')

print('phase2 PostgreSQL integration isolation applied')
