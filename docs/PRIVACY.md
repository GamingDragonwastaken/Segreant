# Privacy

Segreant runs on your computer. There is no Segreant account, no analytics and no telemetry. Your ledger, prompts, code and usage are never sent to us, because nothing in Segreant sends them anywhere you did not choose.

## What Segreant keeps on this machine

The ledger records each AI request: when it happened, the provider and model, token counts, the estimated cost, and the project and session it belongs to. It also keeps the outcome signals you set up, so it can show what the spend produced.

Some of what it keeps is your own material rather than a measurement, and it stays on this machine with everything else:

- the working folder a request came from, which is how spend is matched to a project;
- the user label a tool reports;
- the first line of each commit message it matches to spend;
- proposed code lines, used to check whether AI suggestions were kept. Turning on `metadataOnly` stops new ones being kept; Clear proposals in Settings deletes the ones already kept.

## Your provider keys

When a tool sends a request through Segreant, the request and its API key go to the provider you configured, exactly as they would without Segreant. Segreant does not store your provider keys.

## What leaves this machine

Your AI requests go to the provider you configured.

Segreant keeps its own price list current by itself. The first time it prices a request for a model its rate card does not know, a running Segreant downloads the public price list (LiteLLM's `model_prices_and_context_window.json` on GitHub), at most once an hour. It is a plain download of a public file: it sends nothing about you, your requests or your usage, and nothing is stored anywhere but on this machine. GitHub, which hosts the file, sees the download as it would any other. `segreant pricing --auto off` stops it, and the start banner says when it is on.

Everything else is off until you turn it on, and `segreant egress status` lists what is allowed:

- refreshing market data, which sends nothing about you;
- downloading a baseline from an address you give;
- alert summaries to a webhook you set, never prompts, code or keys;
- pulling your costs from OpenAI with an admin key, read from your environment for that one request and never stored;
- a numeric spending summary sent to a team server you run;
- a session excerpt sent to a hosted judge, only if you configure one.

## Keeping and deleting

Captured suggestions older than 30 days are deleted each time Segreant starts. Request records are not deleted on their own: after 180 days they are due for deletion, and `segreant prune --apply` deletes them along with any expired suggestions. You can change both periods in Settings.

To remove everything, delete the folder Segreant keeps its data in. That is `.segreant` in your home directory unless you set `SEGREANT_HOME` or `SEGREANT_DB`, in which case delete what those point to as well; `segreant doctor` prints the database path in use.

To take your records with you, `segreant pack export --out <file>` writes them to a file on this machine.

## Your providers have their own terms

Segreant decides what it sends. How your AI provider, or any webhook or server you add, stores what it receives is governed by their terms, so read those before sending sensitive work.

## Questions

Ask on the project’s GitHub issues. Report a security problem privately, as `SECURITY.md` describes. The full technical account of every path is in `docs/DATA-BOUNDARIES.md`.

This file is generated from `src/dashboard/web/app/core/privacyText.ts`, which the dashboard also renders at `#/privacy`. Change the words there.
