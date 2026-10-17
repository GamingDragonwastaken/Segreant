/**
 * Ask once, at the end of an interactive `scan --setup`, for a price for the
 * costliest models still priced by a guess: after the card and the public price
 * list have had their turn, the person is the only one who knows what a private,
 * fine-tuned or local model costs. Interactive terminals only, Enter skips, and
 * at most five models, so a long tail never turns setup into a questionnaire.
 */
import { C, color, usd, num } from './ui.ts';
import { promptForUnknownModels, unknownModels } from './pricingDeclareCmd.ts';

const MAX_ASKED = 5;
/** Below this, a guess cannot move a total enough to be worth a question. */
const MIN_COST_USD = 0.5;

export async function askModelPrices(
  tty: boolean,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; interactive: boolean } = {
    input: process.stdin, output: process.stdout, interactive: process.stdin.isTTY === true,
  },
): Promise<number> {
  if (!io.interactive) return 0;
  const guessed = unknownModels().filter((m) => m.costUsd >= MIN_COST_USD);
  if (guessed.length === 0) return 0;
  const asked = guessed.slice(0, MAX_ASKED);
  const write = (line: string) => io.output.write(`${line}\n`);
  write(color(tty, C.bold, '  Models priced by a guess') + color(tty, C.gray, '   not on the rate card (Enter skips)'));
  for (const m of asked) {
    const how = m.rateMatchKind === 'fallback' ? 'generic rate' : 'nearest model on the card';
    write(color(tty, C.gray, `    ${m.model}: ${num(m.requests)} requests, ${usd(m.costUsd)} recorded (estimated, ${how})`));
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  let made = 0;
  try {
    made = (await promptForUnknownModels(asked, {
      ask: (question) => rl.question(`    ${question}: `),
      print: (line) => write(color(tty, C.gray, `  ${line}`)),
    })).length;
  } finally {
    rl.close();
  }
  if (guessed.length > asked.length) write(color(tty, C.gray, `    ${num(guessed.length - asked.length)} more: segreant pricing unknown`));
  if (made > 0) write(color(tty, C.gray, '  Recorded requests keep their estimate until you re-price them: segreant reprice (a preview), then --apply'));
  return made;
}
