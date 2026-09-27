# Naming decision

**Recommendation (2026-09-25): rename Fiscus to Gryf.** It waits only on the
owner's go-ahead, because a product name is the one decision the owner lives
with permanently. Publishing to npm stays with the owner either way.

## Why the name has to change

`Fiscus` has been this project's name since its first commit (2026-06-20). On
2026-07-23 an npm account `fiscuslabs` registered `fiscus` ("Programmable
payment infrastructure for AI agents") and then `fiscus-mcp` ("identity-bound
payment tools for AI agents"). That is the same category: AI agents and money.
Having used the name first matters less than what a buyer finds when they
search "Fiscus AI agents": two products, one of which owns the npm name. A
FinOps tool that has to explain which Fiscus it is starts every conversation
behind. A Mexican e-invoicing (CFDI) API also uses the name.

## The criteria

A name had to pass all of these:

1. **Meaning.** It says guarding or accounting for money, not generic tech.
2. **Typable.** It works as a command you type fifty times a day: short, one
   word, no ambiguous spelling.
3. **Available.** The bare npm name is free, and no active product in AI cost
   or FinOps uses it.
4. **Enterprise-credible.** It doesn't sound like crypto and isn't a joke.
5. **Mascot fit.** It reuses the heraldic griffin seal already in
   `web/assets/`.
6. **Searchable.** It isn't a common English word that search results bury.

## Candidates checked

Each candidate below was checked against the npm registry on 2026-09-25;
"taken" means a published package exists.

| Name | npm | Verdict |
|---|---|---|
| **Gryf** | free | **Recommended.** Heraldic spelling of *griffin*, the mythic guardian of gold, which is exactly the job. It is already the logo. Four letters (`gryf today`, `gryf budget --daily 25`), said "grif". Other known uses are Polish heraldry and a Polish football club; the npm check found none in developer tooling. |
| Touchmark | free | Runner-up. A touchmark is the maker's stamp that certifies a piece of silver, which maps well to provenance on every row. Nine letters is long for a command. |
| Spendward | free | Clear but descriptive and flat, and weak as a trademark. |
| Reins | free | "Hold the reins on agent spend" fits the tagline, but it is a common word and unsearchable. |
| Coinward, Goldward | free | Read as crypto. |
| Aerarium, Quaestus, Nummus | free | The Latin reads well on a seal but fails typability and pronunciation. |
| Purser, Bursar, Assayer, Steward, Warden, Comptroller, Exchequer, Treasurer, Hallmark, Touchstone, Aurum, Ingot, Karat, Tithe, Talon, Griffon, Gryphon, Quaestor, Obol, Tallyman | taken | Out. |
| Tollgate, Obolus | taken by **direct competitors** | Out. Both are published local proxies or observability tools for AI coding-agent spend. |

## Competitors found on the way

Positioning should account for these:

- `tollgate`: a local proxy that intercepts Anthropic calls and monitors token
  spend.
- `obolus`: observability for AI coding-agent spend.
- `@relayplane/proxy`: a cost proxy aimed at cutting LLM spend.

None claims reconciliation against the provider's bill, conserved allocation,
signed evidence, or the four-number distinction. That is the gap this project
occupies, and the README should keep leading with it.

## What the rename touches, and how it stays safe

- **Size.** `fiscus` appears 4,269 times in 458 tracked files.
- **Names that change:** the command, the package name, the env vars
  (`FISCUS_HOME`, `FISCUS_DB`, `FISCUS_DEMO`), the data directory
  (`~/.fiscus`), the evidence format (`.fiscuspack`), and the dashboard and
  docs.
- **Existing users are not stranded.** The old env vars, `~/.fiscus` and
  `.fiscuspack` are read as legacy aliases for at least one minor version,
  with a one-line notice. Evidence packs already signed keep verifying.
- **The seal and griffin artwork stay.** Only the wordmark changes.
- **npm.** Publish as `gryf` with the command `gryf`. Until the owner
  publishes, the name can be taken by anyone. Reserving it is a
  two-minute `npm publish` of a placeholder, and that is the owner's call.

## Where to check a name yourself

- npm: `https://registry.npmjs.org/<name>`. A 404 means free.
- GitHub: `https://github.com/<name>`, for the organization handle.
- Trademarks: USPTO search (tmsearch.uspto.gov) and EUIPO TMview
  (tmdn.org/tmview), classes 9 and 42.
- Free hosting names: `<name>.pages.dev` (Cloudflare Pages) and
  `<name>.github.io`.
