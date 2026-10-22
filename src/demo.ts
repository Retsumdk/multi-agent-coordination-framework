import { ManualClock } from "./clock.js";
import { CoordinationEngine } from "./engine.js";
import { LastWriterWinsResolver } from "./resolver.js";
import { describeError } from "./errors.js";

export interface DemoStep {
  step: number;
  action: string;
  outcome: string;
}

export interface DemoResult {
  scenario: string;
  resolver: string;
  agents: { id: string; capabilities: string[] }[];
  steps: DemoStep[];
  summary: {
    stateKeys: number;
    conflictsResolved: number;
    tasksCompleted: number;
    tasksRequeuedByExpiry: number;
    leasesExpired: number;
    events: number;
  };
}

/**
 * Deterministic end-to-end scenario. Uses a ManualClock and fixed agent ids,
 * so two runs produce byte-identical output (asserted in CI).
 *
 * Narrative:
 *  1. Three agents register with overlapping capabilities.
 *  2. alpha writes shared state through a lease; beta's write lands cleanly.
 *  3. gamma races beta on the same version at the same clock instant — the
 *     conflict is resolved deterministically: LWW ties break lexicographically,
 *     so the incumbent survives and the resolution is audited.
 *  4. beta and gamma race to claim the same task; exactly one wins.
 *  5. The winner's claim expires mid-flight; a sweep requeues the task and
 *     beta picks it up and completes it.
 *  6. A held lease expires; the resource becomes acquirable again.
 */
export function runDemo(): DemoResult {
  const clock = new ManualClock(1_000);
  const engine = new CoordinationEngine({ clock, resolver: new LastWriterWinsResolver(), claimLeaseMs: 60_000 });
  const steps: DemoStep[] = [];

  const alpha = engine.registerAgent("alpha", { capabilities: ["write", "compute"] });
  const beta = engine.registerAgent("beta", { capabilities: ["write", "summarize"] });
  engine.registerAgent("gamma", { capabilities: ["compute", "summarize"] });
  steps.push({
    step: 1,
    action: "register alpha, beta, gamma",
    outcome: `3 agents registered (capabilities: [${alpha.capabilities.join(", ")}], [${beta.capabilities.join(", ")}], ...)`,
  });

  clock.advance(100);
  const leased = engine.putWithLease("state:greeting", "greeting", "hello from alpha", "alpha", { ttlMs: 60_000 });
  steps.push({
    step: 2,
    action: "alpha leases 'state:greeting' and writes 'greeting'",
    outcome: `greeting = "${String(leased.record.value)}" at v${String(leased.record.version)} (lease held during write by ${String(leased.lease.holder)}, released after)`,
  });

  clock.advance(100);
  const betaWrite = engine.tryPut("greeting", "hello from beta", "beta");
  steps.push({
    step: 3,
    action: "beta writes 'greeting' at the current version",
    outcome: `uncontested — greeting = "${String(betaWrite.record.value)}" at v${String(betaWrite.record.version)}`,
  });

  const gammaWrite = engine.tryPut("greeting", "hello from gamma", "gamma", { expectedVersion: 1 });
  steps.push({
    step: 4,
    action: "gamma writes 'greeting' expecting v1 (actual v2) at the same clock instant",
    outcome: `conflict → resolver "${gammaWrite.resolver}" decided ${String(gammaWrite.decision)} (same-instant tie broken lexicographically: "beta" < "gamma"); value is still "${String(gammaWrite.record.value)}" at v${String(gammaWrite.record.version)}`,
  });

  const task = engine.tasks.create("Summarize 40 research papers", { requiredCapabilities: ["summarize"], maxAttempts: 2 });
  clock.advance(100);
  let winner = "";
  let loserError = "";
  for (const agent of ["beta", "gamma"] as const) {
    try {
      engine.tasks.claim(task.id, agent);
      winner = agent;
    } catch (error) {
      loserError = describeError(error);
    }
  }
  steps.push({
    step: 5,
    action: `beta and gamma both claim "${task.id}"`,
    outcome: `${winner} won the race; the loser got "${loserError}"`,
  });

  clock.advance(70_000);
  const requeued = engine.tick();
  const reclaimed = engine.tasks.claim(task.id, "beta");
  engine.tasks.complete(task.id, "beta", { summaries: 40, ok: true });
  steps.push({
    step: 6,
    action: "advance past the claim window, tick, re-claim, complete",
    outcome: `${String(requeued.tasksRequeued.length)} expired claim(s) requeued: [${requeued.tasksRequeued.join(", ")}]; "${reclaimed.id}" completed by beta with result {"summaries":40,"ok":true}`,
  });

  clock.advance(100);
  const agentLease = engine.leases.acquire("gpu:node-7", "gamma", { ttlMs: 500 });
  clock.advance(600);
  const expired = engine.leases.sweep();
  const reclaimedBy = engine.leases.acquire("gpu:node-7", "alpha", { ttlMs: 60_000 });
  steps.push({
    step: 7,
    action: "gamma leases 'gpu:node-7' for 500ms, clock advances 600ms",
    outcome: `lease expired (swept: [${expired.join(", ")}]); alpha acquired it (holder: ${String(reclaimedBy.holder)}, was: ${String(agentLease.holder)})`,
  });

  return {
    scenario: "three agents coordinate shared state, conflict resolution, and task distribution",
    resolver: "last-writer-wins",
    agents: engine.registry.list().map((a) => ({ id: a.id, capabilities: [...a.capabilities] })),
    steps,
    summary: {
      stateKeys: engine.store.list().length,
      conflictsResolved: engine.events().filter((e) => e.kind === "state.conflict-resolved").length,
      tasksCompleted: engine.tasks.list("done").length,
      tasksRequeuedByExpiry: requeued.tasksRequeued.length,
      leasesExpired: expired.length,
      events: engine.events().length,
    },
  };
}