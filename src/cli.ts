import { CoordinationEngine } from "./engine.js";
import { ManualClock } from "./clock.js";
import { runDemo, type DemoResult } from "./demo.js";
import { describeError, CoordinationError } from "./errors.js";
import { readFileSync } from "node:fs";

export type ScriptOp =
  | { op: "register"; agent: string; capabilities?: string[] }
  | { op: "put"; agent: string; key: string; value: unknown }
  | { op: "get"; key: string }
  | { op: "try-put"; agent: string; key: string; value: unknown; expectedVersion?: number }
  | { op: "create-task"; title: string; requiredCapabilities?: string[]; maxAttempts?: number }
  | { op: "claim"; agent: string; task: string }
  | { op: "complete"; agent: string; task: string; result?: unknown }
  | { op: "fail"; agent: string; task: string; reason?: string }
  | { op: "lease"; agent: string; resource: string; ttlMs?: number }
  | { op: "tick"; advanceMs?: number };

export interface ScriptResult {
  script: string;
  ops: number;
  results: { op: string; index: number; ok: boolean; summary: string; error?: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (isRecord(value) && "version" in value && "writtenBy" in value) {
    return `v${String(value.version)} by "${String(value.writtenBy)}"`;
  }
  if (isRecord(value) && "status" in value && "id" in value) {
    return `${String(value.id)}: ${String(value.status)}`;
  }
  if (isRecord(value) && "holder" in value) {
    return `held by "${String(value.holder)}"`;
  }
  return JSON.stringify(value);
}

export function runScript(ops: ScriptOp[]): ScriptResult {
  const results: ScriptResult["results"] = [];
  const clock = new ManualClock();
  const engine = new CoordinationEngine({ clock, claimLeaseMs: 30_000 });
  for (let i = 0; i < ops.length; i += 1) {
    const raw = ops[i];
    const label = isRecord(raw) ? String(raw.op) : "unknown";
    try {
      let summary = "";
      if (raw.op === "register") {
        const info = engine.registerAgent(raw.agent, { capabilities: raw.capabilities });
        summary = `${info.id} registered with [${info.capabilities.join(", ")}]`;
      } else if (raw.op === "put") {
        const record = engine.putWithLease(`state:${raw.key}`, raw.key, raw.value, raw.agent, { ttlMs: 30_000 });
        summary = `${record.record.key} = ${summarize(record.record.value)} (v${String(record.record.version)})`;
      } else if (raw.op === "get") {
        const record = engine.store.get(raw.key);
        summary = `${record.key} = ${summarize(record.value)} (v${String(record.version)})`;
      } else if (raw.op === "try-put") {
        const outcome = engine.tryPut(raw.key, raw.value, raw.agent, { expectedVersion: raw.expectedVersion });
        summary = `${outcome.decision} via "${outcome.resolver}" — ${outcome.record.key} = ${summarize(outcome.record.value)} (v${String(outcome.record.version)})`;
      } else if (raw.op === "create-task") {
        const task = engine.tasks.create(raw.title, {
          requiredCapabilities: raw.requiredCapabilities,
          maxAttempts: raw.maxAttempts,
        });
        summary = `${task.id} created: ${task.title}`;
      } else if (raw.op === "claim") {
        const task = engine.tasks.claim(raw.task, raw.agent);
        summary = `${task.id} claimed by ${task.claimant} (attempt ${String(task.attempts)})`;
      } else if (raw.op === "complete") {
        const task = engine.tasks.complete(raw.task, raw.agent, raw.result);
        summary = `${task.id} done`;
      } else if (raw.op === "fail") {
        const task = engine.tasks.fail(raw.task, raw.agent, raw.reason);
        summary = `${task.id} → ${task.status}`;
      } else if (raw.op === "lease") {
        const lease = engine.leases.acquire(raw.resource, raw.agent, { ttlMs: raw.ttlMs });
        summary = `${lease.resource} held by ${lease.holder}`;
      } else if (raw.op === "tick") {
        if (raw.advanceMs !== undefined) clock.advance(raw.advanceMs);
        const sweep = engine.tick();
        summary = `swept: ${sweep.leasesExpired.length} expired lease(s), ${sweep.tasksRequeued.length} stale claim(s) requeued`;
      } else {
        throw new CoordinationError("VALIDATION", `unknown op "${label}" at index ${i}`);
      }
      results.push({ op: label, index: i, ok: true, summary });
    } catch (error) {
      results.push({ op: label, index: i, ok: false, summary: "failed", error: describeError(error) });
    }
  }
  return { script: "inline", ops: ops.length, results };
}

export function parseScriptFile(path: string): ScriptOp[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CoordinationError("VALIDATION", `cannot read script file "${path}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoordinationError("VALIDATION", `script file "${path}" is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new CoordinationError("VALIDATION", `script file "${path}" must contain a JSON array of ops`);
  }
  return parsed as ScriptOp[];
}

export type { DemoResult };
export { runDemo, describeError, CoordinationError };