/**
 * Reactive primitive — about eighty lines instead of a framework.
 *
 * A signal is a value you can subscribe to. An effect re-runs when any signal it
 * READ during its last run changes; dependencies are tracked automatically, so
 * nothing has to declare them and nothing goes stale because someone forgot to.
 *
 * This exists because Fiscus ships zero runtime dependencies and the GUI page
 * must stay readable in view-source. A financial tool that asks you to inspect
 * its numbers cannot ship a minified bundle you are asked to trust.
 */

type Cleanup = () => void;

interface Effect {
  run: () => void;
  deps: Set<Set<Effect>>;
  cleanups: Cleanup[];
  disposed: boolean;
}

let active: Effect | null = null;
/** Effects queued by writes inside a batch, flushed once at the end. */
let pending: Set<Effect> | null = null;

export interface Signal<T> {
  (): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  peek: () => T;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Effect>();

  const read = (() => {
    if (active) {
      subscribers.add(active);
      active.deps.add(subscribers);
    }
    return value;
  }) as Signal<T>;

  read.peek = () => value;

  read.set = (next: T) => {
    // Object.is so setting NaN or -0 behaves, and so an unchanged primitive
    // does not schedule work. Objects always notify: we do not deep-compare.
    if (Object.is(value, next)) return;
    value = next;
    notify(subscribers);
  };

  read.update = (fn: (current: T) => T) => read.set(fn(value));

  return read;
}

function notify(subscribers: Set<Effect>): void {
  // Copy first: an effect re-running will re-subscribe and mutate the set.
  const queue = Array.from(subscribers);
  if (pending) {
    for (const e of queue) pending.add(e);
    return;
  }
  for (const e of queue) if (!e.disposed) e.run();
}

/** Coalesce many writes into one round of effect runs. */
export function batch(fn: () => void): void {
  if (pending) return void fn();
  const queue = (pending = new Set<Effect>());
  try {
    fn();
  } finally {
    pending = null;
    for (const e of queue) if (!e.disposed) e.run();
  }
}

/**
 * Run `fn`, re-running it whenever a signal it read changes. Returns a disposer.
 * `onCleanup` inside `fn` registers teardown for the NEXT run (and for disposal),
 * which is how event listeners and timers avoid piling up across re-renders.
 */
export function effect(fn: () => void): Cleanup {
  const e: Effect = {
    deps: new Set(),
    cleanups: [],
    disposed: false,
    run: () => {
      if (e.disposed) return;
      for (const c of e.cleanups) c();
      e.cleanups = [];
      for (const dep of e.deps) dep.delete(e);
      e.deps.clear();

      const previous = active;
      active = e;
      try {
        fn();
      } finally {
        active = previous;
      }
    },
  };
  e.run();
  return () => {
    e.disposed = true;
    for (const c of e.cleanups) c();
    for (const dep of e.deps) dep.delete(e);
    e.deps.clear();
  };
}

/**
 * Run an effect and register its disposer with the currently active effect.
 * View factories use this boundary so navigation/rerender cleanup tears down
 * fetches and subscriptions that were created while the view was rendered.
 * Outside an active scope it behaves like a normal effect.
 */
export function scopedEffect(fn: () => void): Cleanup {
  const dispose = effect(fn);
  onCleanup(dispose);
  return dispose;
}

export function onCleanup(fn: Cleanup): void {
  if (active) active.cleanups.push(fn);
}

/** Read signals without subscribing — for effects that should not re-run on them. */
export function untracked<T>(fn: () => T): T {
  const previous = active;
  active = null;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

/** A cached derivation. Recomputes only when one of its own sources changes. */
export function computed<T>(fn: () => T): () => T {
  const out = signal<T>(undefined as T);
  let started = false;
  return () => {
    if (!started) {
      started = true;
      effect(() => out.set(fn()));
    }
    return out();
  };
}
