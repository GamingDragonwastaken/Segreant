/** Focus lifecycle primitives shared by browser overlays and source-level tests. */

export interface FocusTarget {
  focus(): void;
  isConnected?: boolean;
}

/** Keep an opener without coupling overlay code to a particular DOM class. */
export function captureFocus(target: FocusTarget | null): FocusTarget | null {
  return target;
}

/** Return focus only to an opener that is still part of the document. */
export function restoreFocus(target: FocusTarget | null): void {
  if (target && target.isConnected !== false) target.focus();
}
