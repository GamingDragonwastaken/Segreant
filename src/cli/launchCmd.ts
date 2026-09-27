/**
 * `segreant launch -- <command>`: start one tool with its base URLs pointed at
 * the proxy, only for that process and only while the proxy is up.
 *
 * Exporting ANTHROPIC_BASE_URL / OPENAI_BASE_URL in a shell profile means that
 * whenever Segreant is not running, every agent fails to connect. Launching
 * through this command keeps the variables out of the profile: when the proxy
 * answers its health check the tool is metered; when it does not, the tool
 * starts unmetered with a warning. The one exception is budget enforcement,
 * which fails closed: with a cap configured, a stopped proxy refuses the launch
 * unless the operator passes --allow-unmetered.
 */

import { spawn } from 'node:child_process';
import { loadConfig, type SegreantConfig } from '../config.ts';
import { probeProxyState } from '../egress/proxyHealth.ts';
import type { ProxyStatus } from '../guide.ts';
import { type Flags } from './flags.ts';

export interface LaunchPlan {
  /** Environment variables to set for the child; empty when unmetered. */
  env: Record<string, string>;
  /** One line for stderr describing what happens. */
  notice: string;
  /** True when the launch must not start the tool. */
  refuse: boolean;
}

function capConfigured(cfg: SegreantConfig): boolean {
  const b = cfg.budget;
  return b.dailyUsd !== null || b.sessionUsd !== null || b.runawayMaxUsd !== null;
}

/** Decide how to start the tool. Pure, so the fail-closed rule is testable. */
export function planLaunch(state: ProxyStatus, cfg: SegreantConfig, allowUnmetered: boolean): LaunchPlan {
  if (state.kind === 'up') {
    const base = `http://127.0.0.1:${cfg.port}`;
    return {
      env: { ANTHROPIC_BASE_URL: base, OPENAI_BASE_URL: `${base}/v1` },
      notice: `segreant: metering this session through ${base}`,
      refuse: false,
    };
  }
  const why = state.kind === 'down' ? 'the proxy is not running' : `the proxy health check was refused (${state.code})`;
  if (capConfigured(cfg) && !allowUnmetered) {
    return {
      env: {},
      notice: `segreant: not starting — ${why} and a budget cap is set, so this session could not be held to it. Run "segreant start", or pass --allow-unmetered to start without the cap.`,
      refuse: true,
    };
  }
  return {
    env: {},
    notice: `segreant: ${why}; starting without metering (nothing is recorded and no cap applies to this session)`,
    refuse: false,
  };
}

/** Quote one argument for a cmd.exe command line; embedded quotes are doubled. */
export function cmdQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.:\/=@+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

export async function cmdLaunch(flags: Flags, command: string[]): Promise<void> {
  if (command.length === 0) {
    console.error('  Usage: segreant launch [--allow-unmetered] -- <command> [args…]');
    console.error('  Example: segreant launch -- claude');
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const plan = planLaunch(await probeProxyState(cfg), cfg, flags['allow-unmetered'] === true);
  console.error(plan.notice);
  if (plan.refuse) {
    process.exitCode = 2;
    return;
  }
  const env = { ...process.env, ...plan.env };
  if (Object.keys(plan.env).length === 0) {
    // An inherited variable may still point at the stopped proxy; that would
    // make the unmetered start fail to connect, which is the problem this solves.
    const ours = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${cfg.port}(/|$)`);
    for (const key of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) if (ours.test(env[key] ?? '')) delete env[key];
  }
  // Windows tools are usually .cmd shims, which only start through cmd.exe, and
  // cmd joins separate arguments with bare spaces: a quoted prompt arrived as
  // loose words. Hand it one line with every argument quoted instead.
  const child = process.platform === 'win32'
    ? spawn(command.map(cmdQuote).join(' '), { stdio: 'inherit', env, shell: true })
    : spawn(command[0]!, command.slice(1), { stdio: 'inherit', env });
  await new Promise<void>((resolveExit) => {
    child.on('error', (err) => {
      console.error(`segreant: could not start "${command[0]}": ${err.message}`);
      process.exitCode = 127;
      resolveExit();
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolveExit();
    });
  });
}
