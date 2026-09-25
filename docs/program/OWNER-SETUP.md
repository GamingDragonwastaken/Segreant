# Owner setup checklist

Everything here needs the repository owner's GitHub account. None of it can be
done from the code. Each step lists where to click and what to paste, and
takes about two minutes.

## 1. GitHub Sponsors

**Where:** <https://github.com/sponsors> → *Get sponsored* → your personal
account. GitHub asks for a short profile, a payout method (Stripe Connect or a
bank account) and tax details. Approval takes a few days.

**Profile intro (paste):**

> I build Fiscus: a local-first ledger and spend guard for AI coding agents. It
> shows what every project, model and tool actually costs, stops runaway agents
> before they run up a bill, and checks your numbers against the provider's own
> bill, without ever passing an estimate off as an invoice. Zero runtime
> dependencies, 2,200+ tests, and no hosted anything. Sponsorship keeps it
> independent and moving.

**Tiers (monthly; create each under *Sponsor tiers*):**

| Tier | Price | Description to paste |
|---|---|---|
| Supporter | $3 | Keeps Fiscus independent. Your name in the README supporters list if you want it. |
| Commercial | $10 | **The commercial license for one organization.** Covers using Fiscus inside your company or for client work while you sponsor. After you sponsor, open a discussion or reply to the welcome message with your organization's name and you'll get written confirmation. |
| Team | $50 | Commercial license for your organization, plus your logo in the README and priority on issues you open. |

The Commercial tier is the licensing path that `COMMERCIAL-LICENSE.md`
describes, so keep its name as *Commercial*. Turn on the **welcome message**
for that tier and paste: *"Thank you. Reply with your organization's legal
name and you'll receive written confirmation of your commercial license."*

**Incentives that stay within `docs/NEUTRALITY.md`:** a name or logo in the
README, early notes on what is coming, and faster issue triage. **Not
allowed:** gating any feature behind sponsorship, or taking money from an AI
provider, gateway or model host that Fiscus compares.

Once the profile is live, the **Sponsor** button already configured in
`.github/FUNDING.yml` starts accepting money.

## 2. Protect `main`

**Where:** repository → *Settings* → *Rules* → *Rulesets* → *New ruleset* →
*Import a ruleset* → choose `docs/program/main-ruleset.json` → *Create*.
Then confirm *Protect main* shows **Active**. The policy and the reasons for
each rule are in `REPOSITORY-HYGIENE.md` §2.

## 3. Discussions categories

Discussions is already enabled. **Where:** *Discussions* tab → the pencil next
to *Categories*. Keep **Announcements**, **Q&A**, **Ideas** and **Show and
tell**; their forms are in `.github/DISCUSSION_TEMPLATE/` and appear
automatically. Delete **General** and **Polls** unless you want them. Pin one
Announcements post: *"Fiscus is in pre-release. Here's how to try it, and how
to tell us what broke."*

## 4. About box and topics

**Where:** repository home → the gear next to *About*.

- **Description:** Local-first ledger and spend guard for AI coding agents:
  metering, budgets, provider-bill reconciliation, and outcome evidence.
- **Topics:** `finops`, `ai-cost`, `llm`, `coding-agents`, `claude-code`,
  `openai`, `anthropic`, `budget`, `local-first`, `developer-tools`,
  `cost-management`, `observability`
- Tick **Releases** and untick **Packages** and **Deployments** until they
  exist.

## 5. Retire the historical branches

`REPOSITORY-HYGIENE.md` §1 has the verified table and the exact commands (tag
every branch as `archive/…`, then delete). Either run them yourself or tell the
agent working on the repository to run them.

## 6. Private vulnerability reporting

**Where:** *Settings* → *Code security* → *Private vulnerability reporting* →
**Enable**. The issue chooser's "Report a security vulnerability" link goes
there.
