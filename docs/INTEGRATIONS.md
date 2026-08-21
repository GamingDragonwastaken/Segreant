# Integrations — wiring Fiscus to your tools

Fiscus meters and caps AI spend by sitting **in the path** as a local proxy.
There is no per-tool plugin to install: any tool that (1) speaks the OpenAI or
Anthropic HTTP API and (2) lets you set a **base URL** is wired by configuration
alone. One running proxy meters *every* such tool at once — your IDE, your CLI
agent, your scripts — and nothing about your prompts or code ever leaves the
device.

```
your tool ──(base URL)──▶ Fiscus :8090 ──price · cap · log──▶ provider
```

The mental model: **point the tool's base URL at Fiscus, and point Fiscus's
upstream at the provider.** That's the whole integration.

---

## The two knobs

| Knob | Where | What it does |
|---|---|---|
| Your tool's base URL | the tool's config / env | sends the tool's traffic to Fiscus instead of straight to the provider |
| `upstreams.openai` / `upstreams.anthropic` | `~/.fiscus/config.json` | where Fiscus forwards, after metering |

For native OpenAI or Anthropic, you only touch the first knob — the upstream
defaults are already correct. You touch the second only to meter an
OpenAI-*compatible* provider that isn't OpenAI (Gemini, OpenRouter, DeepSeek,
Ollama, …).

### The base-URL `/v1` rule (read this once)

Fiscus forwards the **incoming path** onto the upstream base. So the upstream
base must contain the provider's version segment, and the tool's base URL must
*not* duplicate it:

- **OpenAI** (default upstream `https://api.openai.com`): tool base URL =
  `http://localhost:8090/v1` → forwarded to `…/v1/chat/completions`. ✅
- **Gemini** (upstream `…/v1beta/openai`): tool base URL = `http://localhost:8090`
  (**no `/v1`**) → forwarded to `…/v1beta/openai/chat/completions`. ✅ A `/v1`
  here would double the version and 404.

Rule of thumb: **whatever version segment lives in `upstreams.openai`, leave it
off the tool's base URL.**

---

## Metering Gemini on the free tier (the $0 test)

This is the recommended way to watch real agent traffic accrue without spending a
cent — Gemini 2.5 Flash is free-tier, and it doubles as proof of Fiscus's
multi-provider pricing.

**1. Point Fiscus's OpenAI upstream at Google.** `~/.fiscus/config.json`:

```json
{
  "upstreams": {
    "openai": "https://generativelanguage.googleapis.com/v1beta/openai"
  }
}
```

**2. Start the proxy:** `fiscus start` (proxy on :8090, dashboard on :8091).

**3. Set your key in the environment** — this is the one secret Fiscus never
stores and never needs to see. Get a free key from Google AI Studio, then:

```powershell
# PowerShell (persists for new shells)
setx GEMINI_API_KEY "your-key-here"
```

Open a **new** terminal after `setx` so the variable is visible.

**4. Run a tool through it** (opencode recipe below) with model
`gemini-2.5-flash`. Traffic is metered into your real ledger; watch it at
**http://localhost:8091** or with `fiscus today`.

**To revert to real OpenAI later:** set `upstreams.openai` back to
`https://api.openai.com` (or delete `config.json` to restore all defaults).

> **Pricing:** Gemini rates are built in and verified. Rates drift — keep them
> current with `fiscus pricing --refresh` (see [pricing](#keeping-pricing-current)).

---

## Per-tool recipes

### opencode

opencode reads `~/.config/opencode/opencode.jsonc`. Add a provider (this is the
exact shape Fiscus ships set up):

```jsonc
{
  "provider": {
    "fiscus": {
      "name": "Fiscus → Gemini (metered)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8090",
        "apiKey": "{env:GEMINI_API_KEY}"
      },
      "models": {
        "gemini-2.5-flash": { "name": "Gemini 2.5 Flash (via Fiscus)" }
      }
    }
  }
}
```

The `{env:GEMINI_API_KEY}` substitution keeps your key in the environment, never
in the file. In opencode, run `/models` and pick the Fiscus provider's model.

### aider

```bash
# bash / zsh
export OPENAI_API_BASE="http://localhost:8090/v1"   # native OpenAI: keep /v1
export OPENAI_API_KEY="$OPENAI_KEY"
aider --model gpt-4o
```

For Gemini-via-Fiscus, set `OPENAI_API_BASE="http://localhost:8090"` (no
`/v1`), `OPENAI_API_KEY` to your Gemini key, and `--model gemini-2.5-flash`.

### Cursor

Settings → Models → **Override OpenAI Base URL** → `http://localhost:8090/v1`.
Cursor's verification call must succeed, so the proxy must be running. Your key
goes in Cursor as usual; Fiscus forwards it untouched.

### Continue / Cline (VS Code)

In the model config, set `apiBase` (Continue) or the OpenAI-compatible base
(Cline) to `http://localhost:8090/v1`.

### Antigravity

Antigravity supports custom OpenAI-compatible models — set the model's base URL
to `http://localhost:8090/v1` (or `http://localhost:8090` when routing through a
non-OpenAI upstream like Gemini, per the `/v1` rule above).

### Claude Code / Anthropic SDK

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:8090"
```

No upstream change needed — `upstreams.anthropic` already points at
`api.anthropic.com`.

### Any OpenAI / Anthropic SDK (your own scripts)

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8090/v1", api_key="…")
```

---

## Beyond one provider, from one proxy

To meter several OpenAI-compatible providers without restarting, enable
Do not route providers per request with `x-fiscus-openai-base`: current Fiscus
builds ignore that legacy header because the proxy forwards provider credentials.
Set one trusted OpenAI-compatible destination in `upstreams.openai` instead.

```
X-Fiscus-OpenAI-Base: https://openrouter.ai/api
```

It's **off by default on purpose** — that header forwards your provider key to the
URL it names, so Fiscus only honors it when you opt in. For a single provider,
just set `upstreams.openai` and skip the flag.

**Pricing follows the model, not the wire.** A `gemini-*` model arriving over the
OpenAI path is priced at Google's real rate, a `claude-*` via OpenRouter at
Anthropic's — the rate card resolves by model family across providers, so a
provider you route through one transport is still priced correctly.

---

## Keeping pricing current

Pricing is a core dependability, and provider rates change. The table ships
bundled (works offline) and can be refreshed in place:

```bash
fiscus pricing             # source, age, model count, staleness
fiscus pricing --refresh   # pull the latest rates (a plain GET; sends nothing about you)
```

A refreshed table is written to `~/.fiscus/pricing/models.json` and overrides
the bundled one. A malformed download is rejected and your current table is kept
— a bad refresh never downgrades your data.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `404` from the provider | double `/v1` (tool base URL **and** upstream both carry a version) | drop `/v1` from the tool base URL when the upstream already has a version segment |
| `401 / 403` | key not in the environment, or wrong key for the upstream | confirm the env var is set in the shell that launched the tool; open a new shell after `setx` |
| Tool's "verify" fails | proxy not running | `fiscus start`, then retry |
| Cost shows `estimated` | model id not in the rate card | `fiscus pricing --refresh`, or check the model name |
| Nothing in the dashboard | tool didn't route through the proxy | re-check the base URL; `fiscus today` to confirm requests land |
