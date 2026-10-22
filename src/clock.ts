export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
};

/**
 * Deterministic clock for tests, demos, and scripted scenarios.
 * Time only moves when you advance it, so every run is reproducible.
 */
export class ManualClock implements Clock {
  #t: number;

  constructor(start = 0) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`ManualClock.advance requires a non-negative finite number, got ${ms}`);
    }
    this.#t += ms;
  }

  set(ms: number): void {
    this.#t = ms;
  }
}