/**
 * The parity map's own rule was not enforced, so its denominator was wrong
 * (WP-I03).
 *
 * WHAT THE REGISTRY SAYS ABOUT ITSELF. `src/dashboard/web/app/core/registry.ts`
 * opens with the argument: "The GUI is meant to reach full parity with the CLI.
 * A claim like that is worth nothing unless it is checkable, and this product's
 * whole argument is that important claims should be inspectable -- so parity is
 * a data structure, not a promise in a README." It closes that docblock with
 * "Adding a CLI verb without adding its row is the one change this file exists
 * to make awkward."
 *
 * IT WAS NOT AWKWARD. Nothing compared the registry with the CLI's dispatch.
 * Six capability groups reached a `case` in `src/cli.ts` with no row here:
 * `start`, `init`, `economic`/`economics`, `backup`, `restore`, and
 * `diagnostics`/`diagnostic`. The System view renders "N of 47 capabilities" at
 * full parity from `paritySummary()`, and 47 was the size of the list rather
 * than the size of the CLI -- a coverage figure computed over a population that
 * silently excluded every capability nobody had gotten around to listing.
 *
 * WHICH DIRECTION THE ERROR RAN, BOTH WAYS. Omitting `backup`, `restore`,
 * `diagnostics` and `init` -- which have no GUI surface -- made the parity
 * fraction look BETTER than it is, because a capability with no GUI cannot drag
 * the ratio down if it is not in the denominator. Omitting `economic`, which
 * the modern app does surface (`/api/economic` is a declared route with a
 * `modern-api` browser binding), made it look worse. A denominator that is
 * wrong in both directions at once is not a rounding problem; it is a figure
 * with no basis, which is the one thing this repository refuses.
 *
 * `not_applicable` IS A FOURTH STATE, NOT A FOURTH WAY OF SAYING `planned`.
 * `fiscus start` is the command that serves the GUI. By the time there is a
 * page to click, it has already run. Calling that `planned` would assert that
 * a GUI surface for it is coming, which is not true and not intended; calling
 * it `full` or `partial` would be worse. The honest answer is that the GUI
 * cannot offer it, stated with the reason -- and `coverageNote` is required
 * exactly there, so the state cannot become a place to file anything awkward.
 *
 * WHY THE DRAWER WAS NOT TAUGHT THIS STATE. `core/actions.ts` has a fallback
 * blocked reason that says "This does not have a screen yet", which is false
 * for `not_applicable`. Teaching it the new state would have been a branch no
 * caller reaches: `actionCard()` is invoked with explicit ids in the six views
 * and none of the six commands added here is among them, so the drawer never
 * receives one. That is the repository's second recurring defect class -- a
 * mechanism built and never wired -- and the alternative to building it is not
 * silence. The last test below refuses an action card for a `not_applicable`
 * capability, so the day a view surfaces one, the wrong message is a failing
 * test rather than a sentence an operator reads and believes.
 *
 * WHAT THIS DOES NOT ESTABLISH. That any row's `coverage` value is CORRECT --
 * only that every CLI capability has a row and that a row claiming
 * `not_applicable` explains itself. Whether `economic` is really `partial`
 * rather than `full` is a judgement about the GUI's economic surface that no
 * test here checks, and the same is true of every other row: the parity map
 * remains a set of honest human claims, now over the right population.
 *
 * Recorded at D-167.
 *
 * ---
 *
 * THE CHECK ABOVE READ ONE WORD (WP-I03, second pass). Both directions of the
 * population test compared `command.split(' ')[0]` with the dispatch: the verb,
 * and nothing after it. `fiscus billing openai-costs adopt --apply` was
 * checked as `billing`; `fiscus config --clear-proposals` was checked as
 * `config`. A row could document any subcommand path and any flag, and as long
 * as the first word reached a `case`, it counted as a command the CLI runs.
 *
 * IT WAS VACUOUS FOR EXACTLY ONE ROW, AND THAT ROW IS DESTRUCTIVE. `fiscus
 * config --clear-proposals` does not exist. `cmdConfig` reads no such flag and
 * never has -- a pickaxe search over the CLI's history finds the string in no
 * CLI source at any commit -- so the command prints the config and exits 0
 * while the row beside it, in the drawer, with a copy button, calls it the
 * shortcut for deleting every captured proposal. The operation is real: the
 * GUI posts to `/api/settings/clear-proposals`, which calls
 * `store.clearProposals()`. The CLI simply has no way to do it, and the row
 * said otherwise.
 *
 * WHAT THE CHECK NOW READS. Every documented command is parsed into its verb,
 * its subcommand words and its flags (`--` ends parsing, `<placeholder>` is
 * skipped). The verb must reach a dispatch case, as before. Each subcommand
 * word must appear as a string literal in the code that handles that verb --
 * the `case` group's own body plus the module `src/cli.ts` imports the handler
 * from, resolved from the import list rather than guessed. Each flag must be
 * READ there: `flags.<name>`, `flags['<name>']`, or `'<name>'` handed to a
 * flag-reading helper. That is a reading of the handler, not a second opinion
 * about what it accepts; D-166 declined to pin flags to commands because the
 * CLI declares no per-action schema, and that is still true -- this pins them
 * to the module that would have to read them, which is the strongest bound the
 * source supports without executing every command.
 *
 * THE BOUND IS THE MODULE, AND THAT IS STATED RATHER THAN HIDDEN. `showCmd.ts`
 * hosts six handlers, so a flag one of them reads would satisfy a row that
 * documents it on another. That is weaker than a per-function check and much
 * stronger than a per-verb check; it catches a flag no code in the right file
 * reads, which is what the one real defect was.
 *
 * THE ROW IS CORRECTED, NOT THE CHECK. A capability the GUI offers and the CLI
 * does not is a state the parity map had no way to say, because the map's
 * premise runs the other way. It now says it: a `command` that does not start
 * with `fiscus ` is not a CLI claim, must name a declared API route, and
 * carries an empty CLI binding. Adding the flag to `cmdConfig` instead would
 * have made the row true by building a destructive CLI path nobody had decided
 * to build, which is not this packet's call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, CAPABILITY_SPECS, paritySummary } from '../src/dashboard/web/app/core/registry.ts';

const ROOT = join(import.meta.dirname, '..');

/** Aliases that dispatch to help/version and are not capabilities in their own right. */
const NON_CAPABILITY = new Set(['help', '--help', '-h', 'version', '--version', '-v']);

