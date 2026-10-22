import type { Clock } from "./clock.js";

function cloneRecord<T>(record: StateRecord<T>): StateRecord<T> {
  return {
    key: record.key,
    value: structuredClone(record.value),
    version: record.version,
    writtenBy: record.writtenBy,
    writtenAt: record.writtenAt,
    history: record.history.map((s) => ({
      version: s.version,
      value: structuredClone(s.value),
      writtenBy: s.writtenBy,
      writtenAt: s.writtenAt,
    })),
  };
}
import { CoordinationError } from "./errors.js";
import type {
  AgentId,
  AuditEntry,
  EventKind,
  PutOptions,
  StateKey,
  StateRecord,
  StateSnapshot,
} from "./types.js";

type StoreEventSink = (
  kind: Extract<EventKind, "state.create" | "state.update" | "state.rollback" | "state.conflict-resolved">,
  actor: AgentId | "system",
  detail: string,
) => void;

/**
 * Versioned key-value shared state with optimistic concurrency control.
 *
 * Every write carries a monotonically increasing version. Callers that fear
 * a lost update pass `expectedVersion`; a stale expectation is rejected with
 * CONFLICT instead of silently overwriting a peer's write. Full history is
 * retained per key and rollback is a first-class operation.
 */
export class VersionedStateStore {
  #records = new Map<StateKey, StateRecord>();
  #audit: AuditEntry[] = [];
  #seq = 0;
  readonly #clock: Clock;
  readonly #onEvent: StoreEventSink | null;

  constructor(clock: Clock = { now: () => Date.now() }, onEvent: StoreEventSink | null = null) {
    this.#clock = clock;
    this.#onEvent = onEvent;
  }

  put<T>(key: string, value: T, agent: AgentId, options: PutOptions = {}): StateRecord<T> {
    this.#validateKey(key);
    this.#validateAgent(agent);
    const existing = this.#records.get(key) as StateRecord<T> | undefined;
    const now = this.#clock.now();

    if (existing) {
      const expected = options.expectedVersion;
      if (expected !== undefined && expected !== existing.version) {
        throw new CoordinationError(
          "CONFLICT",
          `stale write to "${key}": expected version ${expected} but current version is ${existing.version} (written by "${existing.writtenBy}")`,
        );
      }
      const snapshot: StateSnapshot<T> = {
        version: existing.version,
        value: existing.value,
        writtenBy: existing.writtenBy,
        writtenAt: existing.writtenAt,
      };
      const record: StateRecord<T> = {
        key,
        value,
        version: existing.version + 1,
        writtenBy: agent,
        writtenAt: now,
        history: [...existing.history, snapshot],
      };
      this.#records.set(key, record as StateRecord);
      this.#auditEntry("state.update", agent, `"${key}" -> v${record.version} (was v${existing.version})`);
      return cloneRecord(record);
    }

    if (options.expectedVersion !== undefined && options.expectedVersion !== 0) {
      throw new CoordinationError(
        "CONFLICT",
        `stale write to "${key}": expected version ${options.expectedVersion} but the key does not exist yet`,
      );
    }
    const record: StateRecord<T> = {
      key,
      value,
      version: 1,
      writtenBy: agent,
      writtenAt: now,
      history: [],
    };
    this.#records.set(key, record as StateRecord);
    this.#auditEntry("state.create", agent, `"${key}" created at v1`);
    return cloneRecord(record);
  }

  get<T = unknown>(key: string): StateRecord<T> {
    const record = this.#records.get(key);
    if (!record) {
      throw new CoordinationError("KEY_NOT_FOUND", `no state under key "${key}"`);
    }
    return cloneRecord(record as StateRecord<T>);
  }

  tryGet<T = unknown>(key: string): StateRecord<T> | null {
    const record = this.#records.get(key);
    return record ? cloneRecord(record as StateRecord<T>) : null;
  }

  has(key: string): boolean {
    return this.#records.has(key);
  }

