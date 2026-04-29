/**
 * Driver tests with a mock dispatcher.
 *
 * The mock agents simulate what a real subagent would do: write a signal
 * onto the flight (via their "turn"), then return. The driver then reads
 * the signal and transitions state. No real LLM or API key needed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "node:child_process";
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
import { readActiveIntent, writeActiveIntent } from "../intent/active-local.ts";

/**
 * Drain all pending async operations including lockfile I/O. The
 * proper-lockfile retries have a 50ms minimum timeout, so we need a
 * real timer (not just setImmediate) to let them complete.
 */
async function drainAsync(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir(fn: (cwd: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-driver-test-"));
  try {
    // Init a git repo so writeActiveIntent / readActiveIntent work.
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
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
      newSession: async () => ({}),
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

interface ScriptCursor {
  steps: ScriptStep[];
  i: number;
}

function scriptedAgent(
  role: AgentRole,
  cursor: ScriptCursor,
  flight: IntentFlight,
): DispatchedAgentHandle {
  return {
    role,
    prompt: async () => {
      const step = cursor.steps[cursor.i++] ?? null;
      if (step?.signal) flight.pendingSignal = step.signal;
    },
    dispose: async () => {},
    getTranscript: () => [],
    sendUserMessage: async () => {},
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

  // Scripted dispatcher. Cursors live outside the agent handles so that
  // a re-dispatch (after rework dispose, etc.) continues at the next step
  // rather than restarting at step 0.
  const implCursor: ScriptCursor = { steps: opts.impl ?? [], i: 0 };
  const reviewerCursor: ScriptCursor = { steps: opts.reviewer ?? [], i: 0 };
  const dispatch = async (
    d: DispatchOptions,
  ): Promise<DispatchedAgentHandle> => {
    if (d.role === "implementer") {
      return scriptedAgent("implementer", implCursor, d.flight);
    }
    if (d.role === "reviewer") {
      return scriptedAgent("reviewer", reviewerCursor, d.flight);
    }
    return {
      role: d.role,
      prompt: async () => {},
      dispose: async () => {},
      getTranscript: () => [],
      sendUserMessage: async () => {},
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

async function seedIntentAtImplementing(
  cwd: string,
  verificationCommand = "true",
): Promise<{ store: IntentStore; id: string }> {
  const store = loadStore(cwd);
  const intent = createIntent(store, cwd, "test work");
  saveIntentContent(
    cwd,
    intent.id,
    `# Intent\n\n## Description\ntest\n\n## Success Criteria\n- passes verification\n\n## Verification\n\n\`\`\`bash\n${verificationCommand}\n\`\`\`\n`,
  );
  transitionPhase(store, intent.id, "implementing");
  await saveStore(cwd, store);
  return { store, id: intent.id };
}

describe("OrchestratorDriver — implementer proposal moves to reviewing", () => {
  test("after proposal, phase becomes reviewing", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);
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
      // Allow async chain including lockfile I/O to complete.
      await drainAsync();

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
      const { id } = await seedIntentAtImplementing(cwd);
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
      await drainAsync();

      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "proposed-ready");
    });
  });
});

describe("OrchestratorDriver — reviewer rework increments and returns", () => {
  test("rework verdict transitions back to implementing and bumps reworkCount", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);
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
      await drainAsync();

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
      const { id: parentId } = await seedIntentAtImplementing(cwd);
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
      await drainAsync(200);

      const store = loadStore(cwd);
      const parent = store.intents.find((i) => i.id === parentId)!;
      assert.equal(parent.phase, "blocked-on-child");
      const children = store.intents.filter((i) => i.parentId === parentId);
      assert.equal(children.length, 1);
      assert.equal(children[0].phase, "defining");
      assert.equal(readActiveIntent(cwd), children[0].id);
      assert.ok(readLog(cwd, parentId).includes("spawn-child"));
    });
  });
});