/**
 * One entry per fall-through group in the CLI's switch.
 *
 * `case 'alloc':` / `case 'allocation':` is ONE capability with two spellings,
 * and treating them as two would demand a duplicate row for every alias in the
 * file. The grouping is read from the source rather than listed here, so a new
 * alias needs no change to this test and a new COMMAND does.
 */
function dispatchGroups(): string[][] {
  const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
  const switchAt = cli.indexOf('  switch (cmd) {');
  assert.notEqual(switchAt, -1, 'src/cli.ts must dispatch through a switch, or this test reads the wrong thing');
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of cli.slice(switchAt).split('\n')) {
    const match = /^ {4}case '([^']+)':\s*$/.exec(line);
    if (match) {
      current.push(match[1]!);
      continue;
    }
    if (current.length > 0 && line.trim() !== '') {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.filter((group) => !group.some((name) => NON_CAPABILITY.has(name)));
}

interface DocumentedCommand {
  readonly id: string;
  readonly raw: string;
  readonly verb: string;
  /** Bare words after the verb: the subcommand path the row claims. */
  readonly path: readonly string[];
  /** `--name` flags the row states, without the dashes. */
  readonly flags: readonly string[];
}

/**
 * A row's `command`, read in full. `--` ends the command (`exec -- <command>`
 * hands the rest to the operator's own program) and `<placeholder>` is an
 * argument, not a subcommand.
 */
function parseDocumented(id: string, raw: string): DocumentedCommand {
  const tokens = raw.replace(/^fiscus /, '').split(/\s+/).filter((t) => t.length > 0);
  const [verb, ...rest] = tokens;
  assert.ok(verb, `${id} documents an empty command`);
  const path: string[] = [];
  const flags: string[] = [];
  for (const token of rest) {
    if (token === '--') break;
    if (token.startsWith('<')) continue;
    if (token.startsWith('--')) flags.push(token.slice(2));
    else path.push(token);
  }
  return { id, raw, verb, path, flags };
}

/** Rows that claim a CLI command. A `command` not starting with `fiscus ` is a GUI-only capability, checked separately. */
function cliRows(): DocumentedCommand[] {
  return CAPABILITIES
    .filter((capability) => capability.command.startsWith('fiscus '))
    .map((capability) => parseDocumented(capability.id, capability.command));
}

