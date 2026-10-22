import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/clock.js";
import { CoordinationError, describeError, errorExitCode, isCoordinationError } from "../src/errors.js";
import { VersionedStateStore } from "../src/store.js";

function freshStore(): { store: VersionedStateStore; clock: ManualClock } {
  const clock = new ManualClock(1_000);
  return { store: new VersionedStateStore(clock), clock };
}

describe("store.put", () => {
  test("first write creates v1", () => {
    const { store } = freshStore();
    const record = store.put("greeting", "hello", "alpha");
    expect(record.key).toBe("greeting");
    expect(record.value).toBe("hello");
    expect(record.version).toBe(1);
    expect(record.writtenBy).toBe("alpha");
    expect(record.writtenAt).toBe(1_000);
    expect(record.history).toEqual([]);
  });

  test("subsequent writes bump the version and retain history", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    const record = store.put("k", "v2", "beta");
    expect(record.version).toBe(2);
    expect(record.history).toEqual([{ version: 1, value: "v1", writtenBy: "alpha", writtenAt: 1_000 }]);
  });

  test("optimistic concurrency: stale expectedVersion is a CONFLICT, never a silent overwrite", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    store.put("k", "v2", "beta");
    try {
      store.put("k", "v3", "gamma", { expectedVersion: 1 });
      throw new Error("should not reach");
    } catch (error) {
      const err = error as CoordinationError;
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toContain("expected version 1");
      expect(err.message).toContain("current version is 2");
    }
    expect(store.get("k").value).toBe("v2");
  });

  test("matching expectedVersion passes (compare-and-set)", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    const record = store.put("k", "v2", "beta", { expectedVersion: 1 });
    expect(record.version).toBe(2);
  });

  test("expectedVersion on a missing key must be 0", () => {
    const { store } = freshStore();
    expect(() => store.put("k", "v", "alpha", { expectedVersion: 1 })).toThrow(/CONFLICT/);
    const record = store.put("k", "v", "alpha", { expectedVersion: 0 });
    expect(record.version).toBe(1);
  });

  test("validation", () => {
    const { store } = freshStore();
    expect(() => store.put("", "v", "alpha")).toThrow(/VALIDATION/);
    expect(() => store.put("k", "v", "")).toThrow(/VALIDATION/);
  });
});

describe("store.get / tryGet / list", () => {
  test("missing key is KEY_NOT_FOUND; tryGet returns null", () => {
    const { store } = freshStore();
    expect(() => store.get("nope")).toThrow(/KEY_NOT_FOUND/);
    expect(store.tryGet("nope")).toBeNull();
    expect(store.has("nope")).toBe(false);
  });

  test("list is sorted by key and defensive-copied", () => {
    const { store } = freshStore();
    store.put("zeta", 1, "alpha");
    store.put("alpha", 2, "alpha");
    const list = store.list();
    expect(list.map((r) => r.key)).toEqual(["alpha", "zeta"]);
    list[0].value = 999;
    expect(store.get("alpha").value).toBe(2);
  });

  test("returned records are defensive copies", () => {
    const { store } = freshStore();
    const record = store.put("k", { nested: true }, "alpha");
    (record.value as { nested: boolean }).nested = false;
    expect((store.get<{ nested: boolean }>("k").value).nested).toBe(true);
  });
});

describe("store.rollback", () => {
  test("rollback restores a prior value as a NEW head version", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    store.put("k", "v2", "beta");
    store.put("k", "v3", "gamma");
    const rolled = store.rollback("k", 1, "alpha");
    expect(rolled.value).toBe("v1");
    expect(rolled.version).toBe(4);
    expect(rolled.history.map((s) => s.version)).toEqual([1, 2, 3]);
  });

  test("unknown version is VERSION_NOT_FOUND; current version is VALIDATION", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    expect(() => store.rollback("k", 5, "alpha")).toThrow(/VERSION_NOT_FOUND/);
    expect(() => store.rollback("k", 1, "alpha")).toThrow(/VALIDATION/);
    expect(() => store.rollback("k", 0, "alpha")).toThrow(/VALIDATION/);
  });
});

describe("store.auditLog", () => {
  test("records create, update, rollback, and conflict-resolution entries in order", () => {
    const { store } = freshStore();
    store.put("k", "v1", "alpha");
    store.put("k", "v2", "beta");
    store.rollback("k", 1, "alpha");
    store.forceWrite("k", "forced", "gamma", "last-writer-wins");
    store.forceAuditConflict("gamma", "first-writer-wins", "keep-incumbent", "k");
    const kinds = store.auditLog().map((e) => e.kind);
    expect(kinds).toEqual(["state.create", "state.update", "state.rollback", "state.conflict-resolved", "state.conflict-resolved"]);
    const seqs = store.auditLog().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("CoordinationError", () => {
  test("messages carry the code prefix", () => {
    const error = new CoordinationError("CONFLICT", "test");
    expect(error.message.startsWith("[CONFLICT] ")).toBe(true);
    expect(error.retriable).toBe(true);
    expect(new CoordinationError("VALIDATION", "test").retriable).toBe(false);
  });

  test("describeError strips the duplicate prefix", () => {
    expect(describeError(new CoordinationError("CONFLICT", "boom"))).toBe("CONFLICT: boom");
    expect(describeError(new Error("plain"))).toBe("Error: plain");
    expect(describeError("raw")).toBe("raw");
  });

  test("isCoordinationError narrows the type", () => {
    expect(isCoordinationError(new CoordinationError("CONFLICT", "x"))).toBe(true);
    expect(isCoordinationError(new Error("x"))).toBe(false);
  });

  test("exit codes: validation is usage (2), races are runtime (1)", () => {
    expect(errorExitCode("VALIDATION")).toBe(2);
    expect(errorExitCode("CONFLICT")).toBe(1);
    expect(errorExitCode("LEASE_HELD")).toBe(1);
  });
});