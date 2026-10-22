/**
 * Minimal ambient types for the bun:test runner surface used by this test
 * suite, so `tsc -p tsconfig.test.json` can typecheck tests without pulling
 * the full bun-types package (which conflicts with @types/node globals).
 */

declare module "bun:test" {
  interface Expectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toThrow(expected?: RegExp | string | Error | (new (...args: never[]) => Error)): void;
    toContain(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(length: number): void;
    toBeInstanceOf(expected: unknown): void;
    toHaveProperty(path: string): void;
    unreachable(...args: never[]): never;
    readonly not: Expectation;
    readonly resolves: PromiseExpectation;
    readonly rejects: PromiseExpectation;
  }

  interface PromiseExpectation {
    toBe(expected: unknown): Promise<void>;
    toEqual(expected: unknown): Promise<void>;
    toThrow(expected?: RegExp | string | Error | (new (...args: never[]) => Error)): Promise<void>;
    readonly not: PromiseExpectation;
  }

  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => unknown): void;
  export function it(name: string, fn: () => unknown): void;
  export function expect(actual: unknown): Expectation;
  export namespace expect {
    function unreachable(...args: never[]): never;
  }
  export function beforeAll(fn: () => unknown): void;
  export function afterAll(fn: () => unknown): void;
  export function beforeEach(fn: () => unknown): void;
  export function afterEach(fn: () => unknown): void;
}

interface ImportMeta {
  readonly dir: string;
}
