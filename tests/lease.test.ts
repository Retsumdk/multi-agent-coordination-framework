import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { CoordinationError } from "../src/errors.js";
import { LeaseManager } from "../src/lease.js";

describe("LeaseManager.acquire", () => {
  test("grants a lease with the default TTL", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 30_000);
    const lease = leases.acquire("gpu:node-7", "alpha");
    expect(lease).toEqual({ resource: "gpu:node-7", holder: "alpha", acquiredAt: 1_000, expiresAt: 31_000, renewals: 0 });
    expect(leases.isHeld("gpu:node-7")).toBe(true);
    expect(leases.holderOf("gpu:node-7")).toBe("alpha");
  });

  test("a second agent is rejected while the lease is live", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 30_000);
    leases.acquire("gpu:node-7", "alpha");
    try {
      leases.acquire("gpu:node-7", "beta");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CoordinationError);
      expect((error as CoordinationError).code).toBe("LEASE_HELD");
      expect((error as Error).message).toContain('"alpha"');
    }
  });

  test("an expired lease is acquirable by anyone", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 500);
    leases.acquire("gpu:node-7", "alpha");
    clock.advance(500);
    expect(leases.isHeld("gpu:node-7")).toBe(false);
    const lease = leases.acquire("gpu:node-7", "beta");
    expect(lease.holder).toBe("beta");
    expect(lease.acquiredAt).toBe(1_500);
  });

  test("the holder re-acquiring counts as a renewal", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 1_000);
    leases.acquire("r", "alpha");
    clock.advance(500);
    const again = leases.acquire("r", "alpha");
    expect(again.renewals).toBe(1);
    expect(again.expiresAt).toBe(2_500);
  });

  test("ttl and arguments are validated", () => {
    const leases = new LeaseManager(new ManualClock());
    expect(() => leases.acquire("", "alpha")).toThrow(/VALIDATION/);
    expect(() => leases.acquire("r", "")).toThrow(/VALIDATION/);
    expect(() => leases.acquire("r", "alpha", { ttlMs: 0 })).toThrow(/VALIDATION/);
    expect(() => leases.acquire("r", "alpha", { ttlMs: -5 })).toThrow(/VALIDATION/);
  });
});

describe("LeaseManager.renew", () => {
  test("the holder extends the window", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 1_000);
    leases.acquire("r", "alpha");
    clock.advance(500);
    const renewed = leases.renew("r", "alpha", { ttlMs: 5_000 });
    expect(renewed.expiresAt).toBe(6_500);
    expect(renewed.renewals).toBe(1);
  });

  test("a non-holder or expired lease cannot be renewed", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 500);
    leases.acquire("r", "alpha");
    expect(() => leases.renew("r", "beta")).toThrow(/LEASE_NOT_HELD/);
    clock.advance(500);
    expect(() => leases.renew("r", "alpha")).toThrow(/LEASE_NOT_HELD/);
  });
});

describe("LeaseManager.release", () => {
  test("the holder releases immediately", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 30_000);
    leases.acquire("r", "alpha");
    leases.release("r", "alpha");
    expect(leases.isHeld("r")).toBe(false);
    expect(leases.holderOf("r")).toBeNull();
  });

  test("only the holder can release", () => {
    const leases = new LeaseManager(new ManualClock(), 30_000);
    leases.acquire("r", "alpha");
    expect(() => leases.release("r", "beta")).toThrow(/LEASE_NOT_HELD/);
    expect(() => leases.release("r", "alpha")).not.toThrow();
  });
});

describe("LeaseManager.sweep", () => {
  test("drops only expired leases and reports them", () => {
    const clock = new ManualClock(1_000);
    const leases = new LeaseManager(clock, 1_000);
    leases.acquire("a", "alpha", { ttlMs: 500 });
    leases.acquire("b", "beta", { ttlMs: 5_000 });
    clock.advance(1_000);
    expect(leases.sweep()).toEqual(["a"]);
    expect(leases.isHeld("b")).toBe(true);
    expect(leases.list().map((l) => l.resource)).toEqual(["b"]);
  });
});