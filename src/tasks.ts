import type { Clock } from "./clock.js";
import { CoordinationError } from "./errors.js";
import { AgentRegistry } from "./registry.js";
import type { AgentId, CreateTaskOptions, EventKind, TaskId, TaskRecord, TaskStatus } from "./types.js";

type TaskEventSink = (
  kind: Extract<EventKind, "task.create" | "task.claim" | "task.complete" | "task.fail" | "task.requeue">,
  actor: AgentId | "system",
  detail: string,
) => void;

export interface TaskBoardOptions {
  /** How long a claim holds before sweep() requeues the task. Default 30s. */
  claimLeaseMs?: number;
  /** Default per-task retry cap. Default 3. */
  defaultMaxAttempts?: number;
}

function cloneTask(task: TaskRecord): TaskRecord {
  return { ...task, requiredCapabilities: [...task.requiredCapabilities] };
}

/**
 * Collaborative task distribution with atomic claims and lease-based
 * progress tracking.
 *
 * A claim grants the claimant a time-boxed window. A claimant that stalls
 * past the window loses the claim on the next sweep() and the task returns
 * to the pending queue — no crashed agent can strand work. Failed attempts
 * are requeued up to maxAttempts, then dead-lettered as "failed".
 */
export class TaskBoard {
  #tasks = new Map<TaskId, TaskRecord>();
  #nextId = 1;
  readonly #clock: Clock;
  readonly #registry: AgentRegistry;
  readonly #claimLeaseMs: number;
  readonly #defaultMaxAttempts: number;
  readonly #onEvent: TaskEventSink | null;

  constructor(
    clock: Clock = { now: () => Date.now() },
    registry?: AgentRegistry,
    options: TaskBoardOptions = {},
    onEvent: TaskEventSink | null = null,
  ) {
    this.#clock = clock;
    this.#registry = registry ?? new AgentRegistry(clock);
    this.#claimLeaseMs = options.claimLeaseMs ?? 30_000;
    this.#defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
    this.#onEvent = onEvent;
    this.#onEvent = onEvent;
  }

  create(title: string, options: CreateTaskOptions = {}): TaskRecord {
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new CoordinationError("VALIDATION", "task title must be a non-empty string");
    }
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new CoordinationError("VALIDATION", `maxAttempts must be a positive integer, got ${maxAttempts}`);
    }
    const id = `task-${String(this.#nextId).padStart(3, "0")}`;
    this.#nextId += 1;
    const record: TaskRecord = {
      id,
      title,
      requiredCapabilities: [...new Set(options.requiredCapabilities ?? [])].sort(),
      status: "pending",
      claimant: null,
      claimedAt: null,
      leaseExpiresAt: null,
      attempts: 0,
      maxAttempts,
      result: null,
      createdAt: this.#clock.now(),
    };
    this.#tasks.set(id, record);
    this.#onEvent?.("task.create", "system", `"${id}" created: ${title} (requires [${record.requiredCapabilities.join(", ")}])`);
    return cloneTask(record);
  }

  claim(taskId: string, agentId: string): TaskRecord {
    const agent = this.#registry.get(agentId);
    const task = this.#require(taskId);
    if (task.status === "claimed") {
      throw new CoordinationError("TASK_ALREADY_CLAIMED", `"${taskId}" is already claimed by "${task.claimant}"`);
    }
    if (task.status !== "pending") {
      throw new CoordinationError("TASK_NOT_CLAIMABLE", `"${taskId}" is ${task.status} and cannot be claimed`);
    }
    const missing = task.requiredCapabilities.filter((c) => !agent.capabilities.includes(c));
    if (missing.length > 0) {
      throw new CoordinationError(
        "AGENT_CAPABILITY_MISSING",
        `"${agentId}" lacks required capabilities for "${taskId}": "${missing.join('", "')}"`,
      );
    }
    task.status = "claimed";
    task.claimant = agentId;
    task.claimedAt = this.#clock.now();
    task.leaseExpiresAt = this.#clock.now() + this.#claimLeaseMs;
    task.attempts += 1;
    this.#onEvent?.("task.claim", agentId, `"${taskId}" claimed by "${agentId}" (attempt ${task.attempts}/${task.maxAttempts})`);
    return cloneTask(task);
  }

  complete(taskId: string, agentId: string, result: unknown = null): TaskRecord {
    const task = this.#require(taskId);
    this.#requireClaimant(task, agentId);
    task.status = "done";
    task.result = result;
    task.claimant = null;
    task.claimedAt = null;
    task.leaseExpiresAt = null;
    this.#onEvent?.("task.complete", agentId, `"${taskId}" completed by "${agentId}"`);
    return cloneTask(task);
  }

  fail(taskId: string, agentId: string, reason = "unspecified"): TaskRecord {
    const task = this.#require(taskId);
    this.#requireClaimant(task, agentId);
    if (task.attempts >= task.maxAttempts) {
      task.status = "failed";
      task.result = `failed after ${task.attempts} attempts: last reason: ${reason}`;
      task.claimant = null;
      task.claimedAt = null;
      task.leaseExpiresAt = null;
      this.#onEvent?.("task.fail", agentId, `"${taskId}" dead-lettered after ${task.attempts} attempts (reason: ${reason})`);
      return cloneTask(task);
    }
    task.status = "pending";
    task.claimant = null;
    task.claimedAt = null;
    task.leaseExpiresAt = null;
    this.#onEvent?.("task.fail", agentId, `"${taskId}" failed by "${agentId}" (reason: ${reason})`);
    this.#onEvent?.("task.requeue", "system", `"${taskId}" requeued for another attempt (${task.attempts}/${task.maxAttempts} used)`);
    return cloneTask(task);
  }

  /** Requeue claimed tasks whose claim window expired. Returns the requeued task ids. */
  sweep(): string[] {
    const now = this.#clock.now();
    const requeued: string[] = [];
    for (const task of this.#tasks.values()) {
      if (task.status === "claimed" && task.leaseExpiresAt !== null && task.leaseExpiresAt <= now) {
        task.status = "pending";
        const lostClaimant = task.claimant;
        task.claimant = null;
        task.claimedAt = null;
        task.leaseExpiresAt = null;
        this.#onEvent?.("task.requeue", "system", `"${task.id}" claim by "${lostClaimant}" expired; requeued (${task.attempts}/${task.maxAttempts} used)`);
        requeued.push(task.id);
      }
    }
    return requeued;
  }

  get(taskId: string): TaskRecord {
    return cloneTask(this.#require(taskId));
  }

  list(status?: TaskStatus): TaskRecord[] {
    const all = [...this.#tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
    const filtered = status ? all.filter((t) => t.status === status) : all;
    return filtered.map(cloneTask);
  }

  size(): number {
    return this.#tasks.size;
  }

  #require(taskId: string): TaskRecord {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new CoordinationError("TASK_NOT_FOUND", `no task "${taskId}"`);
    }
    return task;
  }

  #requireClaimant(task: TaskRecord, agentId: string): void {
    if (task.status !== "claimed") {
      throw new CoordinationError("NOT_CLAIMANT", `"${task.id}" is ${task.status}, not claimed by anyone`);
    }
    if (task.claimant !== agentId) {
      throw new CoordinationError("NOT_CLAIMANT", `"${task.id}" is claimed by "${task.claimant}", not "${agentId}"`);
    }
  }
}