/**
 * Driver tests with a mock dispatcher.
 *
 * The mock agents simulate what a real subagent would do: write a signal
 * onto the flight (via their "turn"), then return. The driver then reads
 * the signal and transitions state. No real LLM or API key needed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OrchestratorDriver } from "./driver.ts";
import type { PendingSignal as _PendingSignal } from "./state.ts";
import { type AgentDefinition } from "./agent-defs.ts";
import type {
  AgentRole,
  DispatchedAgentHandle,
  IntentFlight,
  PendingSignal,
} from "./state.ts";
import type { DispatchOptions } from "./dispatcher.ts";
import {
  loadStore,
  saveStore,
  createIntent,
  transitionPhase,
  saveIntentContent,
  readLog,
  type IntentStore,
} from "../intent/store.ts";

async function withTempDir(fn: (cwd: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-driver-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Minimal ExtensionAPI stand-in: just the events bus. The driver only uses
 * pi.events; everything else in this test comes through direct method calls.
 */
function mockPi() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    pi: {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        emit(event: string, payload: unknown) {
          (handlers.get(event) ?? []).forEach((h) => h(payload));
        },
      },
      sendUserMessage: async (_msg: string) => {},
    } as any,
    getHandlers: (event: string) => handlers.get(event) ?? [],
  };
}

function makeDef(name: string): AgentDefinition {
  return {
    name,
    description: "test",
    provider: "openai",
    model: "gpt-4o",
    tools: ["read"],
    systemPrompt: "You are a test agent.",
  };
}

interface ScriptStep {
  /** The signal this agent writes when prompted. Null = no signal. */
  signal: PendingSignal | null;
}

function scriptedAgent(
  role: AgentRole,
  steps: ScriptStep[],
  flight: IntentFlight,
): DispatchedAgentHandle {
  let i = 0;
  return {
    role,
    prompt: async () => {
      const step = steps[i++] ?? null;
      if (step?.signal) flight.pendingSignal = step.signal;
    },
    dispose: async () => {},
  };
}

/**
 * Build a driver with a dispatcher that returns pre-scripted agents.
 */
function buildDriver(opts: {
  cwd: string;
  impl?: ScriptStep[];
  reviewer?: ScriptStep[];
  maxRework?: number;
}) {
  const { pi } = mockPi();
  const defs = new Map([
    ["intent-implementer", makeDef("intent-implementer")],
    ["intent-reviewer", makeDef("intent-reviewer")],
  ]);

  // Scripted dispatcher. We keep a per-flight reference so we can wire
  // the scripted signals to the flight the driver actually uses.
  const dispatch = async (
    d: DispatchOptions,
  ): Promise<DispatchedAgentHandle> => {
    if (d.role === "implementer") {
      return scriptedAgent("implementer", opts.impl ?? [], d.flight);
    }
    if (d.role === "reviewer") {
      return scriptedAgent("reviewer", opts.reviewer ?? [], d.flight);
    }
    return {
      role: d.role,
      prompt: async () => {},
      dispose: async () => {},
    };
  };

  const driver = new OrchestratorDriver(
    pi,
    opts.cwd,
    {} as any, // authStorage (unused in mocked dispatch)
    {} as any, // modelRegistry (unused in mocked dispatch)
    defs,
    { maxReworkPerIntent: opts.maxRework ?? 5 },
    { implementer: "intent-implementer", reviewer: "intent-reviewer" },
    dispatch,
  );
  driver.start();
  return { pi, driver };
}

function seedIntentAtImplementing(
  cwd: string,
  verificationCommand = "true",
): { store: IntentStore; id: string } {
  const store = loadStore(cwd);
  const intent = createIntent(store, cwd, "test work");
  saveIntentContent(
    cwd,
    intent.id,
    `# Intent\n\n## Description\ntest\n\n## Success Criteria\n- passes verification\n\n## Verification\n\n\`\`\`bash\n${verificationCommand}\n\`\`\`\n`,
  );
  transitionPhase(store, intent.id, "implementing");
  saveStore(cwd, store);
  return { store, id: intent.id };
}

