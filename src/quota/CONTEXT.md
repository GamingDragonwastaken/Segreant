# quota — the vendors' own usage meters, set beside Segreant's count

<!-- Layer 2 contract. The boundary between what a vendor's meter said and what Segreant counted. -->

## Consumes

- Codex session logs: the `rate_limits` on each `token_count` event
  (`used_percent`, `window_minutes`, `resets_at` per window). The importer
  (`src/connect/codex.ts`) stores a reading only when its percentage or
  reset changes within a file.
- Claude Code transcripts: the vendor's limit message, only from a line
  carrying `"isApiErrorMessage":true`
  (`src/connect/claudeCode.ts`). The reset clock time is resolved in the zone
  the message names.
- Claude Code's status line input (`rate_limits.five_hour`, `seven_day`,
  `spend_limit`: `used_percentage` and `resets_at`), when the person sets
  `segreant-statusline` as their status line command (`statusline.ts`). This
  is Claude's live percentage, which its transcripts do not carry.
- `quota_events` (`src/store/schema.ts`), and list cost per source from the
  request ledger (`Store.sourceCostBetween`).

## Guarantees

- The vendor's meter and Segreant's count are separate claims and are shown
  side by side, never merged. A disagreement beyond 1.5× of the earlier
  windows' median is shown as both figures with a plain reason it can happen.
  It is evidence, not an accusation.
- A pace projection is labelled an estimate. A projected limit time that has
  already passed is reported as "was due; not known whether reached", never
  as a forecast.
- A window that reset after the last reading has no current reading. It is
  not reported as 0% used.
- Claude Code logs no percentage. The view says so and points to the vendor's
  own page; the "last 5 hours against the median before a hit" figure is an
  estimate, because the window's true start is not logged.

## Invariants

- A limit message quoted in a prompt, a tool result or a commit is never a
  limit event.
- Parallel agents that hit the same limit count once (deduplicated by the
  window's reset time).
- Pure parsing and view logic (`limits.ts`, `view.ts`): no I/O. I/O lives in
  the importers, `statusline.ts` and `src/cli/quotaCmd.ts`.
- The status line path (`statusline.ts`, `bin/segreant-statusline.mjs`)
  always prints one line and exits 0. It never creates the ledger or a table,
  waits at most 200 ms for the write lock, and writes a reading only when it
  changed. It skips the Store's integrity pass (1.3 s) because a bar that
  refreshes on every message cannot wait for it. The next ordinary open runs
  that pass.
