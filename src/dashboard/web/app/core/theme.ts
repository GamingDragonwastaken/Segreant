/**
 * Appearance: follow the operating system, or a fixed light or dark choice.
 *
 * The stylesheet keys every light-theme rule on `:root[data-theme='light']`, so
 * the theme is resolved here and written to that attribute, rather than
 * repeating the token block under a media query. "System" is the default and
 * tracks the OS live; an explicit choice is kept in this browser only.
 */

import { signal } from './signal.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'segreant.theme';

function storedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export const themeChoice = signal<ThemeChoice>(storedChoice());

const prefersLight = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

function apply(): void {
  const choice = themeChoice();
  const resolved = choice === 'system' ? (prefersLight?.matches ? 'light' : 'dark') : choice;
  document.documentElement.dataset.theme = resolved;
  // Native controls, scrollbars and autofill follow the page, not the OS.
  document.documentElement.style.colorScheme = resolved;
}

export function setTheme(choice: ThemeChoice): void {
  themeChoice.set(choice);
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage can be unavailable (private windows, blocked site data). The
    // choice still applies for this visit.
  }
  apply();
}

/** Run once before the first render, so the page never paints in the wrong theme. */
export function initTheme(): void {
  apply();
  prefersLight?.addEventListener('change', () => { if (themeChoice() === 'system') apply(); });
}
