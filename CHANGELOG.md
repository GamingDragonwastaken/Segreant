# Changelog

Segreant is pre-1.0. 0.1.0 (2026-10-08) and 0.2.0 (2026-10-18) are published
on npm; 0.2.0 is tagged `v0.2.0` with a GitHub release. This file records user-visible changes
from the point at which release discipline was formalized; Git history remains
the authoritative record for earlier development. The verification procedure in
`docs/RELEASE-PROCESS.md` remains the release authority — an entry here is not
release evidence.

The format follows Keep a Changelog and releases will use Semantic Versioning.

## [Unreleased]

- **Releases are published from GitHub Actions with npm provenance.** From this version on, each published version carries a provenance attestation naming the repository, the workflow and the exact commit it was built from, and no npm token exists that could be stolen to publish a fake version. Check it on the package page or with `npm audit signatures`.
- **A running Segreant picks up a price-list refresh without a restart.** When `segreant pricing --refresh` (or another Segreant) updated the price list, a proxy or dashboard that was already running kept pricing with the old list until it was restarted. It now notices the new list within a second. A refresh still in progress, or one that failed, changes nothing, and a reprice never switches lists partway through.
- **A fresh install says where usage comes in.** With nothing recorded, Statement and Spend showed four honest $0.00 and "not established" figures and no next step. Both pages now say no usage has been measured and link to Data, where the usage Claude Code, Codex and other tools have already logged on this machine can be brought in. The note goes away once a metered request is recorded (an imported bill, a cost split or a value read does not remove it, since it speaks only for measured usage), and never shows on sample data or after retention has deleted requests.
- **`segreant pricing set <model> --free` is refused for a model the rate card prices.** A cap counts a free model's requests as $0, so marking a cloud model free (for example `claude-sonnet-4-6`) would have let real spend through uncounted. The refusal names the card's rate. A model that really runs locally under a card name can still be marked free with `--free --force`. The dashboard refuses it without an override. The same rule holds when a request is priced: a free price set without `--force` never applies to a model a rate card prices, even one the card learned after the price was set, so the card's price counts.

## [0.2.0] - 2026-10-18

- **The first-run chooser's sample figures say they are examples.** "$59.16 list cost (estimate)" showed how each wording reads, but it appeared on every install, including one with no data, as if it were the reader's spend. Both samples now begin "e.g.".
- **Found by two independent reviews of the release candidate.**
  - **`segreant reprice` keeps the record of what it replaced.** Each price change is logged with the price it replaced, but the log recorded that earlier price's basis as unknown on every reprice. It now records the earlier basis, rate card and match.
  - **A reprice no longer prices a request whose usage was never captured.** A response cut off at the resource limit is recorded with no token counts and an unknown cost. A reprice used to turn it into a confirmed $0 list price. Such requests are now left as they are; an unpriced request that does have token counts can still be priced by a price you declare.
  - **Cache writes are priced at the 5-minute rate when the log does not say.** Claude Code entries without a 5-minute / 1-hour breakdown were priced at the 1-hour rate (2× input instead of 1.25×), and both those and the proxy's choice were stored as if seen. The duration is now recorded only when the provider reported a breakdown.
  - **A config change no longer erases a malformed egress section.** Saving a cap or a plan price while the egress section was malformed replaced it with an empty one, and the rules were lost. The section is now kept as it is until you repair it, and a refused request says how to repair it instead of calling the official API "not built in".
  - **`segreant connect opencode` tells a plain-HTTP gateway the truth.** A `http://` gateway on another machine was told its requests "go out with no extra step". It now says Segreant forwards only to HTTPS, or to plain HTTP on this machine.
  - **The sample data can show a reprice preview.** In demo mode the dashboard's reprice preview was refused along with applying it.
  - **`segreant pricing set` says how a cache it was not given is priced.** A rate without `--cache-write`, `--cache-write-1h` or `--cache-read` prices those parts at the usual multiples of your input price (1.25×, 2×, 0.1×); the confirmation now names them, so they are not taken for prices you set.
  - **A mistyped `--cache-write-1h`** is now corrected to `--cache-write-1h`, not to `--cache-write`, which sets a different rate.
- **The proxy's live log shows the spend your cap counts.** Each request line ended "today $51.29" even with a $25 daily cap and requests still going through, because that total included spend imported from tool logs, which the cap does not count unless you turn it on. With a cap set the line now reads "today $3.00 of the $25.00 cap (+$48.00 imported, not counted)".
- **Models missing from the rate card get real prices.** Segreant priced any model its card did not know at a generic $3 in / $15 out per million tokens. For claude-haiku-5-5 (list price $0.10 / $0.50) that read 30 times too high; for a premium model it read too low, including against a budget cap. Each request is now priced by the first of these that knows its model:
  - **A price you set.** `segreant pricing set <model>` takes a rate, `--like` another model, or `--free` for a local model. It is shown as "your price", never as list price.
  - **The rate card.** The bundled card now carries the 63 models the public price list had and it lacked, including claude-haiku-5-5 and the gpt-5.x-codex models.
  - **A lookup on first sight.** The first time a running Segreant meets a model the card does not know, it downloads the public price list: at most once an hour, never in the request's path, sending nothing about you. New requests then get the list price. Requests already recorded keep their estimate until `segreant reprice --apply`.
  - **The nearest model, then the generic rate,** both marked as estimates, as before.
  - **`segreant pricing unknown`** lists the models still priced by a guess. `segreant pricing --auto off` turns the lookup off.
- **`segreant reprice --apply` works on a ledger with exact amounts.** Re-pricing a request recorded at an estimate refused with "requires an exact replacement amount" or "must use the same currency and basis": prices learned from the public list carried no exact decimals, and a correction could not move an estimate to a list price. Learned prices now carry their decimals, and a correction keeps the basis it was recorded under (an estimate, corrected to the exact figure). The request itself says which rate priced it.
- **Prices you set can be reviewed and removed in the dashboard** ("Your prices" in Unpriced models), with a preview before anything changes. A running Segreant also picks up `segreant pricing --auto off` without a restart.
- **OpenAI and Anthropic work on a fresh install, with no egress commands.** A new install refused every proxied request with a 403 until two `segreant egress` commands were run, though the traffic was the user's own and already going to that provider. Requests to `https://api.openai.com` and `https://api.anthropic.com` (GET or POST under `/v1/`) are now built in, like the price list, and both built-in routes hold in `controlled_cloud` mode too, so adding a webhook rule never cuts off your provider. Everything Segreant would send on its own (webhooks, team rollups, hosted judging) stays off until you allow it. A request to any other upstream is refused with the one command that allows it, and a running Segreant follows that rule (and any other egress change) on the next request, with no restart. **If you upgrade from 0.1.0:** switching to `local_locked`, or disabling the `openai-inference` rule, no longer stops forwarding to the official OpenAI or Anthropic API. To stop it, stop the proxy or point the tool back at the provider.
- **The default egress lock lets Segreant download its own price list.** `local_locked` refused every non-loopback address, so in a default install the rate card could never update, not even with `segreant pricing --refresh`. It now permits a GET of the public price-list file, receipted like any cloud route, in either mode (see the provider-routes entry above, which also builds in the official provider APIs).
- **Three figures that could still mislead, found in review.**
  - **`segreant export --economic`:** requests refused before they were sent appeared as `legacy_unknown` with `no_exact_economic_event`, as if a cost were missing. They cost nothing and are no longer exported, the same rule the economic totals already follow. The confirmation counts the rows actually written and says how many refusals were left out.
  - **The bill-comparison coverage in `segreant billing`:** a comparison covering 99.6% of metered spend was shown as 100%. Only the whole now reads 100%. A share just below that shows one decimal, capped at 99.9%, and a share under 0.1% reads "<0.1%".
  - **A cap refusal:** when spend passed the cap by less than a microdollar, both figures printed alike. The refusal now says "just over $5.000000".
- **`segreant --watch` and `segreant --serve` with no command are reported.** They used to show the home view and exit 0, doing nothing. Like any other option a command does not use, they now say so and exit 2.
- **`budget --recommend` when your cap already matches.** It asked whether $6 was better than your current $6 and blamed partly observed days for having no answer. It now says your cap already matches. If the recommended soft warning differs from yours, it says so and gives the one command that sets it.
- **The dashboard keeps focus where you put it.** If the page finished loading after you had used "Skip to content" or clicked into the page, it moved focus back to the page heading. It now moves focus only if you have not.
- **Four first-run snags on Windows, found by a usability panel of agents using Segreant for the first time.**
  - **A busy port:** `segreant start` crashed with Node's unhandled-error stack trace when a port was taken, usually by a Segreant already running. It now names the port, says how to check for a running Segreant, gives the flag for another port and exits 1.
  - **A config file saved from Windows PowerShell:** `Set-Content -Encoding utf8` writes a byte-order mark, and Segreant refused the file as invalid JSON. The mark is now skipped.
  - **`segreant --demo`:** this said "Unknown command" although the help says `--demo` works on any read command. Flags with no command now go to the home view.
  - **A refusal hid the overshoot:** a day that reached $5.004 against a $5 cap was refused as "$5.00 of $5.00". The refusal now adds digits, down to the microdollar, whenever two decimals would make the spend look equal to the cap.
