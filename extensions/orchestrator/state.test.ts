import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FlightTable,
  newFlight,
  registerAgent,
  unregisterAgent,
  disposeFlight,
  type DispatchedAgentHandle,
} from "./state.ts";

function mockHandle(
  role: "researcher" | "planner" | "implementer" | "reviewer",
  onDispose?: () => void,
): DispatchedAgentHandle {
  return {
    role,
    prompt: async () => {},
    dispose: async () => {
      onDispose?.();
    },
    getTranscript: () => [],
    sendUserMessage: async () => {},
  };
}

describe("newFlight", () => {
  test("creates a flight with empty agents and no pending signal", () => {
    const f = newFlight("intent-1");
    assert.equal(f.intentId, "intent-1");
    assert.deepEqual(f.agents, {});
    assert.equal(f.pendingSignal, null);
  });
});

describe("registerAgent / unregisterAgent", () => {
  test("registers an agent by role", () => {
    const f = newFlight("i1");
    const h = mockHandle("implementer");
    registerAgent(f, h);
    assert.equal(f.agents.implementer, h);
  });

  test("unregister returns the handle and clears the slot", () => {
    const f = newFlight("i1");
    const h = mockHandle("reviewer");
    registerAgent(f, h);
    const removed = unregisterAgent(f, "reviewer");
    assert.equal(removed, h);
    assert.equal(f.agents.reviewer, undefined);
  });

  test("unregister on empty slot returns undefined", () => {
    const f = newFlight("i1");
    assert.equal(unregisterAgent(f, "implementer"), undefined);
  });
});

describe("disposeFlight", () => {
  test("disposes every registered agent", async () => {
    const f = newFlight("i1");
    let disposedImpl = false;
    let disposedRev = false;
    registerAgent(
      f,
      mockHandle("implementer", () => (disposedImpl = true)),
    );
    registerAgent(
      f,
      mockHandle("reviewer", () => (disposedRev = true)),
    );

    await disposeFlight(f);

    assert.ok(disposedImpl);
    assert.ok(disposedRev);
    assert.deepEqual(f.agents, {});
  });

  test("swallows per-agent dispose errors so cleanup finishes", async () => {
    const f = newFlight("i1");
    let disposedOk = false;
    registerAgent(f, {
      role: "implementer",
      prompt: async () => {},
      dispose: async () => {
        throw new Error("boom");
      },
      getTranscript: () => [],
      sendUserMessage: async () => {},
    });
    registerAgent(
      f,
      mockHandle("reviewer", () => (disposedOk = true)),
    );

    await disposeFlight(f); // should not throw
    assert.ok(disposedOk, "second agent was still disposed");
  });
});

describe("FlightTable", () => {
  test("getOrCreate creates once and then returns the same flight", () => {
    const table = new FlightTable();
    const a = table.getOrCreate("i1");
    const b = table.getOrCreate("i1");
    assert.equal(a, b);
  });

  test("remove disposes all agents and drops the flight", async () => {
    const table = new FlightTable();
    const f = table.getOrCreate("i1");
    let disposed = false;
    registerAgent(
      f,
      mockHandle("implementer", () => (disposed = true)),
    );

    await table.remove("i1");

    assert.ok(disposed);
    assert.equal(table.get("i1"), undefined);
  });

  test("all() returns every active flight", () => {
    const table = new FlightTable();
    table.getOrCreate("i1");
    table.getOrCreate("i2");
    assert.equal(table.all().length, 2);
  });
});