  list(): StateRecord[] {
    return [...this.#records.values()].sort((a, b) => a.key.localeCompare(b.key)).map(cloneRecord);
  }

  history<T = unknown>(key: string): StateSnapshot<T>[] {
    return this.get<T>(key).history.map((s) => ({ ...s }));
  }

  /**
   * Restore the value the key held at `toVersion` as a new head version.
   * The current version is never rewritten — rollback is additive.
   */
  rollback<T = unknown>(key: string, toVersion: number, agent: AgentId): StateRecord<T> {
    this.#validateAgent(agent);
    const current = this.get<T>(key);
    if (!Number.isInteger(toVersion) || toVersion < 1) {
      throw new CoordinationError("VALIDATION", `toVersion must be a positive integer, got ${toVersion}`);
    }
    if (toVersion === current.version) {
      throw new CoordinationError("VALIDATION", `"${key}" is already at version ${toVersion}`);
    }
    const snapshot = current.history.find((s) => s.version === toVersion);
    if (!snapshot) {
      throw new CoordinationError(
        "VERSION_NOT_FOUND",
        `"${key}" has no version ${toVersion} in its history (current version is ${current.version})`,
      );
    }
    const record: StateRecord<T> = {
      key,
      value: snapshot.value,
      version: current.version + 1,
      writtenBy: agent,
      writtenAt: this.#clock.now(),
      history: [
        ...current.history,
        { version: current.version, value: current.value, writtenBy: current.writtenBy, writtenAt: current.writtenAt },
      ],
    };
    this.#records.set(key, record as StateRecord);
    this.#auditEntry(
      "state.rollback",
      agent,
      `"${key}" rolled back to the value of v${toVersion} as new v${record.version}`,
    );
    return cloneRecord(record);
  }

  /**
   * Conflict-resolution path: overwrite the head with the candidate value,
   * bumping the version and recording which resolver accepted the candidate.
   */
  forceWrite<T>(key: string, value: T, agent: AgentId, resolverName: string): StateRecord<T> {
    const existing = this.get<T>(key);
    const record: StateRecord<T> = {
      key,
      value,
      version: existing.version + 1,
      writtenBy: agent,
      writtenAt: this.#clock.now(),
      history: [
        ...existing.history,
        { version: existing.version, value: existing.value, writtenBy: existing.writtenBy, writtenAt: existing.writtenAt },
      ],
    };
    this.#records.set(key, record as StateRecord);
    this.#auditEntry(
      "state.conflict-resolved",
      agent,
      `"${key}" conflict resolved by "${resolverName}": candidate from "${agent}" accepted over v${existing.version} ("${existing.writtenBy}") as v${record.version}`,
    );
    return cloneRecord(record);
  }

  /** Audit-only path when a resolver keeps the incumbent over the candidate. */
  forceAuditConflict(agent: AgentId, resolverName: string, decision: string, key: string): void {
    const existing = this.get(key);
    this.#auditEntry(
      "state.conflict-resolved",
      agent,
      `"${key}" conflict resolved by "${resolverName}": ${decision} — v${existing.version} by "${existing.writtenBy}" retained`,
    );
  }

  auditLog(): readonly AuditEntry[] {
    return this.#audit.map((entry) => ({ ...entry }));
  }

  #auditEntry(
    kind: Extract<EventKind, "state.create" | "state.update" | "state.rollback" | "state.conflict-resolved">,
    actor: AgentId | "system",
    detail: string,
  ): void {
    const entry: AuditEntry = { seq: ++this.#seq, at: this.#clock.now(), kind, actor, detail };
    this.#audit.push(entry);
    this.#onEvent?.(kind, actor, detail);
  }

  #validateKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new CoordinationError("VALIDATION", "state key must be a non-empty string");
    }
  }

  #validateAgent(agent: AgentId): void {
    if (typeof agent !== "string" || agent.length === 0) {
      throw new CoordinationError("VALIDATION", "agent id must be a non-empty string");
    }
  }
}