- **Four places where the words said less than the data, from the same panel.**
  - **`segreant billing`:** it said "not_reconciled" even when a bill comparison was recorded. It now shows the latest comparison's provider, metered and unexplained amounts. It also says how much of Segreant's metered spend in that period the comparison covers; on the sample data that is one project's bill, about 4% of the period's spend.
  - **`segreant alloc runs`:** recorded splits were labelled by date alone, so a split ending at 06:51 read as covering the whole day, and re-running those dates gave a different total. Bounds that are not midnight UTC now keep their time, and the label says the end is exclusive.
  - **The `start` banner:** it said `launch` "starts unmetered with a warning" when the proxy is down. With a cap set, launch refuses instead, and the banner now says so.
  - **`segreant connect api`:** it explained the client side only. It now says where requests go and how to point Segreant at another OpenAI-compatible provider.
- **`segreant budget --recommend` answers in plain words.** After recommending a cap, it printed a decision record full of internal claim ids. That record also said a selection rule "selects keep_current", which read as contradicting the recommendation just above it. It now says in one sentence whether the evidence shows the new cap doing better than the current one, and `--detail` prints the full record.
- **The FAQ no longer calls the fallback rate conservative.** A model missing from the rate card is priced at $3 in and $15 out per million tokens. About a third of the models on the card cost more, so the FAQ now says plainly that a premium model the card does not know reads lower than it costs, including against a cap.
- **A request your cap refused no longer counts as a missing price.** Segreant recorded a refused request as "not priced", the label for a request whose cost is unknown. Every refusal after the first therefore said "1 of 835 requests in this window are unpriced", and `today` listed refused requests as "not priced: claude-opus-4-8 (no rate applies)". A request refused by a cap or an egress rule never left the machine, so its cost is known to be zero. It is now recorded as `not_sent` and listed as "refused before reaching the provider (no charge)", and the exact spend projection behind the cap no longer counts it. A timed-out or dropped request may have reached the provider, so it stays "not priced". Rows recorded before this change keep their original label: Segreant never rewrites how a past amount was recorded.
- **An egress rule refused in Git Bash now says why.** Git Bash rewrites `--path-prefix /v1/` into `C:/Program Files/Git/v1/` before Segreant sees it, and the refusal only said the prefix was malformed. It now shows the value it received and says to put `MSYS_NO_PATHCONV=1` in front of the command or use PowerShell or cmd. The FAQ has the same entry.
- **`segreant yield` no longer reports a cost of $0 for spend that retention deleted.** A commit whose attribution window lost request rows to `prune` was priced at whatever spend survived, often $0.00, and its retained lines then counted toward the per-dollar figures. Such commits now show `pruned` for cost and `spend pruned` for status. They are left out of AI cost, retained lines per dollar, cost per retained line and effective spend, and the report says how many. Retention and revert figures still cover every matured commit, because they come from git. The JSON report adds `matured.spendWindowTruncatedCommits`.
- **A cap set from the terminal now stops a running proxy.**
  - **Before:** `segreant budget --daily N` printed "Budget updated", but a proxy that was already running kept forwarding until it was restarted. Only a cap saved in the dashboard took effect at once. A budget made invalid by hand while the proxy ran was not noticed either. Found by an end-to-end test against a local stub provider: two requests over a $0.05 cap went through.
  - **Now:** the proxy re-reads the budget within half a second of `config.json` changing, whoever changed it. While the file is invalid, every request is refused without being sent; deleting the file keeps the cap in force.
  - **Under load:** 50 concurrent streams went past a cap by 42 requests ($0.031) before the rest were refused, because requests already in flight still finish. The docs now state that bound.
- **Every command is in the help and the guide.** `segreant help all` was missing `alloc` (cost-centre allocation) and `statusline`, and `docs/GUIDE.md` was missing ten commands, among them `plan`, `quota`, `launch`, `market` and `outcome`. Both said bare `segreant` shows `guide`; it shows this month, your plans and what stayed in the code. A test now fails if a command is added without both.
- **Command-line-only jobs say how to do them, not that a screen is coming.** Their drawers said the screen was "not built yet"; they now say the job runs from the command line and give the command to copy. A test fails if shipped dashboard text promises an unbuilt feature.
- **The bill comparison now works on real OpenAI traffic.**
  - **Before:** a request through Segreant records its exact price, and per-token prices often go finer than a millionth of a dollar (gpt-4.1-mini, 1,234 tokens in and 567 out, is $0.0014008). The comparison refused the whole route on the first such request, so almost no real user could compare a bill. Seeding the sample bill found this.
  - **Now:** each day is added up exactly, and only the day's total is rounded to the millionth (half to even). The comparison says so wherever it appears: the terminal, the Close page, the Statement and its CSV, and the recorded evidence.
- **The sample data now has a provider bill and a cost-centre split.**
  - **The bill:** a generated export for its OpenAI route, compared with what Segreant measured.
  - **The split:** three cost centres with a rule each, and one recorded split of the fortnight.
  - **The Statement:** all four figures are now filled, each with its own basis.
  - **Labelled as generated:** billing output in the terminal and the billing CSV say the figures are sample data.
- **A session's commits are only the ones git reported.**
  - **Before:** text that merely looked like a commit counted as one, for example a test fixture an agent read or wrote, or a comment explaining the format. On the owner's real logs that was 26 of 153 matches.
  - **Now:** a commit line counts only where git's own output starts: the start of a tool result or a new line in it. Commits recorded by the older reader are dropped once, and the next import reads every log again. On a fresh import of the same logs, all 98 recorded commits exist in a local repository.
- **A cap suggestion now explains itself when all your spend was imported.**
  - **Before:** someone who only imported agent logs was told by `segreant guide` that the recommendation "uses your observed spend history". `budget --recommend` then said there was not enough history, and the Protect page showed $0.000000 for a typical, busy and worst day.
  - **Now:** the guide offers the recommendation only when there is spend through the proxy, which is what a cap governs. The advisor states the imported total at list price and why it does not count, and gives the setting that would count it. The Protect page labels the card "no proxied spend", leaves out the zero rows, and shows the command on one line.
- **The value commands answer in seconds, and say so when there is nothing to measure.**
  - **Speed:** `realize`, `roi` and `frontier` took about a minute each on a real repository, because they read the full diff of every commit. That diff is now read only when there is a captured proposal to compare it with. On 1,126 commits they now take 11 to 16 seconds and give the same results; `discover` went from 86 to 33 seconds.
  - **No spend yet:** before any AI spend was recorded, the same commands still read 90 days of git history and printed 0% realized, an RoI of 0 and $0.00 per commit. They now say there is nothing to measure yet and name `segreant scan --setup` and the demo.
  - **Commit evidence:** 147 commits said "N lines in 0 files"; the file count now comes from the same record as the line count.
- **A bar on the Spend chart always shows the session it opens.** When the costliest session in that stretch was past the first twelve rows, it opened with no row selected; the list now expands to show it, as it also does for the session the page opens on.
- **Dollar amounts in the terminal are grouped and signed correctly:** $4,195.19 rather than $4195.19, and a $5 credit reads -$5.00 rather than $-5.000000.

