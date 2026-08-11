# Outcome evidence and provenance

Fiscus distinguishes an outcome claim from the strength of the evidence that
entered the local ledger. A passing gate means a recorded signal exists; it does
not by itself prove independent verification.

## Evidence classes

| Class | How it enters | What it establishes |
|---|---|---|
| `manual` | `fiscus report` | A person asserted the outcome for one immutable commit (or a named non-code session). |
| `local-command` | `fiscus exec -- ...` | A local wrapped command exited with the recorded status for one commit or named session. |
| `signed-ci` | `fiscus evidence github import ...` | A signed GitHub Actions test artifact passed the local key, repository, commit, ref, workflow, and policy checks. |

All coding lifecycle signals (`tested`, `merged`, `shipped`, `incident`) must be
bound to one resolved Git commit. Fiscus does not let an unbound project-window
signal certify another commit by timing alone.

## Signed GitHub Actions test evidence, v1

The v1 importer accepts **only** a `tested` pass/fail assertion. It does not
infer merge, deploy, release, production traffic, or business outcomes from a
workflow result.

An artifact is accepted only when all of these checks pass locally:

- its canonical JSON body hashes to the signed body hash;
- the signature verifies against the public key the importing operator pins;
- the key identifier matches that pinned key;
- repository numeric ID, full SHA, branch/ref, workflow path, policy ID, workflow
  digest, and test-plan digest match the import command's explicit expectations;
- the workflow conclusion agrees with the asserted pass/fail verdict;
- the commit resolves in the local checkout; and
- its timestamp is within the local freshness window.

The raw signed envelope is retained locally with the resulting gate signal.
Event IDs and signed body hashes are replay-safe: an exact replay is a no-op;
a different payload for the same event is rejected. This evidence is stronger
than a local command exit, but it remains evidence about the declared test plan,
not a universal statement that a change is safe or valuable.