/** The first word of each CLI row's documented command: the verb it claims to mirror. */
function registryVerbs(): Set<string> {
  return new Set(cliRows().map((row) => row.verb));
}

interface DispatchEntry {
  /** Every alias in the fall-through group. */
  readonly names: readonly string[];
  /** The group's own body in `src/cli.ts`, up to its `break`. */
  readonly body: string;
  /** Source of the module the handler is imported from, or null when the body calls no `cmdX`. */
  readonly handlerModule: string | null;
}

/**
 * The switch, read with its bodies and each handler resolved to the module
 * `src/cli.ts` imports it from. Nothing here is a list of what the CLI takes;
 * it is the CLI's own routing, read once.
 */
function dispatchTable(): Map<string, DispatchEntry> {
  const cli = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
  const imports = new Map<string, string>();
  for (const match of cli.matchAll(/^import \{([^}]+)\} from '\.\/cli\/([^']+)';/gm)) {
    for (const name of match[1]!.split(',').map((n) => n.trim()).filter((n) => n.length > 0)) {
      imports.set(name, join(ROOT, 'src/cli', match[2]!));
    }
  }
  const switchAt = cli.indexOf('  switch (cmd) {');
  assert.notEqual(switchAt, -1, 'src/cli.ts must dispatch through a switch, or this test reads the wrong thing');
  const table = new Map<string, DispatchEntry>();
  let names: string[] = [];
  let body: string[] = [];
  const flush = (): void => {
    if (names.length === 0) return;
    const text = body.join('\n');
    const handler = /\b(cmd[A-Z]\w*)\(/.exec(text)?.[1] ?? null;
    const modulePath = handler === null ? null : imports.get(handler) ?? null;
    const entry: DispatchEntry = {
      names,
      body: text,
      handlerModule: modulePath === null ? null : readFileSync(modulePath, 'utf8'),
    };
    for (const name of names) table.set(name, entry);
    names = [];
    body = [];
  };
  for (const line of cli.slice(switchAt).split('\n')) {
    const match = /^ {4}case '([^']+)':\s*$/.exec(line);
    if (match) {
      if (body.some((l) => l.trim() !== '')) flush();
      names.push(match[1]!);
      continue;
    }
    if (names.length > 0) body.push(line);
    if (names.length > 0 && /^ {6}break;\s*$/.test(line)) flush();
  }
  flush();
  return table;
}

/** Why a documented command's path or flags are not read by the code that handles its verb; empty when they are. */
function unreadParts(row: DocumentedCommand, entry: DispatchEntry): string[] {
  const surface = entry.body + '\n' + (entry.handlerModule ?? '');
  const problems: string[] = [];
  for (const word of row.path) {
    if (!surface.includes(`'${word}'`)) problems.push(`subcommand '${word}' is not a literal the handler of '${row.verb}' compares against`);
  }
  for (const flag of row.flags) {
    const read = surface.includes(`flags.${flag}`)
      || surface.includes(`flags['${flag}']`)
      || surface.includes(`flags["${flag}"]`)
      || surface.includes(`, '${flag}'`);
    if (!read) problems.push(`flag --${flag} is not read by the handler of '${row.verb}'`);
  }
  return problems;
}

test('every CLI capability the dispatch reaches has a row in the parity map', () => {
  // THE COUNTEREXAMPLE. Six groups had none, and the map's own docblock claims
  // this is the change it exists to make awkward.
  const verbs = registryVerbs();
  const uncovered = dispatchGroups()
    .filter((group) => !group.some((name) => verbs.has(name)))
    .map((group) => group.join('|'));

  assert.deepEqual(
    uncovered,
    [],
    'these CLI commands dispatch with no capability row, so the parity denominator does not count them',
  );
});

test('no capability row names a verb the CLI does not dispatch', () => {
  // THE OTHER DIRECTION, GATED RATHER THAN MERELY MEASURED. It was clean when
  // this packet was written, and that is exactly why it is worth an assertion:
  // a row for a command that was renamed or removed would go on being counted
  // in the denominator and rendered in the parity table with a command nobody
  // can run. Cheap to hold, invisible if it ever stops being true.
  const dispatched = new Set(dispatchGroups().flat());
  const phantom = cliRows()
    .map((row) => row.verb)
    .filter((verb) => !dispatched.has(verb));

  assert.deepEqual([...new Set(phantom)].sort(), [], 'these rows name a command the CLI does not dispatch');
});

