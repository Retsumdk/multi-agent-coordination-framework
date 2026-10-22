import type { Clock } from "./clock.js";
import { CoordinationError } from "./errors.js";
import type { AgentId, EventKind, RegisterOptions, AgentInfo } from "./types.js";

type RegistryEventSink = (
  kind: Extract<EventKind, "agent.register" | "agent.heartbeat" | "agent.deregister">,
  actor: AgentId | "system",
  detail: string,
) => void;

/**
 * Membership with capability tags. Task claims are gated on the claimant
 * holding every capability the task requires, so work never lands on an
 * agent that cannot do it.
 */
export class AgentRegistry {
  #agents = new Map<AgentId, AgentInfo>();
  readonly #clock: Clock;
  readonly #onEvent: RegistryEventSink | null;

  constructor(clock: Clock = { now: () => Date.now() }, onEvent: RegistryEventSink | null = null) {
    this.#clock = clock;
    this.#onEvent = onEvent;
  }

  register(id: string, options: RegisterOptions = {}): AgentInfo {
    this.#validateId(id);
    if (this.#agents.has(id)) {
      throw new CoordinationError("AGENT_ALREADY_REGISTERED", `"${id}" is already registered`);
    }
    const info: AgentInfo = {
      id,
      capabilities: [...new Set(options.capabilities ?? [])].sort(),
      registeredAt: this.#clock.now(),
      lastHeartbeatAt: this.#clock.now(),
      metadata: { ...options.metadata },
    };
    this.#agents.set(id, info);
    this.#onEvent?.("agent.register", id, `"${id}" registered with capabilities [${info.capabilities.join(", ")}]`);
    return { ...info, capabilities: [...info.capabilities], metadata: { ...info.metadata } };
  }

  deregister(id: string): void {
    this.#require(id);
    this.#agents.delete(id);
    this.#onEvent?.("agent.deregister", id, `"${id}" deregistered`);
  }

  heartbeat(id: string): void {
    const agent = this.#require(id);
    agent.lastHeartbeatAt = this.#clock.now();
    this.#onEvent?.("agent.heartbeat", id, `"${id}" heartbeat`);
  }

  get(id: string): AgentInfo {
    const agent = this.#require(id);
    return { ...agent, capabilities: [...agent.capabilities], metadata: { ...agent.metadata } };
  }

  has(id: string): boolean {
    return this.#agents.has(id);
  }

  /** Liveness is caller-defined: an agent is active if it heartbeat within `withinMs`. */
  isActive(id: string, withinMs: number): boolean {
    const agent = this.#require(id);
    if (!Number.isFinite(withinMs) || withinMs < 0) {
      throw new CoordinationError("VALIDATION", `withinMs must be a non-negative number, got ${withinMs}`);
    }
    return this.#clock.now() - agent.lastHeartbeatAt <= withinMs;
  }

  hasCapability(id: string, capability: string): boolean {
    return this.#require(id).capabilities.includes(capability);
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({ ...a, capabilities: [...a.capabilities], metadata: { ...a.metadata } }));
  }

  size(): number {
    return this.#agents.size;
  }

  #require(id: string): AgentInfo {
    this.#validateId(id);
    const agent = this.#agents.get(id);
    if (!agent) {
      throw new CoordinationError("AGENT_NOT_REGISTERED", `"${id}" is not registered`);
    }
    return agent;
  }

  #validateId(id: string): void {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new CoordinationError("VALIDATION", "agent id must be a non-empty, non-blank string");
    }
  }
}