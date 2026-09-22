# Absence Reported As A Result

A defect class, its twenty-one recorded instances, and the checklist that finds it in code you have never seen.

This document is portable on purpose. The instances are from Fiscus; the checklist is not about Fiscus, and none of its steps use this project's vocabulary. If you have a system that computes numbers over stored records and shows them to someone, the checklist applies to you.

---

## 1. The class, in one paragraph

A system deletes, filters, truncates, fails to collect, or never had some records. A reader downstream computes over what remains and reports the result **without the fact of the missing records travelling with it**. The output is not merely imprecise — it is confidently wrong in a specific direction, and it is wrong in the voice of a system that knows. "No spend in this period" and "we deleted this period's spend" produce the same screen. "Nothing was captured" and "we captured it and then erased it" produce the same sentence. The absence became a result.

The reason it is worth a name is that the fix is never local. Each instance is a *reader*, and a system has many readers of the same table. Fixing the one that was reported leaves the other eleven, which is why this class was found twenty-one times in one codebase and not once.

---

## 2. Why it survives review

Six properties make it nearly invisible, and they are the reasons to use a checklist rather than attention.

1. **Both paths are silent.** Neither the deletion nor the reader raises anything. There is no error to notice.
2. **The wrong answer is well-formed.** `0`, `100%`, `complete`, `[]`, `null` are all valid values of their types. A schema check passes. A contract test that asserts the field is PRESENT passes.
3. **The absence is upstream of the consequence,** often by months and several modules. The deletion is retention policy; the consequence is a purchasing recommendation.
4. **The reader is usually correct.** The code computing "share allocated" is right about the rows it was given. It was never told the row set was truncated.
5. **It has direction.** Absent denominators inflate; absent numerators deflate. Both look plausible, and one of them looks like good news, which nobody investigates.
6. **The founding fix looks complete.** Recording the deletion — a retention table, an audit row — feels like closure. It is not: it creates a fact that every reader must now consult, and none of them do yet.

---

## 3. The instances

Grouped by what the absent thing was. Every row is a real defect with a decision record; `D-NNN` refers to `DECISION-LOG.md`.

### The absence was deleted data, and a reader spoke for the gap

| | What was reported | What was true |
|---|---|---|
| D-170 | A deleted history and a history that never happened read identically | The founding instance; the record table exists because of it |
| D-171 | Window totals over a range the ledger no longer covered | The range had been pruned |
| D-173 | A deletion restored a money claim the surviving evidence refutes | Removing the refuting record revived the refuted claim |
| D-175 | The server told the GUI a window had complete coverage | It had deleted rows from that window |
| D-176 | A commit that cost $6.00 looked free, and every ratio over it improved | Its spend rows were pruned |
| D-177 | A model recommendation on the strength of deleted dollars | The comparison's losing side had been truncated |
| D-179 | "Your proposals were never captured" | They were captured, then erased |
| D-180 | The gate ladder reported no complete proposal captured | About a proposal the system had deleted |
| D-181 | A **signed** rollup declared complete coverage | Over spend that had been deleted — a signature over an absence |
| D-182 | The surface built to explain WHY a channel is dark gave the wrong reason | It could not see the deletion |
| D-183 | "100% of the period allocated" | Over a period 95% of whose spend was gone |
| D-185 | The report deciding whether to buy a credential said the local side was empty | Over a period it had deleted |
| D-186 | A deletion switched off the warning that prevents the product's most expensive mistake | Silence read as "nothing to warn about" |

### The absence was structural — a gap the query itself created

| | What was reported | What was true |
|---|---|---|
| D-187 | $180.00 vanished between a predicate and its own negation | In SQL three-valued logic, `NOT (x = NULL)` is NULL, so a predicate and its negation stop partitioning the moment either side can be NULL |
| D-165 | A list silently dropped rows, and gave every remaining row a null that meant something else | Two different absences rendered as one value |
| D-167 | A coverage fraction computed over a population the code itself chose | The denominator excluded what would have lowered it |
| D-191 | An upper bound of **zero percent**, from zero observations | The strongest possible negative claim, drawn from no evidence |

### The absence was a check that did not exist, or a record that had gone stale

