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
| LiteLLM model price list | Public list prices per token (and per image, where listed) | MIT (the LiteLLM repository's licence) | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |

Attribution: benchmark data © the Aider project; leaderboard data © LMArena,
used under CC BY 4.0; price data © BerriAI/LiteLLM contributors. The market
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