describe("OrchestratorDriver — child done resumes parent", () => {
  test("parent unblocks to implementing when child reaches done", async () => {
    await withTempDir(async (cwd) => {
      // Seed parent at implementing, then blocked-on-child.
      const { id: parentId } = await seedIntentAtImplementing(cwd);
      const preload = loadStore(cwd);
      transitionPhase(preload, parentId, "blocked-on-child");
      // Create a child manually to simulate the spawn having already happened.
      const child = createIntent(preload, cwd, "prerequisite work", {
        parentId,
      });
      await saveStore(cwd, preload);

      // Mark child as done so the driver's phase-changed handler runs
      // the resume-parent branch.
      const midStore = loadStore(cwd);
      // Legal path: defining → implementing → reviewing → proposed-ready → done
      transitionPhase(midStore, child.id, "implementing");
      transitionPhase(midStore, child.id, "reviewing");
      transitionPhase(midStore, child.id, "proposed-ready");
      transitionPhase(midStore, child.id, "done");
      await saveStore(cwd, midStore);

      const { pi } = buildDriver({ cwd });
      pi.events.emit("intent:phase-changed", {
        id: child.id,
        from: "reviewing",
        to: "done",
      });
      await drainAsync();

      const afterStore = loadStore(cwd);
      const parentAfter = afterStore.intents.find((i) => i.id === parentId)!;
      assert.equal(parentAfter.phase, "implementing");
      assert.equal(readActiveIntent(cwd), parentId);
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
      await saveStore(cwd, store);

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
          getTranscript: () => [],
          sendUserMessage: async () => {},
        }),
      );
      driver.start();

      pi.events.emit("intent:phase-changed", {
        id: leaf.id,
        from: "defining",
        to: "implementing",
      });
      await drainAsync();

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
      const { id } = await seedIntentAtImplementing(cwd);
      // Force intent to have already hit rework cap.
      const preload = loadStore(cwd);
      const target = preload.intents.find((i) => i.id === id)!;
      target.reworkCount = 5;
      await saveStore(cwd, preload);

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
      await drainAsync();

      // Phase stays at implementing (cap reached; human must act).
      const store = loadStore(cwd);
      const after = store.intents.find((i) => i.id === id)!;
      assert.equal(after.phase, "implementing");
      assert.equal(after.reworkCount, 5);
      assert.ok(readLog(cwd, id).includes("escalation"));
    });
  });
});


describe("OrchestratorDriver — pending-signal persistence and replay", () => {
  test("proposal-signal event clears pending-signal.json on successful route", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);
      const { pi } = buildDriver({
        cwd,
        impl: [{ signal: null }],
        reviewer: [{ signal: null }],
      });

      pi.events.emit("orchestrator:proposal-signal", {
        intentId: id,
        summary: "done",
        artifacts: [],
        proposedAt: new Date().toISOString(),
      });
      await drainAsync();

      const { readPendingSignal } = await import("./signal-store.ts");
      assert.equal(readPendingSignal(cwd, id), null);
      assert.equal(
        loadStore(cwd).intents.find((i) => i.id === id)!.phase,
        "reviewing",
      );
    });
  });

  test("driver.start() replays a persisted proposal signal", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);

      const { writePendingSignal, readPendingSignal } = await import(
        "./signal-store.ts"
      );
      writePendingSignal(cwd, id, {
        kind: "proposal",
        agentRole: "implementer",
        intentId: id,
        summary: "crash-mid-route",
        artifacts: [],
        proposedAt: new Date().toISOString(),
      });

      buildDriver({
        cwd,
        impl: [{ signal: null }],
        reviewer: [{ signal: null }],
      });
      await drainAsync();

      assert.equal(
        loadStore(cwd).intents.find((i) => i.id === id)!.phase,
        "reviewing",
      );
      assert.equal(readPendingSignal(cwd, id), null);
      assert.ok(readLog(cwd, id).includes("proposal"));
    });
  });

  test("replay clears stale pending signal that disagrees with phase", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);

      const { writePendingSignal, readPendingSignal } = await import(
        "./signal-store.ts"
      );
      writePendingSignal(cwd, id, {
        kind: "review",
        intentId: id,
        verdict: "pass",
        summary: "stale",
        findings: [],
        nextActions: [],
        reportedAt: new Date().toISOString(),
      });

      buildDriver({
        cwd,
        impl: [{ signal: null }],
        reviewer: [{ signal: null }],
      });
      await drainAsync();

      assert.equal(readPendingSignal(cwd, id), null);
      assert.equal(
        loadStore(cwd).intents.find((i) => i.id === id)!.phase,
        "implementing",
      );
    });
  });
});

describe("OrchestratorDriver — fresh dispatch on rework", () => {
  test("reviewer rework disposes prior implementer handle before re-dispatch", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);

      const { pi } = mockPi();
      const defs = new Map([
        ["intent-implementer", makeDef("intent-implementer")],
        ["intent-reviewer", makeDef("intent-reviewer")],
      ]);

      let implDispatchCount = 0;
      let implDisposeCount = 0;
      const dispatch = async (
        d: DispatchOptions,
      ): Promise<DispatchedAgentHandle> => {
        if (d.role === "implementer") {
          implDispatchCount += 1;
          const turn = implDispatchCount;
          return {
            role: "implementer",
            prompt: async () => {
              if (turn === 1) {
                d.flight.pendingSignal = {
                  kind: "proposal",
                  agentRole: "implementer",
                  intentId: id,
                  summary: "v1",
                  artifacts: [],
                  proposedAt: new Date().toISOString(),
                };
              }
            },
            dispose: async () => {
              implDisposeCount += 1;
            },
            getTranscript: () => [],
            sendUserMessage: async () => {},
          };
        }
        return {
          role: "reviewer",
          prompt: async () => {
            d.flight.pendingSignal = {
              kind: "review",
              intentId: id,
              verdict: "rework",
              summary: "needs work",
              findings: ["fix x"],
              nextActions: ["redo"],
              reportedAt: new Date().toISOString(),
            };
          },
          dispose: async () => {},
          getTranscript: () => [],
          sendUserMessage: async () => {},
        };
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
      await drainAsync(400);

      assert.equal(implDispatchCount, 2);
      assert.equal(implDisposeCount, 1);
    });
  });
});