describe("OrchestratorDriver — implementer proposal moves to reviewing", () => {
  test("after proposal, phase becomes reviewing", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);
      const { pi } = buildDriver({
        cwd,
        impl: [
          {
            signal: {
              kind: "proposal",
              agentRole: "implementer",
              intentId: id,
              summary: "done",
              artifacts: [],
              proposedAt: new Date().toISOString(),
            },
          },
        ],
        // Reviewer produces no signal in this test — we only check the
        // transition from implementing → reviewing, not further.
        reviewer: [{ signal: null }],
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      // Allow async chain to complete.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "reviewing");
      assert.ok(readLog(cwd, id).includes("proposal"));
    });
  });
});

describe("OrchestratorDriver — reviewer pass moves to done", () => {
  test("pass verdict transitions to done", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);
      const { pi } = buildDriver({
        cwd,
        impl: [
          {
            signal: {
              kind: "proposal",
              agentRole: "implementer",
              intentId: id,
              summary: "done",
              artifacts: [],
              proposedAt: new Date().toISOString(),
            },
          },
        ],
        reviewer: [
          {
            signal: {
              kind: "review",
              intentId: id,
              verdict: "pass",
              summary: "All success criteria met. No issues found.",
              findings: [],
              nextActions: [],
              reportedAt: new Date().toISOString(),
            },
          },
        ],
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "proposed-ready");
    });
  });
});

describe("OrchestratorDriver — reviewer rework increments and returns", () => {
  test("rework verdict transitions back to implementing and bumps reworkCount", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);
      const { pi } = buildDriver({
        cwd,
        impl: [
          {
            signal: {
              kind: "proposal",
              agentRole: "implementer",
              intentId: id,
              summary: "done",
              artifacts: [],
              proposedAt: new Date().toISOString(),
            },
          },
          // Second pass after rework — no signal for now, we just
          // assert the state transition happened.
          { signal: null },
        ],
        reviewer: [
          {
            signal: {
              kind: "review",
              intentId: id,
              verdict: "rework",
              summary: "Edge case X is not covered and needs a test.",
              findings: ["Missing edge case X"],
              nextActions: ["Add test for X"],
              reportedAt: new Date().toISOString(),
            },
          },
        ],
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "implementing");
      assert.equal(after.reworkCount, 1);
      assert.ok(readLog(cwd, id).includes("rework"));
    });
  });
});

