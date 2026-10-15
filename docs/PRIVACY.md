# Privacy

Segreant runs on your computer. There is no Segreant account, no analytics and no telemetry. Your ledger, prompts, code and usage are never sent to us, because nothing in Segreant sends them anywhere you did not choose.

## What Segreant keeps on this machine

The ledger records each AI request: when it happened, the provider and model, token counts, the estimated cost, and the project and session it belongs to. It also keeps the outcome signals you set up, so it can show what the spend produced.

Some of what it keeps is your own material rather than a measurement, and it stays on this machine with everything else:

- the working folder a request came from, which is how spend is matched to a project;
- the user label a tool reports;
- the first line of each commit message it matches to spend;
- proposed code lines, used to check whether AI suggestions were kept. Turn on `metadataOnly` and none are kept.

## Your provider keys

When a tool sends a request through Segreant, the request and its API key go to the provider you configured, exactly as they would without Segreant. Segreant does not store your provider keys.

## What leaves this machine

Your AI requests go to the provider you configured. Everything else is off until you turn it on, and `segreant egress status` lists what is allowed:

- refreshing the public price list or market data, which sends nothing about you;
- downloading a baseline from an address you give;
- alert summaries to a webhook you set, never prompts, code or keys;
- pulling your costs from OpenAI with an admin key, read from your environment for that one request and never stored;
- a numeric spending summary sent to a team server you run;
- a session excerpt sent to a hosted judge, only if you configure one.

## Keeping and deleting

Request records are kept for 180 days and captured suggestions for 30 days. You can change both in Settings. Old suggestions are cleared each time Segreant starts; `segreant prune --apply` deletes everything past its period. To remove everything, delete the `.segreant` folder in your home directory.

To take your records with you, `segreant pack export --out <file>` writes them to a file on this machine.

## Your providers have their own terms

Segreant decides what it sends. How your AI provider, or any webhook or server you add, stores what it receives is governed by their terms, so read those before sending sensitive work.

## Questions

Ask on the project’s GitHub issues. Report a security problem privately, as `SECURITY.md` describes. The full technical account of every path is in `docs/DATA-BOUNDARIES.md`.

This file is generated from `src/dashboard/web/app/core/privacyText.ts`, which the dashboard also renders at `#/privacy`. Change the words there.
