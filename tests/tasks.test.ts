import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { CoordinationEngine } from "../src/engine.js";

function freshEngine(claimLeaseMs = 30_000): CoordinationEngine {
  const engine = new CoordinationEngine({ clock: new ManualClock(1_000), claimLeaseMs });
  engine.registerAgent("alpha", { capabilities: ["write"] });
  engine.registerAgent("beta", { capabilities: ["write", "summarize"] });
  engine.registerAgent("gamma", { capabilities: ["summarize"] });
  return engine;
}

describe("TaskBoard.create", () => {
  test("creates a pending task with normalized capabilities", () => {
    const engine = freshEngine();
    const task = engine.createTask("Summarize papers", { requiredCapabilities: ["summarize", "summarize", "read"] });
    expect(task.id).toBe("task-001");
    expect(task.status).toBe("pending");
    expect(task.requiredCapabilities).toEqual(["read", "summarize"]);
    expect(task.attempts).toBe(0);
    expect(task.maxAttempts).toBe(3);
    expect(task.createdAt).toBe(1_000);
  });

  test("ids are assigned sequentially", () => {
    const engine = freshEngine();
    expect(engine.createTask("a").id).toBe("task-001");
    expect(engine.createTask("b").id).toBe("task-002");
  });

  test("title and maxAttempts are validated", () => {
    const engine = freshEngine();
    expect(() => engine.createTask("   ")).toThrow(/VALIDATION/);
    expect(() => engine.createTask("x", { maxAttempts: 0 })).toThrow(/VALIDATION/);
  });
});

describe("TaskBoard.claim", () => {
  test("an eligible agent claims atomically", () => {
    const engine = freshEngine();
    const task = engine.createTask("Summarize", { requiredCapabilities: ["summarize"] });
    const claimed = engine.tasks.claim(task.id, "beta");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimant).toBe("beta");
    expect(claimed.attempts).toBe(1);
    expect(claimed.leaseExpiresAt).toBe(1_000 + 30_000);
  });

  test("exactly one of two racing claimants wins", () => {
    const engine = freshEngine();
    const task = engine.createTask("Summarize", { requiredCapabilities: ["summarize"] });
    engine.tasks.claim(task.id, "beta");
    expect(() => engine.tasks.claim(task.id, "gamma")).toThrow(/TASK_ALREADY_CLAIMED.*"beta"/s);
  });

  test("claims are capability-gated", () => {
    const engine = freshEngine();
    const task = engine.createTask("Write code", { requiredCapabilities: ["code"] });
    expect(() => engine.tasks.claim(task.id, "gamma")).toThrow(
      /AGENT_CAPABILITY_MISSING.*"code"/s,
    );
    // beta has neither; alpha has "write" only. Nobody unqualified gets in.
    expect(() => engine.tasks.claim(task.id, "alpha")).toThrow(/AGENT_CAPABILITY_MISSING/);
  });

  test("unregistered agents cannot claim", () => {
    const engine = freshEngine();
    const task = engine.createTask("Anything");
    expect(() => engine.tasks.claim(task.id, "stranger")).toThrow(/AGENT_NOT_REGISTERED/);
  });

  test("unknown tasks are TASK_NOT_FOUND; finished tasks are not claimable", () => {
    const engine = freshEngine();
    expect(() => engine.tasks.claim("task-999", "beta")).toThrow(/TASK_NOT_FOUND/);
    const task = engine.createTask("Done deal");
    engine.tasks.claim(task.id, "beta");
    engine.tasks.complete(task.id, "beta");
    expect(() => engine.tasks.claim(task.id, "gamma")).toThrow(/TASK_NOT_CLAIMABLE/);
  });
});

describe("TaskBoard.complete", () => {
  test("only the claimant can complete, and completion stores the result", () => {
    const engine = freshEngine();
    const task = engine.createTask("Summarize");
    engine.tasks.claim(task.id, "beta");
    expect(() => engine.tasks.complete(task.id, "gamma")).toThrow(/NOT_CLAIMANT.*"beta"/s);
    const done = engine.tasks.complete(task.id, "beta", { sections: 5 });
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ sections: 5 });
    expect(done.claimant).toBeNull();
  });

  test("completing a pending task is NOT_CLAIMANT", () => {
    const engine = freshEngine();
    const task = engine.createTask("Summarize");
    expect(() => engine.tasks.complete(task.id, "beta")).toThrow(/NOT_CLAIMANT/);
  });
});

