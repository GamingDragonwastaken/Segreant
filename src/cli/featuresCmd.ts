import { FEATURE_DEFAULTS, loadConfig, mutateConfig, type FeatureKey } from '../config.ts';
import type { Flags } from './flags.ts';
import { printJson } from './ui.ts';

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  selfReportedOutcomes: 'Self-reported chat/image/other results (segreant outcome)',
  market: 'Public model market (segreant market)',
  marketLiteLLM: 'Market: LiteLLM list prices',
  marketAider: 'Market: Aider coding benchmark',
  marketArena: 'Market: LMArena ratings (text, webdev, image)',
  marketEpoch: 'Market: Epoch AI benchmark results (consensus score)',
};

export function cmdFeatures(flags: Flags): void {
  const action = flags._[0] ?? 'list';
  const key = flags._[1];
  if (action !== 'list' && action !== 'on' && action !== 'off') {
    console.error('Usage: segreant features [on|off <key> [--apply]] [--json]');
    process.exitCode = 1;
    return;
  }
  if (action !== 'list' && (typeof key !== 'string' || !Object.hasOwn(FEATURE_DEFAULTS, key))) {
    console.error('Unknown feature key. Run segreant features to list available keys.');
    process.exitCode = 1;
    return;
  }
  if (action === 'list' && (key !== undefined || flags.apply === true)) {
    console.error('Usage: segreant features [on|off <key> [--apply]] [--json]');
    process.exitCode = 1;
    return;
  }
  const current = loadConfig();
  const selected = key as FeatureKey | undefined;
  const enabled = action === 'on';
  const applied = selected !== undefined && flags.apply === true;
  const features = applied
    ? mutateConfig((cfg) => { cfg.features[selected] = enabled; }).features
    : selected === undefined ? current.features : { ...current.features, [selected]: enabled };
  const rows = (Object.keys(FEATURE_DEFAULTS) as FeatureKey[]).map((id) => ({
    key: id, label: FEATURE_LABELS[id], enabled: features[id], default: FEATURE_DEFAULTS[id],
  }));
  const payload = { wouldWrite: applied, ...(selected ? { change: { key: selected, from: current.features[selected], to: enabled } } : {}), features: rows };
  if (flags.json) { printJson(payload); return; }
  console.log('');
  console.log(selected ? `  ${applied ? 'Feature saved' : 'Feature preview — configuration unchanged'}: ${selected} ${current.features[selected] ? 'on' : 'off'} → ${enabled ? 'on' : 'off'}` : '  Segreant features');
  for (const row of rows) console.log(`  ${row.key.padEnd(20)} ${row.enabled ? 'on ' : 'off'} (default ${row.default ? 'on' : 'off'})  ${row.label}`);
  if (selected && !applied) console.log(`  Persist with: segreant features ${action} ${selected} --apply`);
  console.log('  Not switches here: budget caps (always enforced, fail closed), per-user value (perUser.enabled),');
  console.log('  the session judge tier (judge.*), and alert delivery (alerts.webhookUrl).');
  console.log('');
}
