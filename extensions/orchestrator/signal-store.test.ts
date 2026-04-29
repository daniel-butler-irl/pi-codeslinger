import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearPendingSignal,
  pendingSignalPath,
  readPendingSignal,
  writePendingSignal,
} from "./signal-store.ts";
import type { PendingSignal } from "./state.ts";

describe("signal-store", () => {
  let dir: string;
  const intentId = "intent-abc";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no signal persisted", () => {
    assert.equal(readPendingSignal(dir, intentId), null);
  });

  it("round-trips a proposal signal", () => {
    const signal: PendingSignal = {
      kind: "proposal",
      agentRole: "implementer",
      intentId,
      summary: "all done",
      artifacts: ["a.ts", "b.ts"],
      proposedAt: new Date(0).toISOString(),
    };
    writePendingSignal(dir, intentId, signal);
    assert.deepEqual(readPendingSignal(dir, intentId), signal);
  });

  it("round-trips a spawn-child signal", () => {
    const signal: PendingSignal = {
      kind: "spawn-child",
      agentRole: "implementer",
      parentIntentId: intentId,
      description: "extract auth",
      reason: "scope",
      requestedAt: new Date(0).toISOString(),
    };
    writePendingSignal(dir, intentId, signal);
    assert.deepEqual(readPendingSignal(dir, intentId), signal);
  });

  it("round-trips a review signal", () => {
    const signal: PendingSignal = {
      kind: "review",
      intentId,
      verdict: "rework",
      summary: "needs changes",
      findings: ["missing tests"],
      nextActions: ["add coverage"],
      reportedAt: new Date(0).toISOString(),
    };
    writePendingSignal(dir, intentId, signal);
    assert.deepEqual(readPendingSignal(dir, intentId), signal);
  });

  it("round-trips a question signal", () => {
    const signal: PendingSignal = {
      kind: "question",
      agentRole: "implementer",
      intentId,
      question: "which db?",
      context: null,
      askedAt: new Date(0).toISOString(),
    };
    writePendingSignal(dir, intentId, signal);
    assert.deepEqual(readPendingSignal(dir, intentId), signal);
  });

  it("overwrites prior signal atomically", () => {
    const a: PendingSignal = {
      kind: "proposal",
      agentRole: "implementer",
      intentId,
      summary: "v1",
      artifacts: [],
      proposedAt: new Date(0).toISOString(),
    };
    const b: PendingSignal = {
      kind: "proposal",
      agentRole: "implementer",
      intentId,
      summary: "v2",
      artifacts: [],
      proposedAt: new Date(1000).toISOString(),
    };
    writePendingSignal(dir, intentId, a);
    writePendingSignal(dir, intentId, b);
    assert.deepEqual(readPendingSignal(dir, intentId), b);
    assert.equal(existsSync(pendingSignalPath(dir, intentId) + ".tmp"), false);
  });

  it("clear removes the file", () => {
    const signal: PendingSignal = {
      kind: "proposal",
      agentRole: "implementer",
      intentId,
      summary: "x",
      artifacts: [],
      proposedAt: new Date(0).toISOString(),
    };
    writePendingSignal(dir, intentId, signal);
    assert.equal(existsSync(pendingSignalPath(dir, intentId)), true);
    clearPendingSignal(dir, intentId);
    assert.equal(existsSync(pendingSignalPath(dir, intentId)), false);
    assert.equal(readPendingSignal(dir, intentId), null);
  });

  it("clear is idempotent on missing file", () => {
    clearPendingSignal(dir, intentId);
    clearPendingSignal(dir, intentId);
  });
});