test('the parity summary counts every capability exactly once, across all four states', () => {
  // The denominator has to be the whole population or the fraction means
  // nothing. Asserted as a partition rather than as a total, so a fifth state
  // added later without being counted fails here instead of quietly shrinking
  // the sum.
  const summary = paritySummary();
  assert.equal(summary.total, CAPABILITY_SPECS.length);
  assert.equal(
    summary.full + summary.partial + summary.planned + summary.notApplicable,
    summary.total,
    'every capability must land in exactly one parity state',
  );
});

test('a capability the GUI cannot offer says why, and only that state may', () => {
  // `not_applicable` is the one state that asserts something about the world
  // rather than about a backlog, so it carries its reason. Requiring the note
  // only there keeps it from becoming a comment field on every row.
  for (const capability of CAPABILITIES) {
    if (capability.coverage === 'not_applicable') {
      assert.equal(
        typeof capability.coverageNote,
        'string',
        `${capability.id} claims the GUI cannot offer it and must say why`,
      );
      assert.ok((capability.coverageNote ?? '').length > 20, `${capability.id}'s note must be a reason, not a label`);
    } else {
      assert.equal(
        capability.coverageNote,
        undefined,
        `${capability.id} is ${capability.coverage}; a note here would be an explanation of a state that does not need one`,
      );
    }
  }
});

test('a capability with no GUI surface declares no GUI binding, whichever reason it has', () => {
  // `planned` already produced an empty `gui` binding. `not_applicable` has to
  // as well, or the spec would claim the modern app implements something it
  // structurally cannot.
  for (const spec of CAPABILITY_SPECS) {
    if (spec.coverage === 'planned' || spec.coverage === 'not_applicable') {
      assert.deepEqual([...spec.bindings.gui], [], `${spec.id} has no GUI surface and must not claim one`);
    } else {
      assert.ok(spec.bindings.gui.length > 0, `${spec.id} claims coverage ${spec.coverage} and must name its GUI surface`);
    }
  }
});

test('the six commands this packet added are present and honestly stated', () => {
  // Named individually on purpose. A sweep that only counts would pass if a
  // future edit deleted a row and a different one appeared; these are the six
  // that were missing, and each one's state was a separate judgement.
  const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
  const byVerb = new Map(cliRows().map((row) => [row.verb, byId.get(row.id)!]));
  for (const verb of ['start', 'init', 'economic', 'backup', 'restore', 'diagnostics']) {
    const capability = byVerb.get(verb);
    assert.ok(capability, `fiscus ${verb} must have a capability row`);
    assert.ok(capability.plain.length > 0, `fiscus ${verb} must be described in the operator's words`);
  }
  assert.equal(byVerb.get('start')!.coverage, 'not_applicable', 'the GUI is served by start and cannot offer it');
  assert.equal(byVerb.get('economic')!.coverage, 'partial', '/api/economic is a real modern-app binding');
});

test('the dispatch reader is not vacuous: it finds the real groups and resolves aliases', () => {
  // A parser that returned nothing would make the first test pass while
  // checking no command at all.
  const groups = dispatchGroups();
  assert.ok(groups.length > 30, `expected the CLI to dispatch many commands; found ${groups.length}`);
  assert.ok(
    groups.some((group) => group.includes('alloc') && group.includes('allocation')),
    'fall-through aliases must arrive as one group, or every alias would demand a duplicate row',
  );
  assert.ok(groups.some((group) => group.length === 1 && group[0] === 'start'));
  assert.equal(
    groups.some((group) => group.some((name) => NON_CAPABILITY.has(name))),
    false,
    'help and version are dispatch cases and not capabilities',
  );
});

test('every documented command is read in full: its subcommand path and flags reach the code that handles its verb', () => {
  // THE COUNTEREXAMPLE. `fiscus config --clear-proposals` passed the verb
  // check as `config` while `cmdConfig` reads no such flag; the command exits 0
  // having cleared nothing, and the drawer offered it with a copy button as the
  // shortcut for a destructive action.
  const table = dispatchTable();
  const problems: string[] = [];
  for (const row of cliRows()) {
    const entry = table.get(row.verb);
    if (entry === undefined) {
      problems.push(`${row.id}: '${row.raw}' names verb '${row.verb}', which the CLI does not dispatch`);
      continue;
    }
    for (const problem of unreadParts(row, entry)) problems.push(`${row.id}: '${row.raw}' -- ${problem}`);
  }
  assert.deepEqual(problems, [], 'these rows document a command path the CLI would not act on');
});

