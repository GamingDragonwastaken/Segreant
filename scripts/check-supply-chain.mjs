import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Mechanical enforcement of the supply-chain claims this repository makes in
 * prose.
 *
 * CLAUDE.md states "zero runtime dependencies" and the release discipline
 * assumes CI runs the code that was reviewed. Both were enforced by nobody:
 * adding a `dependencies` block to package.json left typecheck, the suite, the
 * build and all four CI jobs green, and `ci-hardening.test.ts` pinned exactly
 * two named actions by regex, so a third action introduced at a mutable tag was
 * an unreviewed remote-code-execution path into every CI run.
 *
 * The audit is a pure function over already-read inputs. That is what lets the
 * test drive it with mutated copies of the REAL files: a property test of a
 * repository is worth only what its counterexamples prove, and a checker that
 * can only read the filesystem cannot be shown to fail.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The complete set of packages this project is permitted to install. */
const ALLOWED_DEV_DEPENDENCIES = ['@types/node', 'typescript'];

/** The only registry a locked tarball may be fetched from. */
const ALLOWED_REGISTRY_HOST = 'registry.npmjs.org';

/**
 * Fields that acquire a package at install time for consumers. `dependencies`
 * is the obvious one; the other three are the ways the same effect is reached
 * without the obvious name, which is precisely how a rule stated only as
 * "no dependencies" gets around.
 */
const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

/**
 * `files` overrides .gitignore during `npm pack`. `.codex/` and
 * `docs/planning/` are gitignored because they are internal, not because they
 * are uninteresting — an entry naming either would publish local orchestration
 * state from a public repo's tarball.
 */
const NEVER_PUBLISHABLE = ['.codex', 'docs/planning', 'node_modules', '.github', '.git', '.env'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Read every input the audit needs from a checkout. Kept separate from the
 * audit so callers (and the test) can mutate a real, complete input set rather
 * than hand-build a fixture that drifts from what the repository looks like.
 */
export function readSupplyChainInputs(root = ROOT) {
  const workflowDir = join(root, '.github', 'workflows');
  const workflows = existsSync(workflowDir)
    ? readdirSync(workflowDir)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .sort()
        .map((name) => ({ name, text: readFileSync(join(workflowDir, name), 'utf8') }))
    : [];

  const teamServerLockPath = join(root, 'team-server', 'package-lock.json');

  return {
    packageJson: readJson(join(root, 'package.json')),
    packageLock: readJson(join(root, 'package-lock.json')),
    teamServerLock: existsSync(teamServerLockPath) ? readJson(teamServerLockPath) : null,
    workflows,
  };
}

/**
 * Every locked entry must name where it came from and how to verify it.
 *
 * `npm ci` checks each downloaded tarball against the lockfile's OWN integrity
 * field, which means a modified lockfile is trusted completely: change
 * `resolved` and `integrity` together and npm installs an attacker's bytes
 * without complaint. Nothing in this repository previously constrained what a
 * lockfile was allowed to say, so this is the constraint.
 */
function auditLockEntries(violations, label, lock, { requireDevOnly }) {
  const packages = isPlainObject(lock?.packages) ? lock.packages : {};
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || !isPlainObject(entry)) continue;
    if (entry.link === true) continue; // a workspace symlink resolves to no tarball

    if (typeof entry.resolved !== 'string' || entry.resolved.length === 0) {
      violations.push(`${label}: ${path} has no resolved URL, so its source is whatever npm picks at install time`);
    } else {
      let url;
      try {
        url = new URL(entry.resolved);
      } catch {
        violations.push(`${label}: ${path} has an unparseable resolved URL ${entry.resolved}`);
      }
      if (url) {
        if (url.protocol !== 'https:') {
          violations.push(`${label}: ${path} must resolve over https, got ${url.protocol.replace(':', '')}`);
        }
        if (url.host !== ALLOWED_REGISTRY_HOST) {
          violations.push(`${label}: ${path} resolved host ${url.host} is not ${ALLOWED_REGISTRY_HOST}`);
        }
      }
    }

    if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
      violations.push(`${label}: ${path} has no integrity hash, so npm installs whatever the host returns`);
    } else if (!entry.integrity.startsWith('sha512-')) {
      violations.push(`${label}: ${path} has weak integrity ${entry.integrity.split('-')[0]}, expected sha512`);
    }

    if (requireDevOnly && entry.dev !== true) {
      violations.push(`${label}: ${path} is not marked dev, so it installs at runtime for anyone who installs fiscus`);
    }
  }
}

