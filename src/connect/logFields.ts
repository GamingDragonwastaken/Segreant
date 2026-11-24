/** Reading one field of another program's log record, which may hold anything. */

/** The text, or null when the field holds no text. */
export function textField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A token count, or 0 when the field holds no whole, positive number. */
export function tokenField(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;
}
