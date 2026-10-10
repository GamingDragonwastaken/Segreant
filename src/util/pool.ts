/**
 * Map over items with at most `limit` calls in flight, keeping input order.
 *
 * Most of what the value stage does per repository is waiting on a git child
 * process, so a few at once finish far sooner than one after another, and a
 * bound keeps a machine with fifty repositories from spawning fifty gits.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
