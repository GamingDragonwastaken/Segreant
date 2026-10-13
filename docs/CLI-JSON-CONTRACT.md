# CLI JSON contract

Use `--json` on a command that advertises machine output. Each completed read
emits one JSON document on stdout, including on a structured refusal. A command
that cannot produce a document exits non-zero with a concise diagnostic on
stderr and empty stdout. Human progress messages and stack traces never belong
in the JSON stream. Commands wrapping another process, persistent servers and
the status-line stdin protocol have their own output rules.

Every CLI JSON read response has the top-level integer `schemaVersion: 1`. Object
responses keep their existing fields beside that version. Responses that were
arrays, including request exports and audit rows, now use
`{ "schemaVersion": 1, "data": [...] }`. JSON request exports written with
`--out` use the same envelope as stdout. CSV output keeps its existing format.

Within a version, existing field meanings and types remain stable. New optional
fields may be added; readers should ignore fields they do not recognize. A
required field removal, a type change, a meaning change, or a different envelope
requires a new schema version and a documented migration. This promise begins
with the versioned 0.2.0 output; pre-versioned array consumers must read `data`.

The response version is separate from a ledger, billing evidence document,
signed receipt or pack schema. Backup/refusal output exposes the database
version as `ledgerSchemaVersion`; nested artifact versions and signed bodies
keep their own meanings. JSON formatting does not change those signed bodies.

Money still carries its original basis: metered usage, provider-billed cost,
allocated cost and realized value are distinct. Unknown stays null or the
documented sentinel; versioning never supplies missing evidence.

`test/cli-json-contracts.test.ts` derives command groups and aliases from the
actual dispatcher. Its fixture modes cover missing, empty, corrupt and large
synthetic ledgers, plus folders without Git. Adding a dispatch group requires
classifying it for read coverage or stating why it has another output protocol.