describe("OrchestratorDriver — spawn-child pauses parent and creates child", () => {
  test("implementer spawn_child produces child intent and blocks parent", async () => {
    await withTempDir(async (cwd) => {
      const { id: parentId } = seedIntentAtImplementing(cwd);
      const { pi } = buildDriver({
        cwd,
        impl: [
          {
            signal: {
              kind: "spawn-child",
              agentRole: "implementer",
              parentIntentId: parentId,
              description: "Write the missing tests",
              reason: "Verification command references tests that do not exist",
              requestedAt: new Date().toISOString(),
            },
          },
        ],
      });

      pi.events.emit("intent:phase-changed", {
        id: parentId,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const store = loadStore(cwd);
      const parent = store.intents.find((i) => i.id === parentId)!;
      assert.equal(parent.phase, "blocked-on-child");
      const children = store.intents.filter((i) => i.parentId === parentId);
      assert.equal(children.length, 1);
      assert.equal(children[0].phase, "defining");
      assert.equal(store.activeIntentId, children[0].id);
      assert.ok(readLog(cwd, parentId).includes("spawn-child"));
    });
  });
});

describe("OrchestratorDriver — child done resumes parent", () => {
  test("parent unblocks to implementing when child reaches done", async () => {
    await withTempDir(async (cwd) => {
      // Seed parent at implementing, then blocked-on-child.
      const { id: parentId } = seedIntentAtImplementing(cwd);
      const preload = loadStore(cwd);
      const parentTarget = preload.intents.find((i) => i.id === parentId)!;
      transitionPhase(preload, parentId, "blocked-on-child");
      // Create a child manually to simulate the spawn having already happened.
      const child = createIntent(preload, cwd, "prerequisite work", {
        parentId,
      });
      saveStore(cwd, preload);

      // Mark child as done so the driver's phase-changed handler runs
      // the resume-parent branch.
      const midStore = loadStore(cwd);
      const childTarget = midStore.intents.find((i) => i.id === child.id)!;
      // Legal path: defining → implementing → reviewing → proposed-ready → done
      transitionPhase(midStore, child.id, "implementing");
      transitionPhase(midStore, child.id, "reviewing");
      transitionPhase(midStore, child.id, "proposed-ready");
      transitionPhase(midStore, child.id, "done");
      saveStore(cwd, midStore);

      const { pi } = buildDriver({ cwd });
      pi.events.emit("intent:phase-changed", {
        id: child.id,
        from: "reviewing",
        to: "done",
      });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const afterStore = loadStore(cwd);
      const parentAfter = afterStore.intents.find((i) => i.id === parentId)!;
      assert.equal(parentAfter.phase, "implementing");
      assert.equal(afterStore.activeIntentId, parentId);
      assert.ok(readLog(cwd, parentId).includes("child-done"));
    });
  });
});

describe("OrchestratorDriver — child depth cap", () => {
  test("spawn_child refuses when depth cap reached", async () => {
    await withTempDir(async (cwd) => {
      // Build a chain: root → mid → leaf, all top-level/child/grandchild.
      // Leaf sits at depth 2. With maxChildIntentDepth=2, spawning from
      // leaf would push a new child to depth 3 — not allowed.
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const mid = createIntent(store, cwd, "mid", { parentId: root.id });
      const leaf = createIntent(store, cwd, "leaf", { parentId: mid.id });
      saveIntentContent(
        cwd,
        leaf.id,
        `# Intent\n\n## Description\nleaf\n\n## Success Criteria\n- verify\n\n## Verification\n\n\`\`\`bash\ntrue\n\`\`\`\n`,
      );
      transitionPhase(store, leaf.id, "implementing");
      saveStore(cwd, store);

      // Build a driver manually so we can set maxChildIntentDepth: 2.
      const { pi } = mockPi();
      const defs = new Map([
        ["intent-implementer", makeDef("intent-implementer")],
        ["intent-reviewer", makeDef("intent-reviewer")],
      ]);
      const driver = new OrchestratorDriver(
        pi,
        cwd,
        {} as any,
        {} as any,
        defs,
        { maxReworkPerIntent: 5, maxChildIntentDepth: 2 },
        { implementer: "intent-implementer", reviewer: "intent-reviewer" },
        async (d) => ({
          role: d.role,
          prompt: async () => {
            if (d.role === "implementer") {
              d.flight.pendingSignal = {
                kind: "spawn-child",
                agentRole: "implementer",
                parentIntentId: leaf.id,
                description: "deeper work",
                reason: "nested prereq",
                requestedAt: new Date().toISOString(),
              };
            }
          },
          dispose: async () => {},
        }),
      );
      driver.start();

      pi.events.emit("intent:phase-changed", {
        id: leaf.id,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setImmediate(r));
      }

      // No new child was created — store has exactly the original 3.
      const after = loadStore(cwd);
      assert.equal(after.intents.length, 3);
      assert.ok(readLog(cwd, leaf.id).includes("escalation"));
    });
  });
});

describe("OrchestratorDriver — rework cap", () => {
  test("once rework cap reached, does not re-dispatch", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);
      // Force intent to have already hit rework cap.
      const preload = loadStore(cwd);
      const target = preload.intents.find((i) => i.id === id)!;
      target.reworkCount = 5;
      saveStore(cwd, preload);

      const { pi } = buildDriver({
        cwd,
        maxRework: 5,
        impl: [
          {
            signal: {
              kind: "proposal",
              agentRole: "implementer",
              intentId: id,
              summary: "done",
              artifacts: [],
              proposedAt: new Date().toISOString(),
            },
          },
        ],
        reviewer: [
          {
            signal: {
              kind: "review",
              intentId: id,
              verdict: "rework",
              summary: "Still broken.",
              findings: ["still broken"],
              nextActions: [],
              reportedAt: new Date().toISOString(),
            },
          },
        ],
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setImmediate(r));
      }

      // Phase stays at implementing (cap reached; human must act).
      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "implementing");
      assert.equal(after.reworkCount, 5);
      assert.ok(readLog(cwd, id).includes("escalation"));
    });
  });
});

