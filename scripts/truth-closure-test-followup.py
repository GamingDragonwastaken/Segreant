from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'test/realization-store.test.ts'
text = p.read_text(encoding='utf-8')
old = """  assert.ok(roi.roiIndex !== null && roi.roiIndex > 0, 'a real composite');
  assert.equal(roi.indexIsUpperBound, true, 'lift uninstrumented → honest upper bound');
"""
new = """  assert.ok(roi.roiIndex !== null && roi.roiIndex > 0, 'a real observed-lens composite');
  assert.equal(roi.indexIsUpperBound, false, 'observed-only mean is not a mathematical upper bound');
  assert.ok(roi.instrumentationInterval.low !== null && roi.instrumentationInterval.high !== null);
  assert.ok(roi.instrumentationInterval.low! <= roi.instrumentationInterval.high!);
"""
if text.count(old) != 1:
    raise SystemExit(f'realization-store.test.ts: expected one stale upper-bound assertion, found {text.count(old)}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
print('downstream RoI assertion updated')
