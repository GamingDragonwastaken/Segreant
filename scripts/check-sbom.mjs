#!/usr/bin/env node
/**
 * Check a CycloneDX SBOM of this package's RUNTIME tree against the
 * zero-runtime-dependency rule (D-237).
 *
 * `npm run sbom` asks npm's own generator for the production tree, so no
 * dependency is added to make a bill of materials. This script then asserts
 * what the rule says: the root component is this package and it has no
 * runtime components. The SBOM is a build fact, not attestation — nothing here
 * signs it, and signed provenance stays owner-reserved.
 *
 *   node scripts/check-sbom.mjs <sbom.cdx.json>
 *   npm run --silent sbom | node scripts/check-sbom.mjs -
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function auditSbom(sbom, packageJson) {
  const violations = [];
  if (sbom?.bomFormat !== 'CycloneDX') violations.push(`bomFormat is ${String(sbom?.bomFormat)}, expected CycloneDX`);
  const root = sbom?.metadata?.component;
  if (!root) violations.push('metadata.component (the root component) is missing');
  else {
    if (root.purl !== `pkg:npm/${packageJson.name}@${packageJson.version}`) {
      violations.push(`root purl is ${String(root.purl)}, expected pkg:npm/${packageJson.name}@${packageJson.version}`);
    }
  }
  const components = Array.isArray(sbom?.components) ? sbom.components : null;
  if (components === null) violations.push('components is not an array');
  else if (components.length !== 0) {
    violations.push(`runtime tree has ${components.length} component(s), and the rule is zero: ${components.map((c) => `${c.name}@${c.version}`).join(', ')}`);
  }
  const declared = Object.keys(packageJson.dependencies ?? {});
  if (declared.length !== 0) violations.push(`package.json declares runtime dependencies: ${declared.join(', ')}`);
  return { violations, componentCount: components?.length ?? null };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node scripts/check-sbom.mjs <sbom.cdx.json | ->'); process.exit(2); }
  const text = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
  const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  const { violations, componentCount } = auditSbom(JSON.parse(text), packageJson);
  if (violations.length > 0) {
    for (const item of violations) console.error(`sbom: ${item}`);
    process.exit(1);
  }
  console.log(`sbom: ${packageJson.name}@${packageJson.version}, ${componentCount} runtime component(s) — zero-dependency rule holds`);
}
