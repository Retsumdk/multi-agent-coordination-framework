import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { CoordinationEngine } from "../src/engine.js";
import { createResolver, FirstWriterWinsResolver, LastWriterWinsResolver } from "../src/resolver.js";
import type { ConflictResolver } from "../src/resolver.js";

function engineWith(resolver: ConflictResolver): CoordinationEngine {
  return new CoordinationEngine({ clock: new ManualClock(1_000), resolver });
}

describe("resolver semantics (unit)", () => {
  test("last-writer-wins prefers the later write", () => {
    const resolver = new LastWriterWinsResolver();
    const incumbent = {
      key: "k", value: "old", version: 2, writtenBy: "alpha", writtenAt: 1_000, history: [],
    };
    expect(resolver.resolve({ key: "k", incumbent, candidate: { agent: "beta", value: "new", at: 1_500 } })).toBe("accept-candidate");
    expect(resolver.resolve({ key: "k", incumbent, candidate: { agent: "beta", value: "new", at: 500 } })).toBe("keep-incumbent");
  });

  test("same-instant ties break lexicographically on agent id", () => {
    const resolver = new LastWriterWinsResolver();
    const incumbent = { key: "k", value: "old", version: 1, writtenBy: "beta", writtenAt: 1_000, history: [] };
    expect(resolver.resolve({ key: "k", incumbent, candidate: { agent: "gamma", value: "new", at: 1_000 } })).toBe("keep-incumbent");
    expect(resolver.resolve({ key: "k", incumbent, candidate: { agent: "alpha", value: "new", at: 1_000 } })).toBe("accept-candidate");
  });

  test("first-writer-wins always keeps the incumbent", () => {
    const resolver = new FirstWriterWinsResolver();
    const incumbent = { key: "k", value: "old", version: 1, writtenBy: "alpha", writtenAt: 1_000, history: [] };
    expect(resolver.resolve({ key: "k", incumbent, candidate: { agent: "beta", value: "new", at: 9_999 } })).toBe("keep-incumbent");
  });

  test("createResolver validates and wraps custom logic", () => {
    const resolver = createResolver("gamma-always-wins", () => "accept-candidate");
    expect(resolver.name).toBe("gamma-always-wins");
    expect(() => createResolver("", () => "keep-incumbent")).toThrow(/non-empty/);
  });
});

describe("engine.tryPut resolution", () => {
  test("uncontested compare-and-set writes cleanly", () => {
    const engine = engineWith(new LastWriterWinsResolver());
    engine.registerAgent("alpha");
    const first = engine.tryPut("k", "v1", "alpha");
    expect(first.decision).toBe("accept-candidate");
    expect(first.resolver).toBe("uncontested");
    expect(first.record.version).toBe(1);
    const second = engine.tryPut("k", "v2", "alpha");
    expect(second.record.version).toBe(2);
    expect(second.record.history.length).toBe(1);
  });

  test("a losing candidate is resolved deterministically and audited (LWW tie)", () => {
    const engine = engineWith(new LastWriterWinsResolver());
    engine.registerAgent("beta");
    engine.registerAgent("gamma");
    engine.tryPut("k", "from-beta", "beta");
    engine.tryPut("k", "from-beta-v2", "beta"); // same instant, uncontested -> v2
    const outcome = engine.tryPut("k", "from-gamma", "gamma", { expectedVersion: 1 }); // stale -> CONFLICT
    expect(outcome.decision).toBe("keep-incumbent");
    expect(outcome.resolver).toBe("last-writer-wins");
    expect(outcome.record.writtenBy).toBe("beta");
    expect(outcome.record.value).toBe("from-beta-v2");
    expect(outcome.record.version).toBe(2);
    const conflictEvents = engine.events().filter((e) => e.kind === "state.conflict-resolved");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].detail).toContain("last-writer-wins");
  });

  test("a winning candidate overwrites through the resolver and is audited (LWW later write)", () => {
    const engine = engineWith(new LastWriterWinsResolver());
    engine.registerAgent("alpha");
    engine.registerAgent("beta");
    engine.tryPut("k", "first", "alpha");
    engine.tryPut("k", "second", "beta"); // same instant, uncontested -> v2
    (engine.clock as ManualClock).advance(500);
    const outcome = engine.tryPut("k", "third", "beta", { expectedVersion: 1 }); // stale -> CONFLICT
    expect(outcome.decision).toBe("accept-candidate");
    expect(outcome.record.value).toBe("third");
    expect(outcome.record.version).toBe(3);
    expect(outcome.record.writtenBy).toBe("beta");
    const conflictEvents = engine.events().filter((e) => e.kind === "state.conflict-resolved");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0].detail).toContain("accepted over v2");
  });

  test("first-writer-wins keeps the incumbent even on a later candidate", () => {
    const engine = engineWith(new FirstWriterWinsResolver());
    engine.registerAgent("alpha");
    engine.registerAgent("beta");
    engine.tryPut("k", "first", "alpha");
    engine.tryPut("k", "first-v2", "alpha"); // same instant, uncontested -> v2
    (engine.clock as ManualClock).advance(500);
    const outcome = engine.tryPut("k", "second", "beta", { expectedVersion: 1 }); // stale -> CONFLICT
    expect(outcome.decision).toBe("keep-incumbent");
    expect(outcome.record.value).toBe("first-v2");
    expect(outcome.record.writtenBy).toBe("alpha");
    expect(engine.store.get("k").version).toBe(2);
  });

  test("a custom resolver decides the winner", () => {
    const engine = engineWith(createResolver("sum-the-values", () => "accept-candidate"));
    engine.registerAgent("alpha");
    engine.registerAgent("beta");
    engine.tryPut("k", 1, "alpha");
    engine.tryPut("k", 2, "alpha"); // same instant, uncontested -> v2
    (engine.clock as ManualClock).advance(100);
    const outcome = engine.tryPut("k", 41, "beta", { expectedVersion: 1 }); // stale -> CONFLICT
    expect(outcome.resolver).toBe("sum-the-values");
    expect(outcome.record.value).toBe(41);
    expect(engine.store.get("k").version).toBe(3);
  });

  test("tryPut on an unregistered agent is rejected before touching state", () => {
    const engine = engineWith(new LastWriterWinsResolver());
    expect(() => engine.tryPut("k", "v", "ghost")).toThrow(/AGENT_NOT_REGISTERED/);
    expect(engine.store.has("k")).toBe(false);
  });
});