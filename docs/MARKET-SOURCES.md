# Public market sources

`segreant market` compares models on public evidence of quality per dollar. It
runs offline from a dated snapshot bundled in `market/snapshot.json`, and it
fetches a newer copy of a source only when you run
`segreant market --refresh <source|all>` and have granted that source through
the egress gate. This page lists every source it uses, why, under what licence,
and what each one can and cannot tell you.

Checked on 2026-09-27. The bundled snapshot was fetched the same day, through
the product's own refresh path.

## Sources used

| Source | What it supplies | Licence or terms | URL fetched |
|---|---|---|---|
| Aider polyglot leaderboard | Pass rate on 225 coding exercises, and the dollar cost Aider published for each run | Apache-2.0 (the Aider repository's licence covers the leaderboard data file) | `https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml` |
| LMArena leaderboard dataset | Preference ratings with intervals and vote counts for the text (style control), WebDev and text-to-image boards | CC BY 4.0, stated on the dataset card | `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=…&split=latest` |
| Epoch AI Benchmarking Hub | Results for about 80 benchmarks, cleaned and grouped by model: the table Epoch builds its own Capabilities Index from, with each benchmark's chance baseline and ceiling | CC BY 4.0, stated in the bundle's README | `https://epoch.ai/data/benchmark_data.zip` |
| LiteLLM model price list | Public list prices per token (and per image, where listed) | MIT (the LiteLLM repository's licence) | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |

Attribution: benchmark data © the Aider project; leaderboard data © LMArena,
used under CC BY 4.0; price data © BerriAI/LiteLLM contributors; benchmark data from Epoch AI, 'Capabilities & benchmarking', epoch.ai/benchmarks, used under CC BY 4.0. The market
names each source, its licence and its link beside every board it supplies.

## How each figure is formed

- **Cost per solved task** (coding, Aider only): the run cost Aider published
  divided by the exercises that run solved. It is the one board with real
  spend behind it, so it is the one board with a per-dollar figure. It reflects
  Aider's harness, prompts and the prices on the run date. Where Aider recorded
  a run cost of zero or annotated it as incorrect, the cost is treated as
  unpublished: the row keeps its pass rate and has no cost figure and no
  frontier position.
- **Ratings** (LMArena): relative preference ratings, not percentages. Dividing
  them by dollars would mean nothing, so no per-dollar ratio is formed. Instead
  each board has a frontier: a model is off it only when a model with a list
  price no higher has a whole rating interval above its own.
- **List prices** (LiteLLM): joined to a leaderboard name exactly, or by
  removing a parenthetical, a date suffix, or an effort suffix such as `-high`
  or `-max`. A normalized join names the price-list entry it used. A model with
  no join shows "no public price" and no frontier position. The frontier orders
  token prices by a 3 input : 1 output blend.

Your own realized value (`segreant market --repo <path>`) is shown beside these
figures, with its own basis, and never enters them.

## The consensus quality score

For coding and general chat, the market combines many public benchmarks into
one **consensus score** per model. It is not a plain mean, which would be wrong
in two ways: benchmarks differ in difficulty (a model tested only on hard ones
would look weak), and each benchmark covers a different set of models.

1. Every score is **chance-corrected** onto 0 to 1 with the benchmark's
   published chance baseline and ceiling (a 25% guess rate on a four-option
   test counts as zero). LMArena ratings become the probability of beating the
   median-rated model on that board, which is also a 0-to-1 score.
2. A small **item-response model** is fitted, the method Epoch AI uses for its
   Capabilities Index: expected score = sigmoid(slope_b x (ability_m -
   difficulty_b)). Model abilities and benchmark difficulties are estimated
   together, so a hard benchmark counts as hard.
3. Each benchmark's observations are **weighted** by the published reliability
   rubric below.
4. The displayed score is the expected score on a **typical benchmark** of the
   category, 0 to 100. Its **range** is how far it moves when any one benchmark
   is dropped and the model refitted. A model needs at least two benchmarks.
5. Where a source lists effort variants separately (high, max, 32k thinking),
   the model's best reported result on each benchmark is used.

Checked against the reference: over the models both cover, the consensus
ranking agrees with Epoch AI's own Capabilities Index at a Spearman
correlation of 0.88 (coding) and 0.92 (general chat) on the bundled snapshot,
though the categories and weights differ.

### Reliability rubric

Weight = independence x contamination resistance x currency. Independence is
1.0 when an independent evaluator ran the benchmark, 0.8 for a third-party
leaderboard, 0.5 for vendor-reported results. Contamination resistance is
higher for private or live tasks and lower for public sets that models have
likely trained on. Currency halves the weight of a benchmark with no new
result in 180 days.

| Category | Benchmark | Independence | Contamination resistance | Why |
|---|---|---|---|---|
| coding | SWE-Bench verified | 1.0 | 0.6 | Run by Epoch AI on real GitHub issues; the task set is public, so training exposure is likely. |
| coding | Terminal Bench | 0.8 | 0.8 | Third-party leaderboard of terminal tasks; submissions pair a model with an agent scaffold. |
| coding | DeepSWE | 0.8 | 0.9 | Recent third-party software-engineering benchmark with fresh tasks. |
| coding | GSO-Bench | 0.8 | 0.8 | Third-party software-optimisation benchmark. |
| coding | Aider polyglot | 0.8 | 0.6 | Third-party leaderboard; public exercises; no new results since late 2025. |
| coding | LMArena WebDev | 0.8 | 1.0 | Live human preference votes on web apps; labs can test privately before release. |
| general-chat | GPQA diamond | 1.0 | 0.6 | Run by Epoch AI; graduate-level science questions, public set. |
| general-chat | HLE | 1.0 | 0.8 | Humanity's Last Exam, run by Epoch AI; hard expert questions, partly held out. |
| general-chat | SimpleQA Verified | 1.0 | 0.7 | Run by Epoch AI; short factual questions, measures accuracy and hallucination. |
| general-chat | SimpleBench | 0.8 | 1.0 | Third-party everyday-reasoning benchmark with a private question set. |
| general-chat | Fiction.LiveBench | 0.8 | 0.9 | Third-party long-context comprehension benchmark. |
| general-chat | Lech Mazur Writing | 0.8 | 0.9 | Third-party creative-writing benchmark graded by a model panel. |
| general-chat | LMArena text | 0.8 | 1.0 | Live human preference votes on chat; labs can test privately before release. |

Image generation has one source (LMArena), so it has no consensus score; the
market says so instead of dressing one source up as agreement.

The frontier on the consensus board is the Pareto set on point scores: nothing
else scores higher for the same or less money. A model off it names the model
that beats it, and says "(within range)" when the win is smaller than the
uncertainty.

## Staleness

Each board states when it was fetched and the newest result it holds. The Aider
leaderboard's newest run in the bundled snapshot is dated 2025-10-03: the
project has not published a newer run since, and the market says so rather than
presenting year-old results as current.

## Sources considered and not used

| Source | Why not |
|---|---|
| OpenRouter models API | Not needed for prices, which LiteLLM supplies under MIT. Its terms for reusing prices in a redistributed snapshot were not reviewed for this release. |
| Artificial Analysis | Needs an API key and has a request limit; a key-gated source cannot back a bundled, offline default. |
| SWE-bench leaderboard | Reports resolution rates without the run cost, so it adds no per-dollar evidence beyond Aider's, and its submissions mix agent scaffolds with models. |
| IFBench, LiveBench | Not adopted: an earlier draft's IFBench figures could not be traced to a dated, per-model results file, so they were dropped rather than shipped. |

## Refreshing

A fresh install is `local_locked` and refuses every refresh before any DNS
lookup or connection. The refusal prints the exact grant, for example:

```
segreant egress apply --apply --mode controlled_cloud --id market-aider \
  --purpose market_refresh --data-class market_manifest --method GET \
  --origin https://raw.githubusercontent.com \
  --path-prefix /Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml
```

The three LMArena boards share one grant (`market-arena`), since they share one
origin and path. A refresh sends a plain GET with nothing about you in it,
writes one file per source under `~/.segreant/market/`, and leaves the previous
copy in place if anything fails. Each source can be switched off with
`segreant features off <key> --apply`, which hides its data even if a refreshed
copy exists.
