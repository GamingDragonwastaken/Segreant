#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_ROOTS = ['src', 'bin', 'team-server/src'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml']);
const CREDENTIAL_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{100,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const DYNAMIC_CODE_PATTERNS = [
  /\beval\s*\(/g,
  /\bnew\s+Function\s*\(/g,
];

function walk(path, files) {
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) { walk(child, files); continue; }
    if (!entry.isFile() || !EXTENSIONS.has(extname(entry.name))) continue;
    files.push(child);
  }
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

export function auditSecurityTree(root) {
  if (typeof root !== 'string' || root.length === 0 || !statSync(root).isDirectory()) {
    throw new Error('security audit root must be an existing directory');
  }
  const files = [];
  for (const sub of PRODUCTION_ROOTS) walk(join(root, sub), files);
  files.sort();
  const violations = [];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        violations.push({ rule: 'credential-pattern', path: relative(root, path).replaceAll('\\', '/'), line: lineOf(source, match.index ?? 0) });
      }
    }
    for (const pattern of DYNAMIC_CODE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        violations.push({ rule: 'dynamic-string-code', path: relative(root, path).replaceAll('\\', '/'), line: lineOf(source, match.index ?? 0) });
      }
    }
  }
  return Object.freeze({ filesScanned: files.length, violations: Object.freeze(violations) });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const root = process.cwd();
  const result = auditSecurityTree(root);
  if (result.filesScanned < 100) {
    console.error(`security audit corpus unexpectedly small: ${result.filesScanned} files`);
    process.exit(1);
  }
  if (result.violations.length > 0) {
    for (const violation of result.violations) console.error(`${violation.rule}: ${violation.path}:${violation.line}`);
    process.exit(1);
  }
  console.log(`security audit: ${result.filesScanned} production files, 0 credential/dynamic-code violations`);
}