/**
 * A `uses:` reference resolves whatever the named ref points at *now*. A tag is
 * mutable by the action's owner, so a tag pin is an ongoing grant of arbitrary
 * code execution inside CI. Only a full commit sha is immutable — an
 * abbreviated one is a prefix, which a future object can also match.
 */
function auditWorkflowPins(violations, name, text) {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
    if (!match) continue;
    const reference = match[1];
    const trailer = match[2] ?? '';
    const where = `${name}:${index + 1}`;

    // Local composite actions and Dockerfile references resolve inside this
    // repository, which the checkout has already fixed to a known commit.
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue;

    const pin = /@([0-9a-f]{40})$/.exec(reference);
    if (!pin) {
      violations.push(`${where}: ${reference} is not pinned to a 40-character commit sha`);
      continue;
    }
    if (!/#\s*\S/.test(trailer)) {
      violations.push(`${where}: ${reference} has no version comment, so the pin cannot be reviewed by a human`);
    }
  }
}

/**
 * `npm ci` installs exactly the lockfile. `npm install` re-resolves, so a
 * workflow using it runs code the lockfile never named and no reviewer saw.
 *
 * The package-smoke job legitimately runs `npm install <path-to-tarball>` to
 * install the packed artifact into a clean directory. That is an install of one
 * named local file, not a fresh resolve of this repository's tree, so the rule
 * keys on whether a positional package argument is present rather than banning
 * the verb — collapsing the two would delete the only packaging proof in CI.
 */