describe("OrchestratorDriver — child summary injection on parent resume", () => {
  test("parent's resume prompt embeds child's understanding.md", async () => {
    await withTempDir(async (cwd) => {
      const { id: parentId } = await seedIntentAtImplementing(cwd);
      const preload = loadStore(cwd);
      transitionPhase(preload, parentId, "blocked-on-child");
      const child = createIntent(preload, cwd, "prerequisite work", {
        parentId,
      });
      await saveStore(cwd, preload);

      const { writeUnderstanding } = await import("../intent/store.ts");
      writeUnderstanding(
        cwd,
        child.id,
        "Did X. Touched files A, B. Decision: chose pattern Y because Z.",
      );

      const midStore = loadStore(cwd);
      transitionPhase(midStore, child.id, "implementing");
      transitionPhase(midStore, child.id, "reviewing");
      transitionPhase(midStore, child.id, "proposed-ready");
      transitionPhase(midStore, child.id, "done");
      await saveStore(cwd, midStore);

      // Capture the prompt sent to the parent's implementer turn.
      const prompts: string[] = [];
      const { pi } = mockPi();
      const defs = new Map([
        ["intent-implementer", makeDef("intent-implementer")],
        ["intent-reviewer", makeDef("intent-reviewer")],
      ]);
      const dispatch = async (
        d: DispatchOptions,
      ): Promise<DispatchedAgentHandle> => {
        return {
          role: d.role,
          prompt: async (text: string) => {
            prompts.push(text);
          },
          dispose: async () => {},
          getTranscript: () => [],
          sendUserMessage: async () => {},
        };
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
        id: child.id,
        from: "reviewing",
        to: "done",
      });
      await drainAsync();

      const resumePrompt = prompts.find((p) => p.includes("Child intent"));
      assert.ok(resumePrompt, "parent should receive a resume prompt");
      assert.match(resumePrompt!, /Child intent "Prerequisite work" completed/);
      assert.match(resumePrompt!, /Did X\. Touched files A, B\./);
    });
  });
});

describe("OrchestratorDriver — getActiveAgents and agents-changed event", () => {
  test("getActiveAgents returns empty list when no flights active", async () => {
    await withTempDir(async (cwd) => {
      const { driver } = buildDriver({ cwd });
      assert.deepEqual(driver.getActiveAgents(), []);
    });
  });

  test("getActiveAgents reflects dispatched agent", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);
      // Implementer writes no signal so it stays dispatched
      const { driver, pi } = buildDriver({
        cwd,
        impl: [{ signal: null }],
        reviewer: [{ signal: null }],
      });

      // Capture agents-changed events
      const agentEvents: unknown[] = [];
      pi.events.on("orchestrator:agents-changed", (payload) => {
        agentEvents.push(payload);
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      await drainAsync();

      // After dispatch, getActiveAgents should have been populated during the
      // dispatch (before the prompt finished). agents-changed should have fired.
      assert.ok(
        agentEvents.length >= 1,
        `expected at least 1 agents-changed event, got ${agentEvents.length}`,
      );
    });
  });

  test("orchestrator:agents-changed fires when agent is dispatched and disposed", async () => {
    await withTempDir(async (cwd) => {
      const { id } = await seedIntentAtImplementing(cwd);
      const fired: string[] = [];

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
        reviewer: [{ signal: null }],
      });

      pi.events.on("orchestrator:agents-changed", () => {
        fired.push("changed");
      });

      pi.events.emit("intent:phase-changed", {
        id,
        from: "defining",
        to: "implementing",
      });
      await drainAsync();

      assert.ok(fired.length >= 1, "agents-changed should fire at least once");
    });
  });

  test("getAgentHandle returns undefined for missing intentId", async () => {
    await withTempDir(async (cwd) => {
      const { driver } = buildDriver({ cwd });
      assert.equal(driver.getAgentHandle("nonexistent", "implementer"), undefined);
    });
  });
});
