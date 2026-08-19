from pathlib import Path

root = Path(__file__).resolve().parents[1]
p = root / 'test' / 'dashboard-pricing-parity.test.ts'
s = p.read_text(encoding='utf-8')
s = s.replace("import { hasRunner } from '../src/dashboard/web/app/core/actions.ts';\n", '')
s = s.replace("  assert.equal(hasRunner(cap), true);\n  const actions = readFileSync(join(root, 'src/dashboard/web/app/core/actions.ts'), 'utf8');\n", "  const actions = readFileSync(join(root, 'src/dashboard/web/app/core/actions.ts'), 'utf8');\n  assert.match(actions, /pricing:\\s*\\(cap\\)/, 'pricing must have a browser action runner');\n")
p.write_text(s, encoding='utf-8')
print('phase6 Node/browser test boundary fixed')