function auditWorkflowInstalls(violations, name, text) {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const where = `${name}:${index + 1}`;

    const install = /(?:^|[\s;&|])npm\s+(?:install|i|add)\b([^\n#]*)/.exec(line);
    if (install) {
      const positional = (install[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0 && !token.startsWith('-'));
      if (positional.length === 0) {
        violations.push(`${where}: installs without a lockfile (\`npm install\` with no named package); use \`npm ci\``);
      }
    }

    if (/\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n#]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/.test(line)) {
      violations.push(`${where}: pipes a downloaded script into a shell, executing unreviewed remote code in CI`);
    }
  }
}

/** @param {ReturnType<typeof readSupplyChainInputs>} inputs */
export function auditSupplyChain(inputs) {
  const violations = [];
  const { packageJson, packageLock, teamServerLock, workflows } = inputs ?? {};

  // --- the zero-runtime-dependency rule, stated in CLAUDE.md, enforced here ---
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const declared = packageJson?.[field];
    const names = Array.isArray(declared) ? declared : isPlainObject(declared) ? Object.keys(declared) : [];
    if (names.length > 0) {
      violations.push(`package.json declares runtime dependencies via ${field}: ${names.join(', ')}`);
    }
  }

  const dev = isPlainObject(packageJson?.devDependencies) ? Object.keys(packageJson.devDependencies).sort() : [];
  const unexpected = dev.filter((name) => !ALLOWED_DEV_DEPENDENCIES.includes(name));
  const missing = ALLOWED_DEV_DEPENDENCIES.filter((name) => !dev.includes(name));
  if (unexpected.length > 0) {
    violations.push(`package.json has unexpected devDependencies: ${unexpected.join(', ')}`);
  }
  if (missing.length > 0) {
    // Bounding only growth would let the compiler silently disappear and the
    // build pass on a stale dist/. The allowlist is exact in both directions.
    violations.push(`package.json is missing required devDependencies: ${missing.join(', ')}`);
  }

  // --- the lockfile must lock THIS manifest ---
  if (packageLock?.name !== packageJson?.name) {
    violations.push(`package-lock.json name ${packageLock?.name} does not match package.json name ${packageJson?.name}`);
  }
  if (packageLock?.version !== packageJson?.version) {
    violations.push(
      `package-lock.json version ${packageLock?.version} does not match package.json version ${packageJson?.version}`,
    );
  }
  if (typeof packageLock?.lockfileVersion !== 'number' || packageLock.lockfileVersion < 3) {
    violations.push(`package-lock.json lockfileVersion ${packageLock?.lockfileVersion} predates integrity-complete v3`);
  }

  const mirror = packageLock?.packages?.[''];
  const mirrorDev = isPlainObject(mirror?.devDependencies) ? mirror.devDependencies : {};
  const manifestDev = isPlainObject(packageJson?.devDependencies) ? packageJson.devDependencies : {};
  if (JSON.stringify(mirrorDev, Object.keys(mirrorDev).sort()) !== JSON.stringify(manifestDev, Object.keys(manifestDev).sort())) {
    violations.push(
      'package-lock.json root mirror disagrees with package.json devDependencies; the lock no longer locks this manifest',
    );
  }
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const declared = mirror?.[field];
    const names = Array.isArray(declared) ? declared : isPlainObject(declared) ? Object.keys(declared) : [];
    if (names.length > 0) {
      violations.push(`package-lock.json root mirror declares ${field}: ${names.join(', ')}`);
    }
  }

  auditLockEntries(violations, 'package-lock.json', packageLock, { requireDevOnly: true });
  if (teamServerLock) {
    // team-server is a separate npm project with `pg` as a real runtime
    // dependency: exempt from the zero-dependency rule, exempt from nothing
    // else. CI runs `npm ci` against this lockfile exactly as it does the root.
    auditLockEntries(violations, 'team-server/package-lock.json', teamServerLock, { requireDevOnly: false });
  }

  // --- the publish surface may not name anything internal or machine-local ---
  const files = Array.isArray(packageJson?.files) ? packageJson.files : [];
  for (const entry of files) {
    if (typeof entry !== 'string') {
      violations.push(`package.json files contains a non-string entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.split('/').includes('..')) {
      violations.push(`package.json files entry ${entry} escapes the package root`);
      continue;
    }
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('~')) {
      // The repo is public; a developer's filesystem layout is not shippable.
      violations.push(`package.json files entry ${entry} is an absolute or machine-local path`);
      continue;
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => segment.startsWith('.') && segment !== '.') ||
        NEVER_PUBLISHABLE.some((banned) => normalized === banned || normalized.startsWith(`${banned}/`))) {
      violations.push(`package.json files entry ${entry} names an internal or hidden path`);
    }
  }

  // --- CI must run reviewed code only ---
  if (!Array.isArray(workflows) || workflows.length === 0) {
    violations.push('no GitHub Actions workflows were found to audit');
  } else {
    for (const workflow of workflows) {
      auditWorkflowPins(violations, workflow.name, workflow.text);
      auditWorkflowInstalls(violations, workflow.name, workflow.text);
    }
  }

  return violations;
}

// Runnable as a gate in its own right: a check that exists only inside the test
// suite cannot be run before a push, and `npm test` is slow enough that people
// skip it.
// `file://${argv[1]}` does not round-trip on Windows (drive letters, spaces —
// and this checkout's own path contains one). Compare through pathToFileURL.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const found = auditSupplyChain(readSupplyChainInputs(ROOT));
  if (found.length > 0) {
    console.error('supply-chain violations:');
    for (const line of found) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('supply chain: no violations');
}