test('the full-path reader is not vacuous: it resolves handlers, sees real subcommands, and refuses an invented one', () => {
  // A reader that resolved no handler module would make every row pass on the
  // strength of the `case` body alone, which for most verbs is one call.
  const table = dispatchTable();
  const resolved = [...new Set([...table.values()])].filter((entry) => entry.handlerModule !== null).length;
  assert.ok(resolved > 30, `expected most dispatch groups to resolve to a handler module; resolved ${resolved}`);

  const billing = table.get('billing');
  assert.ok(billing?.handlerModule, 'billing must resolve to its module');
  assert.deepEqual(
    unreadParts(parseDocumented('probe', 'fiscus billing openai-costs adopt --apply'), billing),
    [],
    'a real three-word path with a real flag must be read',
  );
  assert.equal(
    unreadParts(parseDocumented('probe', 'fiscus billing openai-costs vanish --nonexistent'), billing).length,
    2,
    'an invented subcommand and an invented flag must both be reported',
  );
  // `team push` is dispatched in the case body itself, not in the module.
  const team = table.get('team');
  assert.ok(team);
  assert.deepEqual(unreadParts(parseDocumented('probe', 'fiscus team push'), team), []);
  // The parser's two exclusions, so a change to either fails here.
  assert.deepEqual(parseDocumented('probe', 'fiscus exec -- <command>').path, []);
  assert.deepEqual(parseDocumented('probe', 'fiscus restore --from <backup> --out <file>').flags, ['from', 'out']);
});

test('a capability the GUI offers and the CLI does not says so, and binds a declared route instead of a fiction', () => {
  // The parity map's premise runs CLI -> GUI, so a GUI-only capability had no
  // way to be stated and one was stated as a CLI command that does not exist.
  // The honest shape: no `fiscus ` prefix, no CLI binding, and an API route the
  // contract declares -- so the escape from the CLI check cannot become free text.
  const guiOnly = CAPABILITY_SPECS.filter((spec) => !spec.command.startsWith('fiscus '));
  assert.ok(guiOnly.some((spec) => spec.id === 'clear-proposals'), 'clear-proposals has no CLI path and must not claim one');
  for (const spec of guiOnly) {
    assert.equal(spec.bindings.cli, '', `${spec.id} claims no CLI command and must carry no CLI binding`);
    assert.ok(spec.bindings.api.length > 0, `${spec.id} has no CLI path, so the route the GUI calls is its only basis and must be named`);
    assert.ok(spec.bindings.api.some((route) => spec.command.includes(route)), `${spec.id}'s displayed command must be the route it actually calls`);
    assert.notEqual(spec.coverage, 'planned', `${spec.id} is GUI-only; a planned GUI surface for it would be a contradiction`);
  }
});

test('no view hands a capability the GUI cannot offer to the action drawer', () => {
  // THE GUARD THAT REPLACES A BRANCH NOBODY WOULD REACH. The drawer's fallback
  // tells the operator a screen does not exist YET. For `not_applicable` that
  // is a promise nobody intends to keep, and rather than add a branch with no
  // caller, this test keeps such a capability out of the drawer entirely.
  const viewDir = join(ROOT, 'src', 'dashboard', 'web', 'app', 'views');
  const sources = readdirSync(viewDir).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length > 3, `expected the view directory to hold the app's views; found ${sources.length}`);

  const carded = new Set<string>();
  for (const name of sources) {
    const text = readFileSync(join(viewDir, name), 'utf8');
    for (const match of text.matchAll(/actionCard\('([^']+)'\)/g)) carded.add(match[1]!);
  }
  // Vacuity: the views really do render action cards, so an empty set below
  // would mean this test read the wrong thing rather than that it passed.
  assert.ok(carded.size > 10, `expected the views to render many action cards; found ${carded.size}`);

  for (const capability of CAPABILITIES) {
    if (capability.coverage !== 'not_applicable') continue;
    assert.equal(
      carded.has(capability.id),
      false,
      `${capability.id} cannot have a GUI surface, so an action card for it would open a drawer that says a screen is coming`,
    );
  }
});
