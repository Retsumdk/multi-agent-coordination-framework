# multi-agent-coordination-framework

Coordination primitives for fleets of autonomous agents: versioned shared state with optimistic concurrency, TTL leases over named resources, deterministic conflict resolution, capability-matched task distribution, and an append-only event log — in strict TypeScript with zero runtime dependencies.

Built by [Retsumdk](https://github.com/Retsumdk).

## The problem

Give two agents the same job board and the same scratchpad and you get the classic multi-agent failure modes:

- **Lost updates.** Agent A reads the plan, Agent B reads the plan, both write. One plan silently vanishes.
- **Stranded resources.** Agent A leases the GPU, crashes. Without TTL expiry, the GPU is locked forever.
- **Stalled work.** Agent A claims a task and dies. Without a claim window + sweep, the task never runs.
- **Unqualified claims.** An agent without the `summarize` capability picks up a summarization task and burns retries.
- **Irreproducible conflicts.** When two writers race, "who won?" must have one answer — and the same answer on every replica.

Human-team coordination tools (databases with row locks, ticket queues) exist, but agents need these semantics in-process: tiny, dependency-free, deterministic, and observable.

## The solution

`multi-agent-coordination-framework` (CLI: `macf`) provides each primitive with its failure mode designed out:

| Primitive | Failure mode it eliminates |
| --- | --- |
| `VersionedStateStore` | Lost updates — stale writes are rejected with `CONFLICT`, never merged silently |
| `LeaseManager` | Stranded resources — every lease has a TTL and expires even if the holder dies |
| `TaskBoard` | Stalled + unqualified work — claims are time-boxed, swept, capability-gated, and retry-budgeted |
| `ConflictResolver` | Irreproducible races — same-instant ties break lexicographically on agent id, so every replica converges |
| `CoordinationEngine` | Observability gaps — one append-only, sequence-numbered event log covers every state/lease/task/agent change |

Zero runtime dependencies. Every time-based decision flows through an injected `Clock`, so tests, demos, and scripted scenarios are byte-for-byte reproducible.

## How it works

```
            ┌────────────────────────────────────────────────┐
            │                CoordinationEngine              │
            │   tryPut / putWithLease / tick / events /      │
            │   registerAgent / createTask                   │
            └───────┬──────────┬──────────┬──────────┬───────┘
                    │          │          │          │
          ┌─────────▼──┐  ┌────▼─────┐ ┌─▼────────┐ ┌▼──────────────┐
          │ Versioned  │  │ Lease    │ │ TaskBoard│ │ AgentRegistry │
          │ StateStore │  │ Manager  │ │ (claims, │ │ (capabilities,│
          │ (versions, │  │ (TTL,    │ │ sweeps,  │ │  heartbeats)  │
          │  history)  │  │  sweeps) │ │ retries) │ └───────────────┘
          └─────┬──────┘  └────┬─────┘ └────┬─────┘
                │              │            │
                └──────────────┴─────┬──────┘
                                     ▼
                    append-only CoordinationEvent log
                     (seq-numbered, subscribe-able)
```

- **Versioned shared state.** Every write bumps a per-key version. Pass `expectedVersion` for compare-and-set semantics; a stale expectation throws `CONFLICT` with the incumbent's version and writer in the message. Full per-key history is retained and `rollback(key, toVersion)` restores an old value as a **new** head version — history is never rewritten.
- **Leases.** `acquire(resource, agent, { ttlMs })` is mutual exclusion with a deadline. Re-acquiring by the holder renews; a different agent gets `LEASE_HELD`. After TTL expiry (visible on the next `sweep()`), the resource is free again.
- **Tasks.** `create` → `claim` → `complete`/`fail`. Claims grant a claim window (`claimLeaseMs`); a claimant that stalls past it is requeued by `sweep()`. Failures requeue until `maxAttempts`, then dead-letter as `failed`. Required capabilities are enforced at claim time.
- **Conflict resolution.** `engine.tryPut(key, value, agent)` is a compare-and-set that never throws on conflict: the incumbent and the losing candidate are handed to the configured resolver, which decides `accept-candidate` or `keep-incumbent`. Every resolution is audited. `LastWriterWinsResolver` breaks same-instant ties by lexicographic agent id — deterministic without communication.
- **The clock.** `ManualClock` makes time a test input. In CI the demo runs twice and the outputs must `diff` clean.

## Getting started

```bash
npm install github:Retsumdk/multi-agent-coordination-framework
```

Or from a clone:

```bash
git clone https://github.com/Retsumdk/multi-agent-coordination-framework.git
cd multi-agent-coordination-framework
bun install
bun test          # 62 tests
bun run build     # tsc -> dist/
bun run demo      # deterministic end-to-end scenario (JSON)
```

Run the CLI from a clone without building separately:

```bash
bun src/cli-run.ts demo
bun src/cli-run.ts run --script examples/scenario.json
```

## Examples

### The deterministic demo

`macf demo` runs a fixed three-agent scenario and prints the transcript:

```bash
$ node dist/cli-run.js demo
{
  "scenario": "three agents coordinate shared state, conflict resolution, and task distribution",
  "resolver": "last-writer-wins",
  "agents": [
    { "id": "alpha",   "capabilities": ["compute", "write"] },
    { "id": "beta",    "capabilities": ["summarize", "write"] },
    { "id": "gamma",   "capabilities": ["compute", "summarize"] }
  ],
  "steps": [
    { "step": 1, "action": "register alpha, beta, gamma", "outcome": "3 agents registered (...)" },
    { "step": 2, "action": "alpha leases 'state:greeting' and writes 'greeting'",
      "outcome": "greeting = \"hello from alpha\" at v1 (lease held during write by alpha, released after)" },
    { "step": 3, "action": "beta writes 'greeting' at the current version",
      "outcome": "uncontested — greeting = \"hello from beta\" at v2" },
    { "step": 4, "action": "gamma writes 'greeting' expecting v1 (actual v2) at the same clock instant",
      "outcome": "conflict → resolver \"last-writer-wins\" decided keep-incumbent (same-instant tie broken lexicographically: \"beta\" < \"gamma\"); ..." },
    { "step": 5, "action": "beta and gamma both claim \"task-001\"",
      "outcome": "beta won the race; the loser got \"TASK_ALREADY_CLAIMED: ...\"" },
    { "step": 6, "action": "advance past the claim window, tick, re-claim, complete",
      "outcome": "1 expired claim(s) requeued: [task-001]; \"task-001\" completed by beta ..." },
    { "step": 7, "action": "gamma leases 'gpu:node-7' for 500ms, clock advances 600ms",
      "outcome": "lease expired (swept: [gpu:node-7]); alpha acquired it ..." }
  ],
  "summary": {
    "stateKeys": 1,
    "conflictsResolved": 1,
    "tasksCompleted": 1,
    "tasksRequeuedByExpiry": 1,
    "leasesExpired": 1,
    "events": 16
  }
}
```

CI diffs two demo runs — a regression that makes coordination non-deterministic fails the build.

### Library usage

```ts
import { CoordinationEngine, LastWriterWinsResolver, ManualClock } from "multi-agent-coordination-framework";

const engine = new CoordinationEngine({
  clock: new ManualClock(1_000),
  resolver: new LastWriterWinsResolver(),
  claimLeaseMs: 30_000,
});

engine.registerAgent("alpha", { capabilities: ["write"] });
engine.registerAgent("beta", { capabilities: ["write"] });

// Lease-guarded shared state write
const { record } = engine.putWithLease("state:plan", "plan", { phase: 1 }, "alpha", { ttlMs: 5_000 });
console.log(record.version); // 1

// Compare-and-set; conflicts resolve deterministically instead of throwing
const outcome = engine.tryPut("plan", { phase: 2 }, "beta", { expectedVersion: 1 });
console.log(outcome.decision, outcome.resolver); // "accept-candidate" "uncontested"

// Capability-matched task distribution
const task = engine.createTask("Summarize findings", { requiredCapabilities: ["write"] });
engine.tasks.claim(task.id, "alpha");
engine.tasks.complete(task.id, "alpha", { sections: 5 });

// Recover expired leases and stalled claims (call from a scheduler loop)
const report = engine.tick();
console.log(report.leasesExpired, report.tasksRequeued);

// Replay exactly what happened, in order
for (const event of engine.events()) {
  console.log(event.seq, event.kind, event.actor, event.detail);
}
```

### Scripted scenarios (CI-friendly)

```bash
$ node dist/cli-run.js run --script examples/scenario.json
{
  "script": "inline",
  "ops": 10,
  "results": [
    { "op": "register",    "index": 0, "ok": true, "summary": "alpha registered with [compute, write]" },
    { "op": "put",         "index": 2, "ok": true, "summary": "plan = {\"phase\":1,\"owner\":\"alpha\"} (v1)" },
    { "op": "try-put",     "index": 3, "ok": true, "summary": "accept-candidate via \"uncontested\" — plan = {\"phase\":2,\"owner\":\"beta\"} (v2)" },
    { "op": "claim",       "index": 6, "ok": true, "summary": "task-001 claimed by beta (attempt 1)" },
    { "op": "tick",        "index": 9, "ok": true, "summary": "swept: 1 expired lease(s), 0 stale claim(s) requeued" }
  ]
}
```

Supported ops: `register`, `put`, `get`, `try-put`, `create-task`, `claim`, `complete`, `fail`, `lease`, `tick`.

## API summary

### `CoordinationEngine`

| Member | Description |
| --- | --- |
| `registerAgent(id, { capabilities?, metadata? })` | Add an agent to membership; duplicates rejected |
| `putWithLease(resource, key, value, agent, { ttlMs? })` | Acquire → write → release; the lease is released even on failure |
| `tryPut(key, value, agent, { expectedVersion? })` | Optimistic write with deterministic conflict resolution; never throws `CONFLICT` |
| `createTask(title, { requiredCapabilities?, maxAttempts? })` | Queue work; ids are `task-001`, `task-002`, … |
| `tick()` | Sweep expired leases + stalled claims; returns `{ leasesExpired, tasksRequeued }` |
| `events()` / `subscribe(fn)` | Sequence-numbered event log with live listeners |
| `store` / `leases` / `tasks` / `registry` / `clock` | The underlying subsystems, individually usable |

### `VersionedStateStore`

`put(key, value, agent, { expectedVersion? })` · `get` · `tryGet` · `has` · `list` · `history(key)` · `rollback(key, toVersion, agent)` · `auditLog()`

### `LeaseManager`

`acquire(resource, agent, { ttlMs? })` · `renew` · `release` · `isHeld` · `holderOf` · `sweep()` · `list()`

### `TaskBoard`

`create` · `claim(taskId, agentId)` · `complete(taskId, agentId, result?)` · `fail(taskId, agentId, reason?)` · `sweep()` · `get` · `list(status?)` · `size()`

### Resolvers

`LastWriterWinsResolver` · `FirstWriterWinsResolver` · `createResolver(name, fn)` — all implement `ConflictResolver` with a stable `name` recorded in the audit trail.

## Error model

Every failure is a `CoordinationError` carrying a stable code and an exit-code mapping (0 ok / 1 runtime / 2 usage):

| Code | Meaning |
| --- | --- |
| `CONFLICT` | Stale optimistic write (expected version ≠ current) |
| `LEASE_HELD` | Resource is held by another agent and not expired |
| `LEASE_NOT_HELD` | Renew/release by an agent that does not hold the lease |
| `TASK_ALREADY_CLAIMED` / `TASK_NOT_CLAIMABLE` / `TASK_NOT_FOUND` | Claim-state violations |
| `NOT_CLAIMANT` | Complete/fail by a non-claimant |
| `AGENT_CAPABILITY_MISSING` | Claimant lacks a required capability |
| `AGENT_NOT_REGISTERED` / `AGENT_ALREADY_REGISTERED` | Membership violations |
| `KEY_NOT_FOUND` / `VERSION_NOT_FOUND` | State/rollback lookups |
| `VALIDATION` | Bad arguments (usage error) |

## Design notes

- **Determinism is load-bearing.** A coordination layer that resolves races non-deterministically cannot be tested. Every time source is an injected `Clock`; the resolver's tie-break is a pure function of `(writtenAt, agentId)`; the demo is diff-checked in CI.
- **Rollback is additive.** Restoring an old value creates a new head version and appends the displaced head to history — an undo is itself auditable and reversible.
- **Sweeps are idempotent.** `tick()` is safe to call from any number of schedulers: expired things are handled exactly once and reported by id.
- **Claims are lease-backed.** The claim window and the lease manager share the same expiry semantics, so a stalled claimant and a crashed lease holder recover through the same mechanism.

## Scope

This framework coordinates agents **in one process** (or many processes sharing one engine behind your own transport). It is not a distributed consensus protocol, a message broker, or a persistent database — the store, leases, tasks, and event log are in-memory and restart with the process. Pair it with your own persistence layer when durability across restarts is required.

## Development

```bash
bun install
bun run typecheck   # tsc over src + tests
bun test            # 62 tests
bun run build       # emits dist/ with declarations
```

## License

MIT — see [LICENSE](LICENSE).