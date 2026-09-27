# pack — portable, verifiable bundles of records

A `.segreantpack` is a JSON envelope: a manifest that binds records by digest,
states what was left out and what was redacted, and optionally carries an
Ed25519 signature; plus the attachment bytes the manifest binds. It exists so
a set of records can leave the machine and be checked elsewhere WITHOUT the
checker trusting the producer, the transport, or Segreant.

Three outcomes are kept apart on every verification and never collapsed:
**integrity** (the bytes are the bytes the manifest bound), **authenticity**
(a key the verifier was handed out of band signed them), and **truth**
(never evaluated here — a pack proves nothing about whether its claims hold).

## Consumes

- `SegreantPackManifestInput`: pack id, creation instant, included record
  references (`kind`, `id`, `digest`), omissions, redactions, external
  references (metadata only; never dereferenced), attachment descriptors;
- attachment bytes as canonical base64 (`SegreantPackAttachmentData`);
- an `EpistemicLedger` for the one producer, `export.ts`: every node of the
  ledger graph, read back through the ledger's own readers;
- a private key for signing and, at verification, an optional trust anchor
  (`trustedPublicKey`) supplied by the caller, never taken from the pack.

## Guarantees

- **Canonical bytes.** Serialization is canonical JSON under declared resource
  limits (`canonical.ts`); the manifest digest is over the manifest with its
  own signature metadata excluded, so signing does not change what is signed.
- **Verification fails closed and stays local.** `verifySegreantPack()` parses
  under the same limits, dereferences no path and no URI, and reports every
  error rather than the first.
- **An embedded key establishes integrity only.** `authenticity` is `verified`
  when, and only when, the caller supplied a trust anchor that matches the
  signing key; the same signature without one is `not_established`.
- **Omission and redaction are said, not done silently.** `export.ts` turns a
  record past the byte budget into an omission entry with its ids and reason,
  and carries `confidential` / `restricted` evidence with its `payload` set to
  `null` and a redaction entry naming the ids and field; the reference digest
  still binds the record AS STORED, so a verifier can tell a redacted copy from
  the original.
- **Independent verification exists.** `standalone/segreantpack-verifier.mjs`
  imports nothing from this module and is run against committed vectors and
  against a freshly exported ledger pack.

## Invariants

- `truth` is the literal `'not_evaluated'` on every result. Nothing in this
  module reads a claim's profile, proposition, or evidence.
- A producer never overwrites: `segreant pack export --out` refuses an existing
  path and writes nothing without `--out`.
- Every digest is `sha256:<hex>`; a bare hex digest is invalid to both
  verifiers.

## Verify

```bash
node --test --experimental-strip-types test/segreantpack.test.ts
node --test --experimental-strip-types test/segreantpack-production.test.ts
node --test --experimental-strip-types test/segreantpack-independent-verifier.test.ts
node --test --experimental-strip-types test/segreantpack-ledger-export.test.ts
```

## Does not establish

The producer is the epistemic ledger only (D-229): no other store table, and
no request, economic, allocation or billing row, is packed. A pack carries
the kernel's records, not the kernel — the recipient can check that these
records are what was bound and signed, and cannot run the derivation-chain,
witness, or measurement checks that admitted them without their own ledger.
Cross-runtime interoperability beyond Node, hosted verification, and an
external review of the signature scheme are outside the repository.