describe("TaskBoard.fail and retry budget", () => {
  test("fail requeues while attempts remain", () => {
    const engine = freshEngine();
    const task = engine.createTask("Risky", { maxAttempts: 3 });
    engine.tasks.claim(task.id, "beta");
    const afterFail = engine.tasks.fail(task.id, "beta", "bad input");
    expect(afterFail.status).toBe("pending");
    expect(afterFail.claimant).toBeNull();
    expect(afterFail.attempts).toBe(1);
  });

  test("the last failure dead-letters the task", () => {
    const engine = freshEngine();
    const task = engine.createTask("Doomed", { maxAttempts: 2 });
    engine.tasks.claim(task.id, "beta");
    engine.tasks.fail(task.id, "beta", "attempt one");
    engine.tasks.claim(task.id, "gamma");
    const dead = engine.tasks.fail(task.id, "gamma", "attempt two");
    expect(dead.status).toBe("failed");
    expect(dead.result).toBe("failed after 2 attempts: last reason: attempt two");
    expect(() => engine.tasks.claim(task.id, "beta")).toThrow(/TASK_NOT_CLAIMABLE/);
  });

  test("only the claimant can fail a task", () => {
    const engine = freshEngine();
    const task = engine.createTask("Risky");
    engine.tasks.claim(task.id, "beta");
    expect(() => engine.tasks.fail(task.id, "alpha")).toThrow(/NOT_CLAIMANT/);
  });
});

describe("TaskBoard.sweep", () => {
  test("expired claims are requeued exactly once", () => {
    const engine = freshEngine(1_000);
    const task = engine.createTask("Stalled");
    engine.tasks.claim(task.id, "beta");
    (engine.clock as ManualClock).advance(1_001);
    expect(engine.tasks.sweep()).toEqual([task.id]);
    expect(engine.tasks.sweep()).toEqual([]);
    const requeued = engine.tasks.get(task.id);
    expect(requeued.status).toBe("pending");
    expect(requeued.claimant).toBeNull();
    // Attempts are preserved across expiry: a reclaim is attempt 2.
    expect(engine.tasks.claim(task.id, "gamma").attempts).toBe(2);
  });

  test("a requeued expired claim still respects maxAttempts via a later failure", () => {
    const engine = freshEngine(1_000);
    const task = engine.createTask("Fragile", { maxAttempts: 2 });
    engine.tasks.claim(task.id, "beta");
    (engine.clock as ManualClock).advance(2_000);
    engine.tasks.sweep(); // attempt 1 burned by expiry
    engine.tasks.claim(task.id, "gamma");
    const dead = engine.tasks.fail(task.id, "gamma", "gave up");
    expect(dead.status).toBe("failed");
    expect(dead.result).toBe("failed after 2 attempts: last reason: gave up");
  });

  test("non-expired claims are untouched by sweep", () => {
    const engine = freshEngine(60_000);
    const task = engine.createTask("Healthy");
    engine.tasks.claim(task.id, "beta");
    (engine.clock as ManualClock).advance(1_000);
    expect(engine.tasks.sweep()).toEqual([]);
    expect(engine.tasks.get(task.id).status).toBe("claimed");
  });
});

describe("TaskBoard.list and get", () => {
  test("list filters by status and sorts by id", () => {
    const engine = freshEngine();
    engine.createTask("First");
    const second = engine.createTask("Second");
    engine.createTask("Third");
    engine.tasks.claim(second.id, "beta");
    expect(engine.tasks.list("claimed").map((t) => t.id)).toEqual(["task-002"]);
    expect(engine.tasks.list("pending").map((t) => t.id)).toEqual(["task-001", "task-003"]);
    expect(engine.tasks.list().length).toBe(3);
    expect(engine.tasks.size()).toBe(3);
    expect(() => engine.tasks.get("task-999")).toThrow(/TASK_NOT_FOUND/);
  });
});