import type { Clock } from "./clock.js";
import { CoordinationError } from "./errors.js";
import { LeaseManager } from "./lease.js";
import { AgentRegistry } from "./registry.js";
import { LastWriterWinsResolver } from "./resolver.js";
import type { ConflictDecision, ConflictResolver } from "./resolver.js";
import { VersionedStateStore } from "./store.js";
import { TaskBoard } from "./tasks.js";
import type {
  AgentId,
  AgentInfo,
  CoordinationEvent,
  CreateTaskOptions,
  EventKind,
  EventListener,
  Lease,
  LeaseOptions,
  RegisterOptions,
  StateRecord,
  TaskRecord,
} from "./types.js";

export interface EngineOptions {
  clock?: Clock;
  resolver?: ConflictResolver;
  /** Default TTL when an agent acquires a lease without naming one. Default 30s. */
  defaultLeaseTtlMs?: number;
  /** How long a task claim holds before sweep() requeues it. Default 30s. */
  claimLeaseMs?: number;
}

export interface PutOutcome<T = unknown> {
  record: StateRecord<T>;
  lease: Lease;
}

export interface ConflictResolution<T = unknown> {
  resolved: true;
  decision: ConflictDecision;
  resolver: string;
  record: StateRecord<T>;
}

export interface TickReport {
  leasesExpired: string[];
  tasksRequeued: string[];
}

/**
 * Facade wiring the registry, shared state, leases, conflict resolution, and
 * task board into one coordination surface with a single append-only event log.
 *
 * Events are numbered by insertion order, so a full replay of `events()`
 * reconstructs exactly what happened, in order — deterministically when a
 * ManualClock is supplied.
 */
export class CoordinationEngine {
  readonly registry: AgentRegistry;
  readonly store: VersionedStateStore;
  readonly leases: LeaseManager;
  readonly tasks: TaskBoard;
  readonly clock: Clock;

  readonly #resolver: ConflictResolver;
  readonly #defaultLeaseTtlMs: number;
  #events: CoordinationEvent[] = [];
  #seq = 0;
  #listeners = new Set<EventListener>();

  constructor(options: EngineOptions = {}) {
    const clock = options.clock ?? { now: () => Date.now() };
    this.clock = clock;
    this.#resolver = options.resolver ?? new LastWriterWinsResolver();
    this.#defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;

    const emit = (kind: EventKind, actor: AgentId | "system", detail: string): void => {
      const event: CoordinationEvent = { seq: ++this.#seq, at: clock.now(), kind, actor, detail };
      this.#events.push(event);
      for (const listener of this.#listeners) listener(event);
    };

    this.registry = new AgentRegistry(clock, emit);
    this.store = new VersionedStateStore(clock, emit);
    this.leases = new LeaseManager(clock, this.#defaultLeaseTtlMs, emit);
    this.tasks = new TaskBoard(clock, this.registry, { claimLeaseMs: options.claimLeaseMs }, emit);
  }

  registerAgent(id: string, options: RegisterOptions = {}): AgentInfo {
    return this.registry.register(id, options);
  }

  /**
   * Lease-guarded write: acquire the resource, write the state, release.
   * The lease is released even when the write fails, so a rejected write
   * never strands a resource.
   */
  putWithLease<T>(resource: string, key: string, value: T, agent: AgentId, options: LeaseOptions = {}): PutOutcome<T> {
    this.registry.get(agent);
    const lease = this.leases.acquire(resource, agent, options);
    try {
      const record = this.store.put(key, value, agent);
      return { record, lease };
    } finally {
      this.leases.release(resource, agent);
    }
  }

  /**
   * Optimistic write with automatic conflict resolution.
   *
   * The write is attempted against the caller's `expectedVersion` (defaulting
   * to the current head version, i.e. an uncontended compare-and-set). If
   * another agent won the version race, the engine hands both sides to the
   * configured resolver and either overwrites deterministically or keeps the
   * incumbent — it never throws CONFLICT to the caller, and every resolution
   * lands in the audit trail.
   */
  tryPut<T>(key: string, value: T, agent: AgentId, options: { expectedVersion?: number } = {}): ConflictResolution<T> {
    this.registry.get(agent);
    const candidateAt = this.clock.now();
    const current = this.store.tryGet<T>(key);
    const expectedVersion =
      options.expectedVersion !== undefined ? options.expectedVersion : current ? current.version : 0;
    try {
      const record = this.store.put(key, value, agent, { expectedVersion });
      return { resolved: true, decision: "accept-candidate", resolver: "uncontested", record };
    } catch (error) {
      if (!(error instanceof CoordinationError) || error.code !== "CONFLICT") {
        throw error;
      }
      const incumbent = this.store.get<T>(key);
      const decision = this.#resolver.resolve({ key, incumbent, candidate: { agent, value, at: candidateAt } });
      if (decision === "keep-incumbent") {
        this.store.forceAuditConflict(agent, this.#resolver.name, decision, key);
        return { resolved: true, decision, resolver: this.#resolver.name, record: incumbent };
      }
      const record = this.store.forceWrite(key, value, agent, this.#resolver.name);
      return { resolved: true, decision, resolver: this.#resolver.name, record };
    }
  }

  /** Recover expired leases and stalled task claims. Call from a scheduler loop. */
  tick(): TickReport {
    const leasesExpired = this.leases.sweep();
    const tasksRequeued = this.tasks.sweep();
    return { leasesExpired, tasksRequeued };
  }

  createTask(title: string, options: CreateTaskOptions = {}): TaskRecord {
    return this.tasks.create(title, options);
  }

  events(): readonly CoordinationEvent[] {
    return this.#events.map((e) => ({ ...e }));
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}