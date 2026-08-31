# connect — native usage ingestion

## Consumes

- Claude Code JSONL transcripts;
- Codex rollout JSONL files;
- opencode's read-only SQLite session database.

## Guarantees

- importers never route traffic or read provider credentials;
- JSONL/file enumeration is incremental and capped by the shared resource policy;
- oversized source lines and rows are skipped before JSON parsing and disclosed
  as `ImportSummary.captureCoverage: "truncated"`;
- Codex rollout rows can be consumed incrementally, so a large session does not
  require retaining the complete normalized row array;
- imported spend keeps its source and estimated/exact pricing labels; a partial
  source capture never becomes complete evidence merely because some rows were
  imported.

## Invariants

- `request_id` remains the idempotent ledger key;
- missing or malformed source data is an honest empty/partial result, never a
  fabricated zero-dollar success;
- repository attribution is an inference/fallback label, not verified identity;
- legacy rows are `legacy_unknown` for capture coverage and are not backfilled.

## Verify

```bash
node --test --experimental-strip-types test/claude-code-import.test.ts test/codex-import.test.ts test/opencode-import.test.ts
```