describe("OrchestratorDriver — main-chat reviewer path", () => {
  test("review-signal event transitions to proposed-ready on pass", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);

      const { pi } = mockPi();
      const defs = new Map([
        ["intent-implementer", makeDef("intent-implementer")],
        [
          "intent-reviewer",
          {
            name: "intent-reviewer",
            description: "main-chat reviewer (no provider/model)",
            tools: ["read"],
            systemPrompt: "Review this.",
          } as AgentDefinition,
        ],
      ]);

      const dispatch = async (
        d: DispatchOptions,
      ): Promise<DispatchedAgentHandle> => {
        if (d.role === "implementer") {
          return scriptedAgent(
            "implementer",
            [
              {
                signal: {
                  kind: "proposal",
                  agentRole: "implementer",
                  intentId: id,
                  summary: "done",
                  artifacts: [],
                  proposedAt: new Date().toISOString(),
                },
              },
            ],
            d.flight,
          );
        }
        throw new Error("Reviewer should not be dispatched as subagent");
      };

      const driver = new OrchestratorDriver(
        pi,
        cwd,
        {} as any,
        {} as any,
        defs,
        { maxReworkPerIntent: 5 },
        { implementer: "intent-implementer", reviewer: "intent-reviewer" },
        dispatch,
      );
      driver.start();

      // Implementer proposes done → phase moves to reviewing.
      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const midStore = loadStore(cwd);
      assert.equal(
        midStore.intents.find((i) => i.id === id)!.phase,
        "reviewing",
      );

      // Simulate the main-chat AI calling report_review → emits review-signal.
      pi.events.emit("orchestrator:review-signal", {
        intentId: id,
        verdict: "pass",
        summary: "All success criteria met. No issues found.",
        findings: [],
        nextActions: [],
        reportedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const afterStore = loadStore(cwd);
      assert.equal(
        afterStore.intents.find((i) => i.id === id)!.phase,
        "proposed-ready",
      );
    });
  });
});

describe("OrchestratorDriver — main-chat implementer path", () => {
  test("proposal-signal event transitions implementing → reviewing", async () => {
    await withTempDir(async (cwd) => {
      const { id } = seedIntentAtImplementing(cwd);

      const { pi } = mockPi();
      const defs = new Map([
        [
          "intent-implementer",
          {
            name: "intent-implementer",
            description: "main-chat implementer (no provider/model)",
            tools: [],
            systemPrompt: "Implement this.",
          } as AgentDefinition,
        ],
        [
          "intent-reviewer",
          {
            name: "intent-reviewer",
            description: "main-chat reviewer (no provider/model)",
            tools: [],
            systemPrompt: "Review this.",
          } as AgentDefinition,
        ],
      ]);

      const dispatch = async (): Promise<DispatchedAgentHandle> => {
        throw new Error("No agent should be dispatched in main-chat mode");
      };

      const driver = new OrchestratorDriver(
        pi,
        cwd,
        {} as any,
        {} as any,
        defs,
        { maxReworkPerIntent: 5 },
        { implementer: "intent-implementer", reviewer: "intent-reviewer" },
        dispatch,
      );
      driver.start();

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
      }

      // Phase still implementing — waiting for main-chat AI to call propose_done.
      const midStore = loadStore(cwd);
      assert.equal(
        midStore.intents.find((i) => i.id === id)!.phase,
        "implementing",
      );

      // Simulate the main-chat AI calling propose_done → emits proposal-signal.
      pi.events.emit("orchestrator:proposal-signal", {
        intentId: id,
        summary: "All done.",
        artifacts: [],
        proposedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
      }

      const afterStore = loadStore(cwd);
      assert.equal(
        afterStore.intents.find((i) => i.id === id)!.phase,
        "reviewing",
      );
      assert.ok(readLog(cwd, id).includes("proposal"));
    });
  });
});
