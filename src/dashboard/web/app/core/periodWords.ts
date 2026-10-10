/** The period as a reader says it. Pure, so claim derivation can use it under test. */

import type { Range } from './api.ts';

export function periodWords(r: Range | string): string {
  switch (r) {
    case 'today': return 'today';
    case '7d': return 'last 7 days';
    case '30d': return 'last 30 days';
    case 'all': return 'all recorded time';
    default: return r;
  }
}
