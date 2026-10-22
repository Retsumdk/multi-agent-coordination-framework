import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { CoordinationError, describeError, errorExitCode } from "../src/errors.js";
import { AgentRegistry } from "../src/registry.js";
import { LeaseManager } from "../src/lease.js";
import { TaskBoard } from "../src/tasks.js";
import { CoordinationEngine } from "../src/engine.js";
import type { AgentInfo } from "../src/types.js";

describe("AgentRegistry", () => {
  test("registers with deduplicated, sorted capabilities", () => {
    const registry = new AgentRegistry(new ManualClock(1_000));
    const info: AgentInfo = registry.register("alpha", { capabilities: ["write", "compute", "write"] });
    expect(info.id).toBe("alpha");
    expect(info.capabilities).toEqual(["compute", "write"]);
    expect(info.registeredAt).toBe(1_000);
    expect(info.lastHeartbeatAt).toBe(1_000);
    expect(info.metadata).toEqual({});
  });

  test("duplicate registration is rejected", () => {
    const registry = new AgentRegistry(new ManualClock());
    registry.register("alpha");
    expect(() => registry.register("alpha")).toThrow(/AGENT_ALREADY_REGISTERED/);
    expect(() => registry.register("  ")).toThrow(/VALIDATION/);
  });

  test("heartbeats and liveness flow through the clock", () => {
    const clock = new ManualClock(1_000);
    const registry = new AgentRegistry(clock);
    registry.register("alpha");
    expect(registry.isActive("alpha", 5_000)).toBe(true);
    clock.advance(4_999);
    expect(registry.isActive("alpha", 5_000)).toBe(true);
    clock.advance(2);
    expect(registry.isActive("alpha", 5_000)).toBe(false);
    registry.heartbeat("alpha");
    expect(registry.isActive("alpha", 5_000)).toBe(true);
  });

  test("get on an unknown agent throws AGENT_NOT_REGISTERED", () => {
    const registry = new AgentRegistry(new ManualClock());
    expect(() => registry.get("ghost")).toThrow(CoordinationError);
    expect(() => registry.get("ghost")).toThrow(/AGENT_NOT_REGISTERED/);
    expect(registry.has("ghost")).toBe(false);
  });

  test("deregister removes the agent", () => {
    const registry = new AgentRegistry(new ManualClock());
    registry.register("alpha");
    registry.deregister("alpha");
    expect(registry.has("alpha")).toBe(false);
    expect(() => registry.heartbeat("alpha")).toThrow(/AGENT_NOT_REGISTERED/);
  });

  test("list is sorted and defensive-copied", () => {
    const registry = new AgentRegistry(new ManualClock());
    registry.register("zeta");
    registry.register("alpha");
    const listed = registry.list();
    expect(listed.map((a) => a.id)).toEqual(["alpha", "zeta"]);
    expect(registry.size()).toBe(2);
    expect(listed[0].capabilities).toEqual([]);
  });

  test("isActive validates its window", () => {
    const registry = new AgentRegistry(new ManualClock());
    registry.register("alpha");
    expect(() => registry.isActive("alpha", -1)).toThrow(/VALIDATION/);
  });

  test("hasCapability checks membership", () => {
    const registry = new AgentRegistry(new ManualClock());
    registry.register("alpha", { capabilities: ["write"] });
    expect(registry.hasCapability("alpha", "write")).toBe(true);
    expect(registry.hasCapability("alpha", "compute")).toBe(false);
  });
});

describe("module re-exports", () => {
  test("engine exposes its subsystems and helpers", () => {
    const engine = new CoordinationEngine({ clock: new ManualClock(1_000) });
    expect(engine.registry).toBeInstanceOf(AgentRegistry);
    expect(engine.leases).toBeInstanceOf(LeaseManager);
    expect(engine.tasks).toBeInstanceOf(TaskBoard);
    expect(engine.store).toBeDefined();
    expect(errorExitCode("VALIDATION")).toBe(2);
    expect(errorExitCode("CONFLICT")).toBe(1);
    expect(describeError(new CoordinationError("LEASE_HELD", "held"))).toBe("LEASE_HELD: held");
  });
});