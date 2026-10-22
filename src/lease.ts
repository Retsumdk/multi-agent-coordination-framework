import type { Clock } from "./clock.js";
import { CoordinationError } from "./errors.js";
import type { AgentId, EventKind, Lease, LeaseOptions, ResourceId } from "./types.js";

type LeaseEventSink = (
  kind: Extract<EventKind, "lease.acquire" | "lease.renew" | "lease.release" | "lease.expire">,
  actor: AgentId | "system",
  detail: string,
) => void;

/**
 * Mutual exclusion over named resources, time-boxed by TTL so a crashed
 * holder cannot deadlock the system: the lease simply expires.
 *
 * All expiry decisions flow through the injected clock, so tests and demos
 * can advance time deterministically.
 */
export class LeaseManager {
  #leases = new Map<ResourceId, Lease>();
  readonly #clock: Clock;
  readonly #defaultTtlMs: number;
  readonly #onEvent: LeaseEventSink | null;

  constructor(clock: Clock = { now: () => Date.now() }, defaultTtlMs = 30_000, onEvent: LeaseEventSink | null = null) {
    this.#clock = clock;
    this.#defaultTtlMs = defaultTtlMs;
    this.#onEvent = onEvent;
  }

  acquire(resource: string, agent: AgentId, options: LeaseOptions = {}): Lease {
    this.#validate(resource, agent);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new CoordinationError("VALIDATION", `lease TTL must be a positive number of milliseconds, got ${ttl}`);
    }
    const existing = this.#live(resource);
    if (existing && existing.holder !== agent) {
      throw new CoordinationError(
        "LEASE_HELD",
        `"${resource}" is held by "${existing.holder}" until ${existing.expiresAt}`,
      );
    }
    if (existing) {
      // Re-acquire by the current holder extends the window and counts as a renewal.
      existing.renewals += 1;
      existing.expiresAt = this.#clock.now() + ttl;
      this.#onEvent?.("lease.renew", agent, `"${resource}" renewed by "${agent}" until ${existing.expiresAt}`);
      return { ...existing };
    }
    const lease: Lease = {
      resource,
      holder: agent,
      acquiredAt: this.#clock.now(),
      expiresAt: this.#clock.now() + ttl,
      renewals: 0,
    };
    this.#leases.set(resource, lease);
    this.#onEvent?.("lease.acquire", agent, `"${resource}" acquired by "${agent}" until ${lease.expiresAt}`);
    return { ...lease };
  }

  renew(resource: string, agent: AgentId, options: LeaseOptions = {}): Lease {
    this.#validate(resource, agent);
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new CoordinationError("VALIDATION", `lease TTL must be a positive number of milliseconds, got ${ttl}`);
    }
    const lease = this.#live(resource);
    if (!lease || lease.holder !== agent) {
      throw new CoordinationError("LEASE_NOT_HELD", `"${agent}" does not hold a live lease on "${resource}"`);
    }
    lease.expiresAt = this.#clock.now() + ttl;
    lease.renewals += 1;
    this.#onEvent?.("lease.renew", agent, `"${resource}" renewed by "${agent}" until ${lease.expiresAt}`);
    return { ...lease };
  }

  release(resource: string, agent: AgentId): void {
    this.#validate(resource, agent);
    const lease = this.#live(resource);
    if (!lease || lease.holder !== agent) {
      throw new CoordinationError("LEASE_NOT_HELD", `"${agent}" does not hold a live lease on "${resource}"`);
    }
    this.#leases.delete(resource);
    this.#onEvent?.("lease.release", agent, `"${resource}" released by "${agent}"`);
  }

  isHeld(resource: string): boolean {
    return this.#live(resource) !== null;
  }

  holderOf(resource: string): AgentId | null {
    return this.#live(resource)?.holder ?? null;
  }

  /** Drop expired leases so their resources become acquirable. Returns the expired resources. */
  sweep(): string[] {
    const now = this.#clock.now();
    const expired: string[] = [];
    for (const [resource, lease] of this.#leases) {
      if (lease.expiresAt <= now) {
        this.#leases.delete(resource);
        this.#onEvent?.("lease.expire", lease.holder, `"${resource}" expired (was held by "${lease.holder}")`);
        expired.push(resource);
      }
    }
    return expired;
  }

  list(): Lease[] {
    return [...this.#leases.values()].filter((l) => this.#isLive(l)).sort((a, b) => a.resource.localeCompare(b.resource)).map((l) => ({ ...l }));
  }

  #live(resource: string): Lease | null {
    const lease = this.#leases.get(resource);
    if (!lease) return null;
    return this.#isLive(lease) ? lease : null;
  }

  #isLive(lease: Lease): boolean {
    return lease.expiresAt > this.#clock.now();
  }

  #validate(resource: string, agent: AgentId): void {
    if (typeof resource !== "string" || resource.length === 0) {
      throw new CoordinationError("VALIDATION", "resource must be a non-empty string");
    }
    if (typeof agent !== "string" || agent.length === 0) {
      throw new CoordinationError("VALIDATION", "agent id must be a non-empty string");
    }
  }
}