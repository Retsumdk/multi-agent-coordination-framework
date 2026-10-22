export type AgentId = string;
export type StateKey = string;
export type ResourceId = string;
export type TaskId = string;

export interface StateSnapshot<T = unknown> {
  version: number;
  value: T;
  writtenBy: AgentId;
  writtenAt: number;
}

export interface StateRecord<T = unknown> {
  key: StateKey;
  value: T;
  version: number;
  writtenBy: AgentId;
  writtenAt: number;
  /** Prior versions, ascending (version 1 .. current-1). */
  history: StateSnapshot<T>[];
}

export interface Lease {
  resource: ResourceId;
  holder: AgentId;
  acquiredAt: number;
  expiresAt: number;
  renewals: number;
}

export interface LeaseOptions {
  /** Time-to-live in milliseconds. Falls back to the manager default. */
  ttlMs?: number;
}

export interface AgentInfo {
  id: AgentId;
  capabilities: readonly string[];
  registeredAt: number;
  lastHeartbeatAt: number;
  metadata: Readonly<Record<string, string>>;
}

export type TaskStatus = "pending" | "claimed" | "done" | "failed";

export interface TaskRecord {
  id: TaskId;
  title: string;
  requiredCapabilities: readonly string[];
  status: TaskStatus;
  claimant: AgentId | null;
  claimedAt: number | null;
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  createdAt: number;
}

export type EventKind =
  | "state.create"
  | "state.update"
  | "state.rollback"
  | "state.conflict-resolved"
  | "lease.acquire"
  | "lease.renew"
  | "lease.release"
  | "lease.expire"
  | "task.create"
  | "task.claim"
  | "task.complete"
  | "task.fail"
  | "task.requeue"
  | "agent.register"
  | "agent.heartbeat"
  | "agent.deregister";

export interface CoordinationEvent {
  seq: number;
  at: number;
  kind: EventKind;
  actor: AgentId | "system";
  detail: string;
}

export interface PutOptions {
  /** Optimistic concurrency: reject the write unless the current record is at this version. */
  expectedVersion?: number;
}

export type EventListener = (event: CoordinationEvent) => void;
/** Store-level audit entries share the event shape. */
export type AuditEntry = CoordinationEvent;

export interface RegisterOptions {
  /** Capability tags used for task-claim gating. */
  capabilities?: readonly string[];
  /** Free-form labels carried alongside the agent. */
  metadata?: Readonly<Record<string, string>>;
}

export interface CreateTaskOptions {
  /** Every capability the claimant must hold. */
  requiredCapabilities?: readonly string[];
  /** Attempts before the task is dead-lettered as "failed". Default 3. */
  maxAttempts?: number;
}

export interface LeaseOptions {
  /** Time-to-live in milliseconds. Defaults to the manager default (30s). */
  ttlMs?: number;
}