import type { AgentId, StateRecord } from "./types.js";

export interface ConflictCandidate<T = unknown> {
  /** The agent whose write lost the optimistic version race. */
  agent: AgentId;
  value: T;
  /** Clock time the candidate attempted its write. */
  at: number;
}

export interface ConflictContext<T = unknown> {
  key: string;
  /** The record currently in the store (the winner of the version race). */
  incumbent: StateRecord<T>;
  candidate: ConflictCandidate<T>;
}

export type ConflictDecision = "accept-candidate" | "keep-incumbent";

export interface ConflictResolver<T = unknown> {
  /** Stable name recorded in the audit trail for every resolution. */
  readonly name: string;
  resolve(context: ConflictContext<T>): ConflictDecision;
}

/**
 * Last-writer-wins with a deterministic tie-break: when both writes land at
 * the same clock instant, the lexicographically smaller agent id wins. Two
 * replicas running the same resolver therefore converge on the same answer
 * without communication.
 */
export class LastWriterWinsResolver implements ConflictResolver {
  readonly name = "last-writer-wins";

  resolve(context: ConflictContext): ConflictDecision {
    const { incumbent, candidate } = context;
    if (candidate.at > incumbent.writtenAt) return "accept-candidate";
    if (candidate.at < incumbent.writtenAt) return "keep-incumbent";
    return candidate.agent < incumbent.writtenBy ? "accept-candidate" : "keep-incumbent";
  }
}

/** First-writer-wins: the incumbent record always survives. */
export class FirstWriterWinsResolver implements ConflictResolver {
  readonly name = "first-writer-wins";

  resolve(_context?: ConflictContext): ConflictDecision {
    return "keep-incumbent";
  }
}

/** Adapter for caller-supplied resolution logic. */
export function createResolver<T = unknown>(
  name: string,
  resolve: (context: ConflictContext<T>) => ConflictDecision,
): ConflictResolver<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("resolver name must be a non-empty string");
  }
  return { name, resolve };
}