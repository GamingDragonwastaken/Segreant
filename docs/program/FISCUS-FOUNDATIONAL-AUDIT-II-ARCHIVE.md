# Foundational Audit II — Canonical Archive Manifest

This directory preserves the owner-approved Foundational Audit II **losslessly** before constitutional implementation begins.

## Canonical source

- Original filename: `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md`
- SHA-256: `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc`
- Size: 118,674 bytes
- Lines: 3,911
- Words: 15,950
- Approved by owner: 2026-08-29

The GitHub connector used for this execution accepts UTF-8 text payloads rather than arbitrary local-file uploads. To preserve the exact document without summarizing or rewriting it, the canonical bytes were transformed as:

```text
original markdown bytes
  -> gzip -9
  -> base64 text
  -> split into five ordered text chunks
```

The chunks are repository transport artifacts only. They do not alter the audit's semantic authority.

## Stored chunks

Concatenate these files in lexical order:

```text
docs/program/foundational-audit-ii/archive.b64.part-00
docs/program/foundational-audit-ii/archive.b64.part-01
docs/program/foundational-audit-ii/archive.b64.part-02
docs/program/foundational-audit-ii/archive.b64.part-03
docs/program/foundational-audit-ii/archive.b64.part-04
```

Expected concatenated Base64 length: 58,712 bytes.

## Portable reconstruction

Node 24, which Fiscus already requires:

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const parts = [0, 1, 2, 3, 4].map((n) =>
  readFileSync(`docs/program/foundational-audit-ii/archive.b64.part-${String(n).padStart(2, '0')}`, 'utf8')
);
const bytes = gunzipSync(Buffer.from(parts.join(''), 'base64'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const expected = '0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc';
if (sha256 !== expected) throw new Error(`audit archive SHA mismatch: ${sha256}`);
writeFileSync('FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md', bytes);
console.log(`${sha256}  FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md`);
NODE
```

Equivalent GNU shell reconstruction:

```bash
cat docs/program/foundational-audit-ii/archive.b64.part-* \
  | base64 --decode \
  | gzip --decompress \
  > FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md
sha256sum FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md
```

macOS `base64` commonly uses `-D` instead of `--decode`; the Node method above is the canonical cross-platform recipe.

## Authority

The reconstructed bytes are the architectural design authority for the Magnum-Opus reconstruction wherever they deliberately supersede the earlier master plan. This manifest and the program registers are navigation/execution artifacts; they do not silently rewrite the approved audit.
