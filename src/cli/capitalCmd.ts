/**
 * Local, review-first AI-capital operator surface.
 *
 * The input is an explicitly supplied bounded JSON snapshot. This command does
 * not read provider credentials, write a capital ledger, change a budget, or
 * authorize chargeback/routing. It exists so the typed J04 boundary is usable
 * without quietly turning a demonstration into an operational authority.
 */

import { readBoundedUtf8File, RESOURCE_LIMITS } from '../util/resource-limits.ts';
import { evaluateCapitalAccount, type CapitalAccountInput } from '../capital.ts';
import type { Flags } from './flags.ts';
import { printJson } from './ui.ts';

function requireStringFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error('capital ' + name + ' requires --' + name + ' <value>');
  return value;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readBoundedUtf8File(file, RESOURCE_LIMITS.jsonDocumentBytes, 'json_document_bytes'));
  } catch (error) {
    throw new Error('cannot read capital JSON file ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function usage(): void {
  console.log('');
  console.log('  Fiscus capital — review-only exact AI-capital decomposition');
  console.log('  fiscus capital evaluate --options <file> [--json]');
  console.log('');
  console.log('  The supplied snapshot is checked for commitment/spend conservation,');
  console.log('  showback boundaries, counterfactual opportunity gaps, and policy-relative');
  console.log('  fairness. It never authorizes routing, budgets, payment, or chargeback.');
  console.log('');
}

function emit(payload: unknown, flags: Flags): void {
  // Keep the JSON path canonical; --json is accepted for parity with other
  // review commands and the human form remains machine-readable by design.
  void flags;
  printJson(payload);
}

export function cmdCapital(flags: Flags): void {
  const action = flags._[0] ?? 'help';
  if (action === 'help' || action === '--help' || action === '-h') {
    usage();
    return;
  }
  if (action !== 'evaluate') {
    usage();
    process.exitCode = 1;
    return;
  }
  const file = requireStringFlag(flags, 'options');
  const supplied = readJsonFile(file);
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('capital options must be a JSON object');
  }
  const result = evaluateCapitalAccount(supplied as CapitalAccountInput);
  emit({
    operation: 'capital_evaluation',
    result,
    boundary: 'Review-only exact capital decomposition from the supplied snapshot; no provider, budget, payment, routing, causation, or business-value authority.',
  }, flags);
}

