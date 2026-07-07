/**
 * The guide: guidance instead of documentation.
 *
 * AegisFlow's journey is five verifiable facts — traffic flows, a cap exists,
 * an outcome landed, value computed, dollars disclosed. This module reads those
 * facts (gathered by the caller from the store + config, never from what the
 * user says they did) and returns the whole journey with done-flags plus the
 * single next action. The CLI and the dashboard render the same report, so the
 * user is never told two different "next steps".
 *
 * Pure: facts in, report out. No I/O here — that keeps it testable to the line.
 */

export interface GuideFacts {
  /** Rendering surfaces label demo data; the guide also swaps its hint. */
  demo: boolean;
  port: number;
  dashboardPort: number;
  /** Probed (health endpoint), not assumed. */
  proxyUp: boolean;
  requestsAllTime: number;
  spend30dUsd: number;
  dailyCapUsd: number | null;
  /** Outcome signals ever recorded — `report` and `exec` both write these. */
  outcomeSignals: number;
  /** Scored realization units — proof `roi`/`realize` ran against real work. */
  realizationUnits: number;
  laborRateSet: boolean;
}

export type GuideStepId = 'meter' | 'cap' | 'outcome' | 'value' | 'price' | 'steward';

export interface GuideStep {
  id: GuideStepId;
  /** Imperative label, e.g. "Meter the spend". */
  title: string;
  done: boolean;
  /** What the database says right now, e.g. "1,204 requests metered". */
  state: string;
  /** The one-line reason this step exists — the product thesis, in order. */
  why: string;
  /** Copy-pasteable commands, most direct first. */
  commands: string[];
}

export interface GuideReport {
  /** The first undone step's id; 'steward' once the journey is complete. */
  stage: GuideStepId;
  headline: string;
  steps: GuideStep[];
  /** The single next action (the first undone step; the steward step when done). */
  next: GuideStep;
  /** One optional situational nudge (demo data, empty install, …). */
  hint: string | null;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function buildGuide(f: GuideFacts): GuideReport {
  const envHint = `$env:ANTHROPIC_BASE_URL="http://localhost:${f.port}"  ·  $env:OPENAI_BASE_URL="http://localhost:${f.port}/v1"`;

  const meter: GuideStep = {
    id: 'meter',
    title: 'Meter the spend',
    done: f.requestsAllTime > 0,
    state:
      f.requestsAllTime > 0
        ? `${fmtInt(f.requestsAllTime)} requests metered`
        : f.proxyUp
          ? `proxy running on :${f.port} — no traffic through it yet`
          : 'no traffic yet',
    why: 'Nothing can be governed or valued until the spend is captured — imported from what your tools already log, or routed through the proxy.',
    commands: f.proxyUp
      ? [envHint, 'then run your AI tool as usual — watch requests appear']
      : [
          'aegisflow scan --setup    (find your AI tools + repos, import everything — no wiring)',
          'or aegisflow start, then set the base URL to also CAP spend:',
          envHint,
        ],
  };

  const cap: GuideStep = {
    id: 'cap',
    title: 'Cap it',
    done: f.dailyCapUsd !== null,
    state: f.dailyCapUsd !== null ? `daily hard cap $${f.dailyCapUsd}` : 'metering only — no enforcement',
    why: 'Metering without enforcement is a report, not governance. The proxy can actually say no.',
    commands:
      f.spend30dUsd > 0
        ? ['aegisflow budget --recommend        (suggests a cap from your own usage)', 'aegisflow budget --daily 25 --soft 18']
        : ['aegisflow budget --daily 25 --soft 18'],
  };

  const outcome: GuideStep = {
    id: 'outcome',
    title: 'Wire one outcome',
    done: f.outcomeSignals > 0,
    state:
      f.outcomeSignals > 0
        ? `${fmtInt(f.outcomeSignals)} outcome signals recorded`
        : 'no outcomes yet — spend is a cost with no counterweight',
    why: 'Exit codes are outcomes. Wrap your test command once and every run reports itself.',
    commands: ['aegisflow exec -- npm test        (any command; its exit code is the outcome)', 'aegisflow report --kind merged --commit <hash>'],
  };

  const value: GuideStep = {
    id: 'value',
    title: 'Compute the return',
    done: f.realizationUnits > 0,
    state:
      f.realizationUnits > 0
        ? `${fmtInt(f.realizationUnits)} units of work scored`
        : 'outcomes recorded but never scored against the spend',
    why: 'Four lenses — did it stick, did you keep it, did it save time, did it matter — one honest index.',
    commands: ['aegisflow roi --repo .', 'aegisflow usage        (non-coding sessions: chat, research, drafting)'],
  };

  const price: GuideStep = {
    id: 'price',
    title: 'Disclose a labor rate',
    done: f.laborRateSet,
    state: f.laborRateSet ? 'labor rate set — returns priced in dollars' : 'index only — the dollar return stays honestly un-priced',
    why: 'One auditable org input turns the 0–100 index into a break-even answer: was the AI worth it.',
    commands: ['aegisflow roi --repo . --labor-rate 120', 'or set lift.laborRatePerHour in config for every surface'],
  };

  const journeyDone = [meter, cap, outcome, value, price].every((s) => s.done);
  const steward: GuideStep = {
    id: 'steward',
    title: 'Steward it',
    done: false,
    state: journeyDone
      ? 'fully instrumented — the four questions are now answerable'
      : 'unlocks when the journey above is complete',
    why: 'Where does the next dollar go, what should you measure next, when do you actually know, and is the number being bent.',
    commands: [
      'aegisflow budget --recommend --repo .   (value-aware cap)',
      'aegisflow frontier --repo .             (best model × task for YOU)',
      'aegisflow roi --repo .                  (watch Stability + Instrument next)',
    ],
  };

  const journey = [meter, cap, outcome, value, price];
  const firstUndone = journey.find((s) => !s.done) ?? null;
  const next = firstUndone ?? steward;
  const stage = next.id;

  const headlineByStage: Record<GuideStepId, string> = {
    meter: 'Start here: route one AI tool through the proxy.',
    cap: 'Spend is visible. Now make the limit real.',
    outcome: 'Governed spend, unknown value. Wire the first outcome.',
    value: 'Outcomes are flowing. Score them against the spend.',
    price: 'The index works. One disclosed number makes it money.',
    steward: 'Fully instrumented. From here on, the tool answers questions.',
  };

  let hint: string | null = null;
  if (f.demo) {
    hint = 'You are looking at synthetic demo data. Run "aegisflow guide" without --demo to see your real journey.';
  } else if (f.requestsAllTime === 0) {
    hint = 'Want to see every surface populated first? "aegisflow demo --serve" builds an isolated, clearly-labeled sandbox.';
  }

  return {
    stage,
    headline: headlineByStage[stage],
    steps: [...journey, steward],
    next,
    hint,
  };
}