- **Fixes from a fourth independent review** (Codex, PRs #125 to #132). Each finding was checked against the code and pinned by a test:
  - **The Spend page's outcome breakdown adds back to the spend.** Each session was rounded to the microdollar before being added, so a thousand $0.0014008 sessions showed $1.401 of outcomes for $1.4008 spent.
  - **A ledger whose requests were pruned is not "no spend recorded".** The value commands now reach the stored report instead.
  - **The cap guidance reads the spend the cap actually enforces.** It could say no request had gone through the proxy while the cap was blocking on proxied spend; it now uses the guard's own figure and counts requests.
  - **With imported spend counted toward the cap, the guide says so** instead of calling it proxy spend.
  - **Follow-ups from review comments on #131 to #135:**
    - The outcome breakdown and the totals now come from one exact sum, so even interleaved fine-grained prices add back to the reported total.
    - A cap edited while the proxy was starting is read on the first request.
    - An unreadable or invalid `config.json` refuses requests only until it is repaired, without a restart.
    - A filesystem error reading it fails closed rather than being treated as a deleted file.
    - `realize`, `roi` and `frontier` report a path that is not a repository before anything else.
    - A command containing placeholders says to fill them in before running it.
    - The guide now documents `help` and `--version`.

- **Fixes from a second independent review** (Codex `gpt-6.1-sol`, PRs #121 to #124). Each finding was checked against the code and pinned by a test:
  - **Copied commands stay literal in PowerShell.** PowerShell also ends a quoted value on a curly apostrophe (as in O’Brien), so the rest of a pasted command could run. Such values now show no command, and a value starting with `@` or `-` is quoted or withheld.
  - **The Spend page stays fast on a long history.** Matching ten thousand logged commits took about 30 seconds; it now takes well under one.
  - **A short commit id that fits two measured commits matches neither,** instead of borrowing another repository's outcome.
  - **Days after a midnight clock change stay on the chart.**
  - **A request priced by a near-match rate still shows its context.** Only a reply that went through with no token counts is treated as unknown.
  - **A model actually named "other" is listed as a model.** Other models are a separate figure.
  - **Split costs add back exactly,** to the microdollar.
  - **`segreant home` and `segreant value` give each piece of work its own next-check date.**
  - **The privacy statement is exact:**
    - old requests are deleted by `segreant prune`, not automatically;
    - `metadataOnly` stops new code captures, and Clear proposals removes old ones;
    - deleting everything includes any `SEGREANT_HOME` or `SEGREANT_DB` location.
  - **The README says the demo's bill comparison and cost-centre pages open empty.**
- **The griffin has its own antique gold in the dark theme,** chosen to sit beside the ember accent rather than compete with it.

- **The Spend page now shows its sessions.** A Workbench sits above the breakdown, for the chosen range:
  - **Six figures across the top:** list cost, requests (with sessions and tools), context sent, the share read from cache, replies refused (429) or failed (5xx), and spend outside any session.
  - **A day-by-day chart, stacked by model.** It uses one scale whose gridlines are values the axis reaches, a legend with each model's total, and a readout that names a day's split when you point at it. Choosing a bar opens that day's costliest session.
  - **What the session spend came to:** kept, not kept, disputed, too early to tell, not matched to a measurement, or no commit linked. The same rule files each commit here and on the Statement. A session reaches a commit only through its own log, and a session with several commits splits its cost evenly. The card says both.
  - **Every session in one table:** requests, the context the first and last requests sent (drawn on one scale for every row), list cost and outcome. Beside it, the chosen session's context request by request, with marks where a request was refused or failed. Also listed: the commits it made, and observations drawn only from its own figures.
  - **Read from the new `GET /api/sessions`.** Requests with no session id count in the chart and totals, and the page names them. Requests whose usage was never reported stay out of the context figures.
  - **The sample data's four coding sessions each end in a commit from the measured work,** so the page shows a kept, a not-kept and a too-early commit. They now send context that grows as a real session does.

- **Fixes from an independent review of the last eleven PRs.** Codex (`gpt-6.1-sol`) reviewed #110 to #120 read-only. Each finding was checked against the code and pinned by a test:
  - **Copied commands are literal.** A drawer's "same thing, as a command" quoted values for JSON. Pasted into a shell, a name like `$(whoami)` ran as a command, so it saved a different value from Apply. Values are now single-quoted, and a value no quoting can carry shows no command at all.
  - **Each piece of work is placed by its own check.** The Statement assumed every measurement used the 14-day window. Measurements now record their window. Older ones are placed by the default, and the card says how many.
  - **Disagreeing evidence is "disputed", not "not kept".** When a check both passed and failed, the work was counted as not kept. It now has its own count on the Statement, in its CSV, and in `segreant value` and `segreant home`.
  - **The four figures update after a drawer saves,** as they already did after a page save.
  - **Switching a drawer between modes no longer hides typed values.** The fields show exactly what Apply will send.

- **A privacy statement, one click from every page.**
  - **Where:** the footer now links to Privacy, a page the dashboard serves from this machine. It says in plain words what Segreant keeps, what leaves and only when you turn it on, how long records are kept, and how to delete them.
  - **The same words everywhere:** `docs/PRIVACY.md` carries identical text for the npm page and the site, and a test fails if the two ever differ.

- **Cost centres and the provider scope are finished in the dashboard.** Both now read "in the GUI" on the parity map, which earned it rather than being relabelled:
  - **Cost centres:** a drawer adds, renames, changes the owner of, or archives a cost centre: everything `segreant alloc centre` does. Renaming was impossible before, because the Allocate page derives the id from the name. The preview names any rule that still points at a centre you are about to archive, and says when a name belongs to an archived centre, which saving would rename but not reopen.
  - **Provider scope:** a drawer declares or clears the OpenAI organisation and project, with the project optional, as on the command line. Its preview is the server's own dry run.
  - **Open from the map:** any row on the parity map the dashboard can run now has an Open button, so the map shows what can be done and opens it.
- **Running an allocation, adopting a cost export and reconciling also finish in drawers.** Each is opened from the parity map and now reads "in the GUI":
  - **Run an allocation:** last month, this month or any chosen days. The preview is the split itself, centre by centre, with what stayed unallocated and why. A split that does not add up to the spend it divides is refused.
  - **Adopt a provider export:** choose any imported export. The preview is the server's adoption plan: what matches your project, what is left out, and any refusal.
  - **Reconcile:** if the comparison is not ready, the drawer lists the steps still to do. Otherwise it previews the comparison with your daily threshold and records it under that same threshold.
  - **One wording:** the drawers and the Allocate and Close pages share their period and comparison wording, so a split or a comparison reads the same in both places.
- **Allocation rules finish in a drawer too, and a rule can carry an owner and a note.**
  - **The drawer:** adds a rule or a new version of one, or revokes one, previewing first. The preview states the rule as a sentence, the id it is saved under, whether it replaces a current version, its place in the order, and its dates.
  - **The same form:** it uses the same fields as the Allocate page, so a rule written in either place is the rule `segreant alloc rule` writes. With no cost centre yet, the drawer says so first instead of offering a form that can only fail.
  - **Owner and note:** both forms now have the `--owner` and `--note` the command always had.
  - **A fixed choice:** switching the method away and back no longer shows the first centre while keeping the one chosen before.
- **Apply works on the first click.** In every drawer, typing a value and then clicking Apply did nothing the first time. Leaving the field re-ran the preview and disabled Apply under the pointer. Apply also used to drop keyboard focus to the page body after saving; it now hands focus to Close, and the result is announced as before.

- **The Statement now says what each month produced.**
  - **Before:** the fourth card read "not computed per calendar month".
  - **The rule:** work now counts in the month its 14-day check falls, as kept, not kept, or no signal. Work still inside its 14 days is listed as too early to tell, with the date of its first check.
  - **No git on load:** the counts come from the last stored measurement, so opening a month never runs git.
  - **Spend, not value:** the dollars beside each count are the list cost of that work. A value figure needs an hourly rate and stays on the Value page. In the CSV the realized rows carry counts and name the spend in the note, so nobody can sum them as value.
  - **For integrators:** `/api/statement` `realized` changes shape (`standing` is now `judged_in_month` or `none_judged`, with `kept`, `notKept`, `unknown`, `tooEarly`, `windowDays` and `measuredAt`).

- **Choose what you see.** Settings has a new "What you see" card:
  - **Density:** Comfortable or Compact. Compact tightens the spacing scale on every page.
  - **The four figures:** you can fold the four-figure strip away from the money pages.
  - **Explanations:** you can hide the short explanation under each page title.
  - **The top bar:** you choose which of the six jobs it shows. A hidden job still opens from Settings and by its address, and the job you are in always shows.
  - **Display only:** these choices never change a figure, and they are kept in this browser only, like the theme.

- **A screen reader is told where it is and what happened.** Running NVDA 2026.2 over the accessibility script found three defects:
  - **Lost focus after the welcome screen:** after the first-run choice, focus fell to the bottom of the page structure, so NVDA started again from the top. It now lands on the chosen page's heading.
  - **Unannounced messages:** each job's status line was hidden until it had a message, and a live region that appears already holding its text is usually not announced. "Saved", the Close check result and every refusal were shown but never spoken. The status line now stays in place, empty and invisible, until it has something to say.
  - **Raw month key read aloud:** while a month loaded, its label briefly read the raw key ("2026-09") before the name. It now reads the name once.
  - `test/dashboard-announcements.browser.mjs` pins all three.

- **Orange for what you act on; gold where it means something.**
  - **Ember orange:** buttons, the current job, selected figures, focus rings, links and next steps now use an ember orange (`--accent`, #f0883e on dark, #b04a14 on light). It sits beside the griffin's gold as one warm family.
  - **Gold:** the griffin is unchanged. Gold now marks only the brand and genuine cautions ("partly compared", "no cap set"), so it stands out again.
  - **Empty states:** "not established" and "not per month" are states, not warnings. They now show as neutral dashed pills instead of gold ones.
  - **Red:** waste red moved off orange's hue (#e25d4a to #f0566a on dark, #a83625 to #b3243f on light), so "not kept" never reads as "press here".
  - **Contrast:** every new pair passes WCAG AA. Accent text is 8.9:1 on dark and 5.5:1 on light; button text is 7.1:1 and 5.5:1.

- **The first screen uses the same words as the rest.** The two choices on the welcome screen showed sample figures in retired wording: "$59.16 · measured from metered requests" and "$59.163468 · local_list_price". They now read "$59.16 list cost (estimate)" and "$59.163468 list cost (estimate)", the guide's words. A screen reader reads these samples as part of each choice, so they were the first words a new user heard.

- **The dashboard talks like a person.**
  - **Legal words gone:** the four-figure strip and the Value page used words like "inspect claim", "four evidence standards", "unsubstantiated", "unadjudicated", "Gate verdicts" and "your verdict". They now say what they mean.
  - **The four figures:** the strip is labelled List cost (estimate), Billed cost, Allocated cost and Value (kept work), not METERED, BILLED, ALLOCATED and REALIZED.
    - Billed cost reads "no invoice imported. Import one under Close to see billed cost beside list cost."
    - Allocated cost reads "split by your rules, for reporting (not a bill)".
    - Value reads "10 of 15 finished pieces of work kept".
    - The price list is no longer called a rate card.
  - **Missing evidence:** a figure with no evidence is "nothing to show yet, which isn't the same as zero". The button is "show the working". A conflict is "two records of the same thing disagree". The change alert reads "No change alert fired".
  - **Capitals:** sentences that open with a figure's name now start with a capital letter.
  - **Wrong label fixed:** "Where work was lost" names what went wrong at each step. It used to say "stopped after surviving in production" for work that failed the survival check, because the table is keyed by the first failed step, and it called contradicted results "stopped after conflicted". Now it reads "Gone from the code within 14 days", "Needed rework", "Results disagree". "Work that stuck" is now "work you kept", the guide's word.
  - **Precise mode:** keeps exact method terms where they carry meaning, such as "not causal evidence" and "e-process". The figures and their rules are unchanged; only the words are.

- **"How far the work got" counts what passed.** The Value page listed how many pieces of work were *checked* at each step, labelled as if they had *passed* ("was merged", "survived in production"). On the sample data it read merged 10, shipped 10, survived 13, so more work seemed to survive than shipped. Each step now shows passed, failed and not checked, out of the finished work. "Not checked" means there was no signal for that step, not that it failed. The value report carries a new `gatePasses` count per gate beside `instrumentation`.

- **The dashboard wears the griffin.**
  - **Logo:** the top bar, the welcome screen and the browser tab show the Segreant griffin, the same mark as the website. It replaces a placeholder shield.
  - **Scrollbars:** pages, tables and drawers use the dashboard's own scrollbars in both themes, instead of the system's grey ones.
  - **Laptop widths:** between 821 and 1240 px the jobs move to a second row of the top bar. Before this, at 980 px the "AI Financial Ops" tag broke onto three lines and the Plain/Precise switch ran off the edge.
  - **Sample data:** `segreant start --demo` on a fresh install now fills in sample data first, as `segreant demo` does. It used to show "sample data" over $0 and "no recorded requests". Sample data already there is left alone.

- **The value page uses a quarter of the memory.** Self-reported outcomes are matched to the requests they link to, and the report did that by loading every request ever recorded, on every value read, even on a ledger with no self-reported outcome at all. Each link now reads only the rows it names, by request id, session or tool and time range. Request reads also stream row by row instead of holding SQLite's raw records next to the mapped rows. On a synthetic 300,000-request ledger, six interleaved runs of the dashboard's value read peaked at 1,259 MiB before and 320 MiB after, and finished in 25.9 s rather than 31.5 s. The report is identical apart from its own timestamps, and so is every row a request read returns.

- **A value run picks up where the last one stopped.** Survival measurement blames every file a commit touched, and a run that hit its time budget left the rest unmeasured, then the next run started again from nothing. Git's answers are now kept under `<home>/survival/` and reused when they are provably the same observation at the current HEAD: the earlier HEAD is an ancestor, no commit since touched the file, and the history bound is no newer. A rewritten history, or a file changed and changed back, is measured again. On this repository's last 80 commits with a 2-second budget, a run without the cache measured none of them every time; with it, the third run measured all 80, and a warm run takes about 0.1 s instead of 4.7 s. HEAD is also read once per pass instead of once per commit, which alone was 3.6 s of an 80-commit pass. The cache holds commit hashes, file paths and line counts, never file contents, and deleting it costs time, never a figure.

- **Allocation rules can say everything the CLI can.** Under "More conditions and dates", a rule can also match on model, provider, tool and user, take a priority, and start or stop on a date; a rule saved there is the same rule `segreant alloc rule` writes, field by field. Every condition is part of the rule's id, so a rule for one model no longer replaces an existing rule for all spend. The split can be previewed for any chosen days, both ends included, not only last month or this month. Two existing mistakes are fixed: a rule with an end date (from `--until`) was labelled superseded, and once no rule was open-ended the page refused to preview at all, although dated and superseded rules still govern the periods they covered.

- **Renamed files keep their retention credit.** Survival reads which files a commit touched from `git show --numstat`, which prints a renamed file as `src/{old.ts => new.ts}`. That string was handed to `git blame` as a path; git refused it, the file read as deleted, and every line the commit added there counted as not retained, so work that included a rename looked more churned than it was. The file list is now read with `-z`, which gives the new path exactly, including paths with spaces or arrows in them.

- **Close shows what is declared, what is in use, and every comparison.** Step 1 names the declared organisation and project and can stop matching to it: "Stop matching" previews what clearing leaves alone (requests already recorded, recorded comparisons) before "Clear the declaration" ends it, as `segreant billing scope clear` does. An export already adopted under the current declaration reads "in use" instead of offering itself again; one adopted for an earlier declaration does not. Step 3 takes the materiality threshold the CLI already had, shows how many days differ by more than it, and records the comparison under the threshold that was previewed. Recorded comparisons are listed with their own days and project, and each opens to the figures it recorded. `/api/billing` now carries `activeScope` and each import's `inUse`, and `/api/billing/write` accepts `op: "scope-clear"`.

- **A recorded split downloads as a spreadsheet.** Each row under Saved splits on Allocate has a CSV link, and `segreant alloc runs` and `segreant alloc export <run-id> [--out file]` do the same from the terminal, byte for byte. The file is the run exactly as recorded, never recomputed under today's rules: one row per cost centre and rule, and one per unallocated reason with the projects behind it. Every row is labelled showback of the local estimate. The amount column adds up to the run's total to the microdollar; the total is stated in the first row's note rather than given its own row, so summing the column never doubles it. `GET /api/allocation/run.csv?id=` serves it.

- **Importing is about twice as fast when sessions span many folders.** Each importer asked git for the repository root of every distinct working directory, one process per folder. On Windows that is about 50 ms each, in every importer, on every refresh, and a profile showed it only as idle time. The root is now found on disk the way git finds it, which takes microseconds. On a synthetic Antigravity corpus with 54 project folders and 3,500 recent calls, seven interleaved pairs went from a median of 5.1 s to 2.2 s, and the stored rows are identical. Claude Code and Codex imports use the same resolver. `scripts/generate-antigravity-corpus.mjs` and `scripts/benchmark-antigravity-corpus.mjs` reproduce the measurement without real data.

- **Long names keep the money in view.** A project, model or cost-centre name with no spaces set the width of its table column, so on a phone Statement pushed the amount column off the right edge, and one long name in an allocation rule made the whole Allocate page scroll sideways. Names now wrap inside their cell or row, and the amount stays beside them. A share that is neither zero nor the whole no longer rounds to 0% or 100%: $21.90 unallocated out of $12.3M reads "<0.1%" rather than "0.0%", and the cost centre beside it ">99.9%" rather than "100.0%". On Protect, the alert coverage card no longer touches the daily limit card.

- **Every capability says what its command does.** An audit read the code behind all 64 capability rows. 34 described something the command does not do, or left out a consequence. Corrected:
  - `exec` was "Run under a cap"; it records whether a command passed and sets no limit.
  - `usage` was "requests and tokens"; it scores chat and research work.
  - `saved` was "what routing avoided"; it is time reclaimed.
  - `month`, `home` and `export` now say "last 30 days".
  - `receipt` now writes, so its tier is local.
  - Alerts, market, pricing and baseline name their network modes.
  - `backup` says its copy is unencrypted, and `plugin` that it runs your program without a sandbox.
- The capability table in Settings gives the descriptions room. `segreant scan` no longer calls itself read-only, since it remembers each scan.

- **The classic dashboard says what was refused.** Settings and judge refusals arrive as `{ error: { code, message } }`, which `/classic` showed as "[object Object]". It now shows the message, as the modern dashboard does.

- **A light theme, following your computer.** The dashboard had a light palette that nothing ever switched on. It now follows the operating system's light or dark setting, live, and Settings has an Appearance choice (match this computer, light, dark) kept in this browser only. Every page passes the automated WCAG 2 AA checks in both themes; the selected range chip, which fell to about 3:1 on the light gold, now uses dark text. On phones the current page is outlined in gold so it stands out in the grid.

- **The Statement downloads as a spreadsheet.** "Download as CSV" on the Statement saves the month as four labelled sections: what was measured, what the provider billed, how it was split, and what it produced. Every row carries its own basis, its own dates and whether it covers the whole month, and no row adds the claims together. The file lists every project and model rather than the page's top ten, and the project rows add up to the measured total. Provider and allocation amounts are exact to the microdollar. `GET /api/statement.csv?month=YYYY-MM` serves it from the same build as the page.

- **Every job is reachable on a phone.** The job bar used to scroll sideways and hid Value past the right edge with nothing to say it was there. On narrow screens all six jobs now sit in a grid, with Data and Settings below, each a full-size target, and the taller header no longer sticks over the page. The Plain/Precise switch has a larger target too.
- **Keyboard focus survives a save.** Saving a cost centre, rule or project declaration rebuilt the form and dropped focus to the top of the page. Focus now returns to the same control, or, when the save completes a step, to the first control of the next step. Focus the operator moved elsewhere while the request ran is left alone.
- **Statement shows what each provider comparison can establish.** A comparison no longer earns a green pill because its dates span the month. Each recorded run names its provider project and states, in red, disagreeing provider snapshots, deleted local rows, an estimate above the provider total, or missing bound and stability evidence. A sound run states its conditions in one quiet line. The card reads "conflicted", "compared, limits apply", "partly compared" or "compared".
- **Page names agree everywhere.** The capability table and the Allocate summary still said Evidence, Control, Allocation and System for pages the navigation calls Close, Protect, Allocate and Settings.
- **The Settings disclosure marker renders.** A mangled CSS escape drew a missing-glyph box before "What this dashboard can and cannot do". A guard test now refuses stray control characters in source, which also restored three patterns a publication-lock test had silently stopped checking.

- **Value opens when no value has been computed yet.** The browser rejected the server's `projects: null` response as a broken array and stopped loading the page. Its contracts now accept the uncomputed state as unknown, while checking populated project rows as before.

- CLI JSON reads now include `schemaVersion: 1`. Array responses, including
  request exports, place their records in `data` beside the version; object
  responses keep their fields. The stability promise is in the CLI JSON contract.

- **Financial evidence keeps its own scope and dates.** Allocate no longer calls the whole input ledger checked after one provider comparison; it states that the comparison covers its own project and dates. Statement and Close label provider periods in UTC, so local time cannot add or remove a day. Plain rule and project confirmations explain their consequences without raw status tokens. Rule messages distinguish unchanged recorded runs from a new preview, which follows effective dates and can differ for an earlier period.

- Primary job buttons on phones were about 38 px tall. They now have a 44 px minimum height, including Statement month navigation. Browser CI now completes Allocate, Close and Statement and checks all eight routes at 375 px width.

- **Value opens when no value has been computed yet.** The browser rejected the server's `projects: null` response as a broken array and stopped loading the page. Its contracts now accept the uncomputed state as unknown, while checking populated project rows as before.

- Configuration now refuses unknown section and budget field names, so a
  misspelled cap cannot silently leave forwarding unlimited. The proxy also
  refuses invalid live budget values before forwarding, including oversized caps.

- **Close refuses unsafe thresholds and filenames without exposing submitted text.** A very large materiality threshold could overflow to infinity and hide every discrepancy; the dashboard now refuses amounts outside the safe microdollar range. Billing uploads refuse directory names and paths in either platform's format. Malformed requests and exports show a concise JSON error without quoting their contents.

- **A monthly statement, as the finance home.**
  - A new Statement page shows one calendar month: what Segreant measured, what the provider billed, how it was split across cost centres, and what the work produced. The four sit side by side, each with its own basis, and are never added together.
  - A billed comparison or a split is labelled with its own dates ("covers part of the month only", "covers the month so far"). It is never prorated into the month.
  - A claim the ledger does not establish for the month says so, and links to the page that establishes it. Previous and next buttons step through months.
  - "I look after the money" on first run now opens the Statement.
  - A new read-only `GET /api/statement?month=YYYY-MM` serves it, with month bounds at local midnight.
- **The capability list no longer promises a summary that did not exist.** `segreant report` was listed as "Period report: a summary you can hand to someone". The command records an outcome by hand (tested, merged, shipped, redone), and the list now says so.

- **Settings and Value open on what you came for.**
  - Settings led with a 60-row table of what the dashboard can and cannot do, with the actual settings at the bottom of a 10,140 px page. The settings now come first. The table is kept in full, in a closed section whose summary line gives the counts. The page is now 900 px.
  - Value put a causal-study card above the answer, and the public model market and other supporting evidence below it ran at full length (7,557 px; 13,223 on a phone). The answer now comes first: basis, value and cost, the share of work that stuck, and where work fell over. The supporting evidence sits in named sections that open on demand. The page is now 3,360 px; 5,157 on a phone. Nothing was removed.

- **A month can be closed in the dashboard.**
  - The Close page used to describe reconciliation and point to the terminal. It is now three steps:
    - Say which OpenAI project this machine meters.
    - Bring in the bill: upload the cost export, see its lines and total, import it, then use it for the comparison. No key is needed.
    - Preview the comparison of billed against measured, with the unexplained remainder and what it can and cannot bound, then record it.
  - Each step shows a check once the ledger satisfies it. Nothing is written before a separate confirm. Sample data previews every step and records nothing.
  - The figures bar re-reads the Billed claim after a recorded comparison.
  - A new local-only `POST /api/billing/write` uses the same parsing, store calls and refusals as `segreant billing`.
- **The dashboard and the CLI recognise the same export as one file.** An export uploaded in the browser travels as its raw bytes and is hashed exactly as the CLI hashes the file. Importing it once from each surface is detected as a duplicate.
- **An export saved with a byte-order mark imports.** Windows tools add one by default, and `billing import` refused such files as "not valid JSON". The mark is skipped for parsing; the file's digest still covers it.
- **A key typed where a reference belongs is refused.** `billing scope set`, and the dashboard's Close page, accepted an API key (`sk-…`, `rk-…`) as the organisation or project reference and would have stored it in the ledger for good. Such values are now refused with a message saying which id to use instead.
- **Dashboard errors are sentences.** Every dashboard route answers `{ "error": "…" }`, but the dashboard only unwrapped another shape, so each refusal from a dashboard route (an allocation, an import, a budget) appeared as raw JSON. It now shows the message.

- **Allocation can be done in the dashboard, start to finish.**
  - The Allocate page was a description with a list of terminal commands. It is now three steps: add cost centres, write rules (all to one centre, fixed shares, or shared in proportion to direct spend), then preview a month's split and record it. Nothing is recorded until you press Record this run, the dashboard's form of `--apply`. Sample data allows the preview and refuses every change.
  - A new local-only `POST /api/allocation/write` uses the same store calls and validation as `segreant alloc`.
  - Fixed: the dashboard declared cost centres and rules with fields the server never sends (`id` instead of `costCentreId` and `ruleId`). The browser checks every payload against those declarations, so the Allocate page failed with a contract violation as soon as one real cost centre existed. Sample data has none, so no test saw it. A new test reads a populated ledger.
  - The figures bar at the top re-reads the allocation claim after a change, so it no longer says "no cost centres" under a page that just saved one.

- **The dashboard is organised around jobs, not internal layers.**
  - The bar reads Spend, Protect, Close, Allocate and Value, with Data and Settings set apart as setup. Each page title matches its tab.
  - First run asks what you do ("I look after the money" or "I build with AI tools") instead of asking you to pick a wording register before you have seen anything.
  - The basis line under the metered figure no longer prints "0% … ()" when nothing is weak. It says the figure is priced from the API rate card, or that it is mostly sample data.
  - Realized value carries an "estimate, not a measurement" chip wherever it is shown, so it no longer reads with the same weight as metered spend.
  - Spend bars are each model's share of the total, not of the largest model, and shares under 1% print as "<1%".
  - Protect shows "limit reached · blocking" when today's spend is at or over the cap, instead of a calm "enforced" badge over an overspend. The limit card has its own "Change limit" button.

- **The npm package no longer carries a maintainer's own usage figures.** 0.1.0 shipped `docs/RELEASE-GATE.md`, which quoted a personal ledger's request counts and dollar totals. The release records still ship as public evidence, but every finding is now stated without personal figures, in the package and on GitHub. A test packs the tarball and fails if a known personal figure appears in any shipped file.

- **Stopping `segreant` stops what it started.** The launcher ran the runtime with a blocking call that could not forward signals, so a `SIGTERM` from a supervisor or `kill <pid>` ended the launcher and left a running `start` (proxy and dashboard) behind as an orphan. It now forwards SIGINT, SIGTERM and SIGHUP to the runtime and exits with its status.

- **`start --demo` no longer meters real traffic into the sample store.** Demo mode opened `demo.db` for the whole process, so its proxy recorded real provider traffic among the synthetic rows, while the banner said "Real metering is untouched" and told you to point your tools at it. Demo mode now serves the dashboard only and says so. A tool started with `segreant launch` finds no proxy, warns that it is unmetered and goes direct.

- **Sample data and real data stay apart, and stale or unknown figures say so.**
  - `import --demo` appended real usage into `demo.db`, where it was summed with synthetic rows under the sample-data label. A month read $89.71, made of $0.05 real and $89.66 sample. Imports and the dashboard's import and scan actions now refuse in demo mode and say how to bring in your own usage. The dashboard copy no longer promises that importing replaces the sample.
  - When the local server stopped, the dashboard kept showing its last figures as current, with no timer to notice. It now re-checks every 15 seconds while figures are shown. When the server is gone, a banner states that the figures are not current and how old they are, the figures dim, and Retry reloads the page.
  - The classic dashboard showed "latest 01/01/1970" for billing imports that had never happened. A missing time now shows as "—".

- **Missing evidence no longer looks like a measured zero or a 1970 date.** The Spend, claim, and CLI retention notices now say "unknown" when the deletion boundary has no recorded time. An unavailable billing, allocation, or outcome report is identified as unavailable instead of described as empty. OpenCode rows without a valid time are left out of imported totals. A row with no reported cost keeps its usage and is priced from its tokens at the list rate, or as a labelled estimate when the model is not listed; a row from a provider with no list price is left out. An explicitly reported zero cost still counts. Data now calls its request total a metered cost estimate, and a public model without a price no longer displays $0.

- **Public documents agree with the licence and with what shipped.**
  - README, LICENSING, PRODUCT, the release gate, the website and the price-card notes now agree on several points: 0.1.0 is on npm and 0.2.0 is not; the BUSL-1.1 grant allows use at work (the badge said "free for personal use"); billed cost also comes from the OpenAI Costs API; and the Gemini 3.x rates and read dates are the ones the card lists. No price changed.
  - The lockfile's `license` field said MIT and now says BUSL-1.1.

- **The dashboard's value read answers repeat loads from memory.** With spend recorded but no `scan` yet, `/api/value` re-ran git realization for its start folder on every load (13-30 s). It is now cached in the dashboard process for up to 10 minutes. The cache key covers the query, the repository and its HEAD, the whole config, and change marks on every ledger table the report reads, so any change recomputes. The payload keeps its original `generatedAt`, and nothing is written to the ledger. Measured: 30.2 s, then 0.16 s and 0.16 s.

- **Kept means one thing everywhere.**
  - The website defines Kept as work that passed every check you track. The CLI counted survival alone, so work that failed its tests and its ship check but stayed in the tree was reported as Kept (H015). Kept now requires that no tracked check failed. The `scan`, `home` and `value` glosses say so.
  - Two dashboard lines described realized spend as "kept outcomes"; they now say realized.
  - The Realized inspector said "Nothing is missing for this one" under its own list of what it takes on trust (H018). It now says nothing more is needed for the claim as stated, an estimated manual-equivalent value of work that shipped and survived. It also names what a causal or business-value claim would additionally need.

- **Dashboard actions recover from a wrong entry, and sample data says it is read-only before Apply.**
  - Typing -1 as a budget used to fail at Apply and leave Apply disabled, even after the amount was corrected (H004). The preview now runs again whenever a field changes. It names an unusable amount before Apply, and a corrected amount re-enables it. The command shown beside it follows the field (`segreant budget --daily 25`).
  - On Optional features, the preview kept describing the first switch while Apply wrote the one now selected. It now follows the selection.
  - With sample data, Budgets and Optional features used to offer Apply and then show a raw `SETTINGS_UPDATE_FAILED` error (H005). The preview now says the dashboard is showing sample data before Apply is offered. The server answers a demo write with 409 and a sentence, and the dashboard shows a server's message instead of its JSON.
  - On a ledger with no requests, the dashboard's value read no longer runs git work for its start folder. It took 17-22 s per load, and the budget drawer waited for it before showing any preview. The budget recommendation is now read once per drawer, and waiting for it never holds validation or Apply.

- **A mistyped or unused option is no longer silent.** `segreant budget --dayly 5` used to exit 0 having set nothing (H014). Every option a finished command never read is now named on stderr, with the nearest real option when one is close ("Did you mean --daily?"), and the exit code is 2. A typed `--aply` is caught after the default preview, which writes nothing. `doctor` and `budget` now print JSON for `--json` instead of prose (H013), and `doctor`'s pricing line names the spend priced without the model's own rate rather than calling everything "priced from the rate card".

- **The status-line setup works however Segreant was installed.** `segreant statusline --setup` used to name `segreant-statusline`, which is on PATH only after a global install (H012). It now prints a `node "<installed file>"` command for this install, checked under bash and cmd with a path containing `&`. When Segreant runs from npx's temporary cache, it asks for a lasting install first.
- **README:** Option A names Antigravity. A Windows note covers project-local installs in a folder whose path contains `&`, which npm's `.cmd` shim does not quote (H001). The global install and `npx` from the cache were tested from such a folder and work.

- **One importer list for every surface.** The dashboard kept its own copy of the importers, which lacked Antigravity, so its "import all" skipped a tool the CLI read and `scan` reported (H008). The CLI, `scan` and the dashboard now build from `src/connect/registry.ts`. The `import` help and the `connect` hint name Antigravity too.

- **The dashboard's value read uses what `scan` measured.** Without `?repo=`, `/api/value` reads the stored realization for every project, the same one the home view shows, instead of re-running git for the folder the dashboard was started in. Identical row reads inside one report are served once, and proxy-only rows are derived from the full read. On the owner's ledger the read went from 17–21 s to 6.5–8.9 s, with the same answer.

- **The first-run answer accounts for every dollar, and stops double-counting.**
  - Under each project, `scan --setup` now names the spend that is on no measured commit and why: no commit followed within 8 hours, before the oldest commit measured, or not committed yet. The buckets plus that line add up to the project's total. Before, about two-fifths of one real project's spend had no line (H009).
  - Commit windows are now built in time order. `git log` order is not time order after a rebase, cherry-pick or merge, and windows built from log neighbours overlapped. On one real repository, 40 windows overlapped and the Kept answer counted some spend twice.
- **The value stage keeps its time budget.** Its deadline now starts before discovery, and every repository's git work stops by it. Repositories are found and scoped in parallel, from one read of the commit observations. Attribution and model reads take each window's rows from one scoped read instead of three queries per commit, and the verified-event cache now holds a whole ledger.
  - On the owner's logs the stage took 162 s against a 120 s budget; it now takes 119 s.
  - Per repository, the measurement floor fell from 23 s to 11 s.
  - When a large project comes back partly measured, the scan names the amount and the command that finishes it.

- **The dashboard has one period, and the four claims no longer wait for each other.** Choosing Today, 7 days, 30 days or All in Metered now moves the Metered claim above it as well; before, a Today table sat under a 30-day headline (H006). Each claim names the window it covers ("Metered · last 7 days", "Billed · latest reconciliation run"), and the choice is remembered in the browser.
  - Each claim draws as soon as its own data arrives, in order: the cheap reads first, the value read last. On the owner's real ledger, Metered appeared after 20 s before and after 0.85 s now. Realized still takes about 18 s and says "reading…" until it lands.
  - A claim still loading is no longer counted as "cannot answer yet".

- **Every total says how it was priced, in parts.** `today`, `week`, `month`, the home view, the first-run month line and the dashboard's Metered claim used to call every dollar "priced from the rate card". That was wrong for:
  - amounts a tool reported;
  - models the card did not know, which were priced at the generic fallback rate;
  - rows recorded before the basis was kept.

  A total now splits into parts:
  - list price, at the model's own rate;
  - list price, at the nearest model's rate;
  - fallback rate, naming the models;
  - tool-reported, including free models reported at no charge;
  - not priced;
  - basis not recorded.

  Its headline word follows the weakest part: "List cost" only when every dollar is at a model's own rate, otherwise "Estimated cost". The dashboard inspector no longer calls matched rows "not estimated", since every local amount is an estimate of a bill. The overview API and the `--json` outputs carry the same parts.
- **The rate card prices gpt-6.1-sol**, from OpenAI's model page read 2026-10-10: $2 input, $0.10 cached, $10 output per million. It also maps Antigravity's `gemini-3.1-pro-low` and `-high` to Gemini 3.1 Pro.
  - Calls that had been priced at the fallback rate read about twice their list cost; `segreant reprice` previews the correction under the new card.
  - Rows already imported keep their price until `reprice --apply`, and a fallback part now says so.

- **`scan --setup` asks what you pay.**
  - At the end, in an interactive terminal, it asks the monthly price of each plan your tools report and you have not priced. The public price is shown as a hint, and Enter skips.
  - Scripts, pipes and `--json` are never asked.
  - It also points Claude Code users to `segreant statusline --setup` for the live usage meter.

- **Google Antigravity is metered from its own logs.** `segreant import
  antigravity` (also part of `import all` and `scan --setup`) reads the
  conversation databases the IDE and the `agy` CLI keep under `~/.gemini`.
  Each model call becomes one row, with its model, its tokens, its time and the
  workspace folder, which links it to its repository. The fields follow
  Antigravity's published protobuf schema rather than guesses. On the owner's
  machine that is 12,821 calls from 581 conversations, read in 9 seconds.
  `connect antigravity` no longer calls the built-in agent unmeterable.
- **The rate card carries Gemini 3.x.** It adds 3.8, 3.7, 3.6 and 3.5 Flash,
  3.5 and 3.1 Flash-Lite, 3.1 Pro Preview and 3 Flash Preview, read from
  Google's pricing page (updated 2026-10-07) on 2026-10-09. Without them these
  calls fell to the $3/$15 fallback, about ten times Flash's real rate, so a
  month of Antigravity use read several times its list cost. Rates Google has
  announced for 2027 are noted on the card, not applied.

- **`segreant` on its own opens the home view.**
  - **On a new machine** it names the AI coding tools it found, with their plans, and gives the one command that reads them. It records nothing itself.
  - **With a ledger** it leads with the last 30 days' list cost and your plans, then how much of the last 90 days' AI work stayed in the code, as of the last measurement, then the next step.
  - The old first screen sent a new person to set up the proxy and showed a line about outcomes that had never been recorded. That checklist is still `segreant guide`.

- **`segreant quota`: the vendors' own meters, with the pace to the reset.**
  Codex's 5-hour and weekly percentages are read from its logs, with the pace
  to each reset; the projection is labelled an estimate. Segreant's list cost
  per 1% of the weekly meter is set beside earlier weeks', and both figures are
  shown when they disagree. Claude Code logs no percentage, so `quota` counts
  its limit messages (session, weekly, monthly spend), deduplicated across
  parallel agents. It also shows how much list-price work the 5 hours before
  each session limit held, and where the last 5 hours stand against that.
  Importers read every log file once more (reader version 3) to pick up this
  history.
- **Claude's live usage percentage, through its status line.** Claude Code
  hands a status line script its 5-hour and weekly meter. Set
  `"statusLine": { "type": "command", "command": "segreant-statusline" }`
  (`segreant statusline --setup` prints it). Segreant then records each
  change, `quota` shows Claude's percentages with the pace to the reset, and
  the bar reads `5h 25% · week 41% · today $5.68 list`. It answers in about
  0.2 s and never breaks the bar: no ledger, or bad input, still prints a
  line.

- **`segreant plan`: your plan, what you pay, and the work it did.**
  Segreant reads which plan each tool runs on from the tool's own files:
  Claude's `organizationType` in `~/.claude.json`, and ChatGPT's `plan_type` in
  the newest Codex log. It never reads a credentials file. The price is only
  what you enter (`segreant plan set claude-code 20`), because App Store
  billing, tax and annual plans change it; public prices are offered as a
  hint, with their date. `month` then shows, for example, "Your $20.00/month
  Claude Pro plan did $412.60 of list-price work in the last 30 days, 20.6×
  its price", naming both bases.

- **`scan --setup` shows the month first, then what stayed in the code.** It
  reads the logs of the last 30 days, prints that period's list cost, then
  reads older history. The value pass then shares one two-minute deadline
  across all repositories, with the largest 90-day spend going first. Within a
  repository, the most expensive matured commits are measured first. The list
  shows each project's 90-day spend as kept / not kept / not measured yet /
  maturing. A repository the deadline does not reach is named, with the
  command that measures it, and is never shown as zero.
- **One repository, however many checkouts.** Clones, worktrees and moved
  copies share a root commit. They are now measured once, on the checkout with
  the newest HEAD, and a clone's spend joins that repository's scope. Before
  this, every agent working copy of a repository claimed the same spend.

- **The value answer covers your whole history on the first run.**
  `realize`, `roi`, `frontier` and `scan` measure every commit of the last
  90 days (up to 1,500), not the newest 30 or 40, with a three-minute git
  budget; the dashboard keeps its 20-second one. `realize` now opens with the
  plain answer from git: how much list cost went into commits that are still
  in the code after 14 days (Kept), that were rewritten, removed or reverted
  (Not kept), that were not measured (Unknown), or that are still maturing. It
  also says what share of the period's spend landed on a commit, and why the
  rest did not.
- **Spend follows the repository, not the folder name.** The Claude Code and
  Codex importers record the commits an agent session made (git's
  `[branch sha] subject` line in the session log). An observation counts only
  when git confirms the sha, the subject and the time. A session that
  committed here, and an earlier location of a moved checkout or a worktree,
  then count toward this repository. An existing parent folder never does as a whole. Nothing in the
  ledger is relabelled; the links are recomputed from evidence on each run,
  recorded in each value snapshot, and used again when prices are corrected.
  Files read by the previous importer are read once more to pick up history.

## [0.1.0] - 2026-10-08

- **Install from npm.** `npx segreant demo --serve` shows the demo and
  `npm install -g segreant` installs the command. The package no longer
  carries a `prepare` script, so installing it runs nothing and npm raises no
  install-script warning; inside the repository, `npm run build` (or the
  `demo`, `start` and `test` scripts, which build first) compiles it.

- **Free for people and companies: the license is now the Business Source
  License 1.1** with an Additional Use Grant (`LICENSE`, explained in
  `LICENSING.md`). Anyone may use, change and build on Segreant, including
  selling their own products built on it; offering Segreant as a hosted
  service and selling Segreant itself are not allowed. Each version becomes
  Apache 2.0 two years after it is published. No commercial license is sold;
  `COMMERCIAL-LICENSE.md` is replaced by `LICENSING.md`.

- **The first run is about four times faster and says what it is doing.** A
  first `scan --setup` over 5.6 GB of agent logs went from 645 s, silent, to
  168 s with progress lines. Each file is blamed once per HEAD, git runs in a
  pool, imports commit in batches, log files already read in full are skipped
  (`import --rescan` reads them again), and opening the ledger no longer
  re-reads every economic event.

- **`today`, `week` and `month` head with list cost, not spend,** and say which
  part was read from tool logs ("not your invoice") and which was metered
  through the proxy.

- **The product is now Segreant.** It was called Fiscus until 2026-09-26; an
  unrelated AI-payments project owns that name on npm (D-290). The command is
  `segreant`, the environment overrides are `SEGREANT_HOME`, `SEGREANT_DB`,
  `SEGREANT_DEMO` and `SEGREANT_JUDGE_API_KEY`, the data directory is
  `~/.segreant`, and evidence packs are `.segreantpack` files with the schema
  `segreantpack`. The old names are not read, and a ledger created under the
  old name is not migrated: identifiers stored inside it changed with the
  name. It stays on disk untouched; Segreant starts a fresh ledger.

- **`segreant market`: compare models on public evidence before you have your
  own.** Coding uses the Aider polyglot leaderboard, whose published run costs
  give a real cost per solved task; chat, WebDev and image use LMArena ratings
  with their intervals and LiteLLM list prices. It works offline from a dated
  bundled snapshot, refreshes only through the egress gate
  (`market --refresh`, purpose `market_refresh`), states each source's licence
  and staleness, never forms a per-dollar ratio from ratings, and keeps your
  own realized value (`--repo`) beside the public figures, never inside them.
  Also in the Value view.
- **A consensus quality score in the market.** Many public benchmarks (Epoch
  AI's hub under CC BY 4.0, plus LMArena) combined per kind of work by a
  reliability-weighted, difficulty-adjusted fit, not a raw mean. Each score
  carries its range, the benchmarks behind it and the published weights; a
  model on one benchmark gets no score. Its ranking agrees with Epoch AI's
  Capabilities Index at Spearman 0.88 (coding) and 0.92 (chat).
- **`segreant outcome`: value for chat, image and other AI work.** Record a
  result's rating, decision, attempts, use and later durability; see cost per
  accepted and per used result by kind and model, always labelled
  self-reported and never added to git-verified coding value.
- **`segreant features`: switch optional subsystems off.** The market, each of
  its sources, and self-reported outcomes; preview, then `--apply`, or the
  Features drawer in System. A switched-off subsystem says so where its output
  would appear. Budget caps are not a switch.

### Security

- Budget/config persistence now fails closed: malformed or unenforceable caps
  are refused before provider dial, settings bodies are bounded and schema
  checked, and a ledger-write failure opens an explicit accounting circuit
  instead of silently allowing traffic.
- Egress receipt verification streams the retained hash chain in bounded chunks,
  refuses oversized individual lines, and keeps the checkpoint as an
  optimization rather than a second source of truth. Upstream `Location`
  headers are stripped on proxy redirects so downstream clients cannot follow
  outside Segreant's configured boundary.
- Optional team-server OIDC discovery refuses redirects, cross-origin JWKS,
  oversized responses, and unsafe endpoints; async aggregate failures return a
  bounded 503, and the default bind is loopback rather than all interfaces.
- The supported launcher now propagates spawn/signalled-child failures and
  refuses to bypass the publication lock on filesystem permission errors.
- Receipt checkpoints are no longer trusted as cross-process authority: a
  process validates the full chain before earning an in-memory append state;
  malformed-history diagnostics are bounded, and a 1 MiB line limit prevents a
  single corrupt record from becoming a memory sink.
- Restore now requires the integrity manifest emitted by `segreant backup`; a
  merely compatible arbitrary SQLite file can still be inspected, but cannot be
  promoted through the restore path.
- The synthetic benchmark always creates a temporary `SEGREANT_HOME`, so custom
  pricing caches and provenance in the caller's home cannot affect a run.
- Redacted diagnostics omit the complete custom pricing URL, retaining only a
  `sourceUrlConfigured` flag and safe pricing provenance fields.

- SQLite causal evidence tables now enable recursive triggers on every Store
  connection. `INSERT OR REPLACE` therefore cannot silently delete and replace
  an append-only evidence row; the regression suite exercises all protected
  causal tables through the raw connection as well as the typed write path.
- The local dashboard no longer exits on a malformed percent-escape in an asset
  path. `decodeURIComponent` threw a `URIError` out of the request handler with
  nothing to catch it, so any page the operator visited could stop Segreant with a
  single `<img src>`. A path that does not decode now 404s.
- `GET /api/scan` no longer writes. It recorded its own filesystem walk as the
  new scan baseline, which made it the one store write reachable without the
  `x-segreant-local: 1` header — and destroyed the drift it had just reported. The
  baseline now advances only on the guarded `POST`.
- Read-only dashboard routes answer only the methods they serve. Ten of them
  previously answered anything, so `DELETE /api/value` returned 200 and a full
  payload; they now return 405 with an `Allow` header. No route answers
  `OPTIONS`, which is what keeps the same-origin header gate meaningful.
- Dialog focus traps now treat the initially focused drawer/inspector container
  as a keyboard boundary, so the first `Shift+Tab` cannot escape to the opener.

### Fixed

- **Proxy and every other outbound request to a hostname failed on Node 20+.**
  The egress transport pinned sockets through a `lookup` that answered in the
  wrong form when Node asked for all addresses, so forwarding to
  `api.openai.com` / `api.anthropic.com`, pricing refresh, webhooks and team
  push all failed with `transport_failed` (HTTP 502 through the proxy). Only
  IP-literal targets worked. Fixed, with a real-socket regression test.
- The Return on Intelligence index is no longer described as an upper bound on
  the real conversion. An observed-only, renormalized index is not a ceiling:
  measuring a missing lens can move it either way. `instrumentationInterval`
  reports a partial-identification interval that evaluates unknown lenses at
  their admissible endpoints 0 and 1 under the full four-lens weight vector, and
  the observed-only score is reported alongside as the different quantity it is.
- The Impact lens is no longer reconstructed from the `merged` / `shipped` /
  `survived` verdicts that already determine Realization, which had made a lens
  sold as orthogonal move with the one it was meant to be independent of. Impact
  now requires an explicit orthogonal outcome signal or reports as
  uninstrumented.
- Amounts below one cent no longer render as `$0.00`. A $0.0020 soft threshold
  read as "no warning set" directly beneath a server alert quoting the real
  figure. Sub-cent amounts now carry two significant figures.
- The Control view reads the budget configuration by the field names the server
  actually sends, so a configured cap is no longer reported as absent and a
  cap-setting action is no longer accepted and silently discarded.
- The Realized band of the four-claim spine no longer renders attributed spend
  where it claims to report produced value. Both quantities are spelled
  `spendOnRealizedUnitsUsd` on the payload and only their definitions distinguish them.

### Changed

- Documentation: the README is now a short product page (what Segreant is, a
  30-second demo, real use, what it will not claim). The full command and
  design reference moved to `docs/GUIDE.md`, and `docs/README.md`
  indexes every document by audience. `docs/GETTING-STARTED.md` now includes
  the provider egress grant a proxy user needs, and no longer tells anyone to
  run `npx` with the old name, which would have fetched an unrelated package.
- `segreant backup --out` creates a verified SQLite `VACUUM INTO` snapshot with a
  hash/schema manifest, and `segreant restore` is preview-first and restores only
  into a new path. Corrupt, symlinked, or existing destinations fail closed;
  the active ledger is never overwritten.
- `segreant diagnostics --json` emits a versioned, redacted local handoff bundle
  with operation IDs, probe durations/error classes, schema/migration, egress,
  pricing, and resource observations. `--out` is an atomic non-overwriting
  export; no telemetry, prompts, source, credentials, or raw ledger rows leave
  the process.
- `npm run benchmark` provides synthetic small/current/10× and opt-in 100×
  performance observations for startup, ingest, query/value/API latency, RSS,
  and compiled artifact size without asserting a universal SLA.

- Concurrent builds now fingerprint their source generation before and after
  compilation and again inside the publication gate, retrying once on source
  drift. The supported CLI launcher acquires the same exclusive gate while it
  resolves the compiled module graph, so an older build cannot publish after a
  newer source generation merely because it finished compiling later.
- `npm test` performs the full reproducible build prerequisite. Package-boundary
  tests inspect Node runtime artifacts as well as browser output, so they no
  longer depend on `npm ci` having run `prepare` earlier in the checkout.
- V2 causal cost-bearing qualification now names the durable, append-only
  request-to-realization lineage sidecar. The Store-internal validator retains
  scalar metadata only, rejects raw prompts, source text, and unit snapshots,
  and remains fail-closed when ordinary ledger verification, a causally-bound
  realization identity, or any other evidence gate is unresolved. The sidecar
  is persisted internally; it is not yet a public evidence projection or
  release claim.
- The Store now has an internal independent causal-unit producer adapter. It
  authenticates the exact protocol, assignment, execution, matured outcome,
  request set, route scope, realization, and retained Git scalar rows; derives
  the unit identity without reading raw prompts or `unit_json`; verifies exact
  local ledger conservation and pricing lineage; and appends the scalar binding
  atomically. It remains local evidence, not a qualified causal result or
  provider invoice.
- Imported provider billing lines now expose exact append-only project/account
  mapping coverage in the Evidence dashboard and `/api/billing`, including
  mapped and residual amounts, status counts, targets, and the fact that these
  operator declarations remain excluded from budgets, RoI, and model advice.
- The CLI and the dashboard compose value through one shared sequence rather
  than assembling the same primitives independently in two places.

### Repository

- License changed from MIT to PolyForm Noncommercial 1.0.0, with commercial
  licenses available (`COMMERCIAL-LICENSE.md`, since replaced by `LICENSING.md`).
  Commits up to `28dc6dd` remain MIT.
- Research modules recovered from the August `agent/truth-closure` lane into
  `src/research/` (Shapley decomposition, off-policy estimators, calibration,
  IRT complexity models and others), research-only and tested.
- CI runs the team server against a real PostgreSQL on every change.
- User-facing issue forms, Discussion category forms, and source archives that
  leave out maintainer and agent files.
- Commercial licenses state their refund policy, and are arranged through a
  discussion until a self-serve checkout exists. The GitHub Sponsors button was
  added and then withdrawn before any sponsorship was taken
  (`docs/NEUTRALITY.md`).
- `bin/segreant.mjs` and `standalone/segreantpack-verifier.mjs` are committed as
  executable, so `npm link` from a clone no longer leaves a mode change behind.
- Added security, contribution, pull-request, issue, and dependency-update
  policy surfaces for public maintenance.