| | What was reported | What was true |
|---|---|---|
| D-166 | A documented command was covered | Nothing ever ran the documentation against the CLI |
| D-169 | The program's own records described the current state | They were two closures stale on the highest-priority item |
| D-174 | The tool told an operator to do a thing | They had already done it; it could not see that |
| D-178 | The wire carried the retention counts for two whole packets | No screen could read them — built, shipped, unreachable |

---

## 4. The checklist

Run this against a system, not against a bug report. Each step produces a list; the next step consumes it. It is deliberately mechanical: the whole point is that judgment was already tried and missed twenty-one of these.

**Step 1 — Enumerate every way records leave, or never arrive.** Not every feature: every *operation*. Deletes, retention jobs, cascade deletes, filtered reads, `LIMIT`, sampling, failed or skipped collection, permission-scoped queries, time-window bounds, and every default that silently narrows a range. Write the list down and count it. You will use the count.

**Step 2 — For each operation, list every reader of every table it touches.** Follow the table, not the feature. Two features that read the same table have the same exposure, and the second one is the one that gets missed. Include readers you consider trivial: exports, health checks, aggregate counts, cache warmers.

**Step 3 — For each reader, list every sentence it can emit.** Include empty states, zero states, "complete", "none", "all", "up to date", "no issues found", and every percentage whose denominator that reader computes. A sentence is anything a human or another system can act on, including an absent warning — a warning that fails to fire is a sentence.

**Step 4 — Check each sentence against a deliberately truncated fixture.** Not a mocked one: build the real state — write records, delete some through the real operation, then read. The question for each sentence is exactly one thing: *could a reader distinguish this output from the same output over data that never existed?* If no, it is an instance.

**Step 5 — Rank by consequence, and the ranking rule is specific.** Ask whether the absent quantity is a **denominator**, or feeds a **comparison between two things**. Those are the expensive ones, because they do not merely understate a figure — they change which option wins. A missing numerator makes a number too small; a missing denominator makes a *decision* wrong. Fix those first.

**Step 6 — Derive the predicate from the query, not from the feature.** When a filter or its negation can meet a nullable column, the two halves stop partitioning and rows fall out of both. Enumerate this from the schema — which columns are nullable — and check every predicate over them, rather than from the feature list, which will not mention it.

**Step 7 — Sweep the operation, not the feature — and state your enumeration when you report.** A sweep is worth exactly the enumeration it was run over. "I checked the deletion paths" is not a result; "I checked all five `DELETE` statements, here they are" is. **Report the corpus size even when the sweep finds nothing**, because a partial sweep reported without its count reads as coverage.

**Step 8 — Convert the finding into a gate, not a fix.** A repaired reader stays repaired only until the next reader is written. Make the enumeration itself executable: a test that derives the list of operations from the source and fails when a new one arrives unswept. Anything left as prose will be wrong within two changes, and this class's own history proves it — three separate records in this project went stale *while describing the rule they were breaking*.

---

## 5. What the checklist does not catch

Stated so that running it is not mistaken for safety.

- **A reader that is wrong for an unrelated reason.** This finds absences, not arithmetic errors.
- **Absences with no reader today.** If nothing reads the table yet, step 2 yields nothing and the instance arrives with the next feature. The gate in step 8 is the only defence.
- **Correct handling that is unhelpfully expressed.** "Unknown" shown where a user needed a number is a product problem, not this defect. Do not let the checklist turn every honest unknown into a bug.
- **Whether the record of the absence is itself trustworthy.** If the deletion record can be written non-atomically with the deletion, every reader that consults it inherits a gap the checklist assumes closed. That was a real instance here (D-189), found only after the readers were fixed.
- **The inverse class: a mechanism built and never wired.** Related and worth a separate sweep — a capability that ships, passes its tests, and is reachable by nothing (D-178 is the overlap). "Imported" and "invoked" are different facts, and a mention is not a call.

---

## 6. The one-line version

**A number computed over records that may be missing must carry the fact that they may be missing, all the way to the sentence that a human reads — and the check that this is true has to be executable, because prose describing this rule has already gone stale three times while stating it.**
