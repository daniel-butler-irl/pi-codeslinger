import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createIntent, loadStore, saveStore, saveIntentContent } from "./store.ts";
import { readActiveIntent } from "./active-local.ts";

function withTempDir(fn: (cwd: string) => Promise<void> | void) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-intent-tools-test-"));
  return Promise.resolve()
    .then(() => fn(cwd))
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
}

async function loadIntentExtension() {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf-8")
    .replaceAll("./validate.js", new URL("./validate.ts", import.meta.url).href)
    .replaceAll("./store.js", new URL("./store.ts", import.meta.url).href)
    .replaceAll("./panel.js", new URL("./panel.ts", import.meta.url).href)
    .replaceAll("./overlay.js", new URL("./overlay.ts", import.meta.url).href)
    .replaceAll(
      "./title-generator.js",
      new URL("./title-generator.ts", import.meta.url).href,
    )
    .replaceAll(
      "./transition-gate.js",
      new URL("./transition-gate.ts", import.meta.url).href,
    )
    .replaceAll(
      "./worktree-manager.js",
      new URL("./worktree-manager.ts", import.meta.url).href,
    )
    .replaceAll(
      "./done-flow.js",
      new URL("./done-flow.ts", import.meta.url).href,
    )
    .replaceAll(
      "./paths.js",
      new URL("./paths.ts", import.meta.url).href,
    )
    .replaceAll(
      "./active-local.js",
      new URL("./active-local.ts", import.meta.url).href,
    )
    .replaceAll(
      "./lock.js",
      new URL("./lock.ts", import.meta.url).href,
    )
    .replaceAll(
      "../orchestrator/agent-overlay.js",
      new URL("../orchestrator/agent-overlay.ts", import.meta.url).href,
    )
    .replaceAll(
      "../orchestrator/index.js",
      new URL("../orchestrator/index.ts", import.meta.url).href,
    )
    .replaceAll(
      "../orchestrator/state.js",
      new URL("../orchestrator/state.ts", import.meta.url).href,
    );

  const tempDir = mkdtempSync(
    join(process.cwd(), "extensions/intent/.testable-module-"),
  );
  const tempModule = join(tempDir, "index.testable.ts");
  writeFileSync(tempModule, source, "utf-8");
  const module = await import(
    `${pathToFileURL(tempModule).href}?t=${Date.now()}`
  );
  rmSync(tempDir, { recursive: true, force: true });
  return module;
}

async function createHarness(cwd: string) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();

  const api = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(options: any) {
      tools.set(options.name, options);
    },
    registerShortcut() {},
    registerCommand() {},
    sendMessage() {},
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) {
          handler(payload);
        }
      },
    },
  } as unknown as ExtensionAPI;

  const { default: intentExtension } = await loadIntentExtension();
  intentExtension(api);

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      custom() {
        return undefined;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;

  async function runEvent(name: string, event: unknown = {}) {
    for (const handler of handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  }

  return { tools, ctx, runEvent };
}

describe("intent extension list_intents", () => {
  test("active filter returns no intents when no active intent exists", async () => {
    await withTempDir(async (cwd) => {
      // No git repo in cwd, so readActiveIntent returns null — no active intent.
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      createIntent(store, cwd, "second intent");
      await saveStore(cwd, store);

      const harness = await createHarness(cwd);
      await harness.runEvent("session_start");

      const tool = harness.tools.get("list_intents");
      assert.ok(tool);

      const result = await tool.execute(
        "call-1",
        { filter: "active" },
        undefined,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, false);
      assert.equal(
        result.content[0].text,
        "No intents found matching the filter.",
      );
    });
  });

  test("children filter returns no intents when no active intent exists", async () => {
    await withTempDir(async (cwd) => {
      // No git repo in cwd, so readActiveIntent returns null — no active intent.
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      createIntent(store, cwd, "second intent");
      await saveStore(cwd, store);

      const harness = await createHarness(cwd);
      await harness.runEvent("session_start");

      const tool = harness.tools.get("list_intents");
      assert.ok(tool);

      const result = await tool.execute(
        "call-2",
        { filter: "children" },
        undefined,
        undefined,
        harness.ctx,
      );

      assert.equal(result.isError, false);
      assert.equal(
        result.content[0].text,
        "No intents found matching the filter.",
      );
    });
  });
});

function initGitRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-intent-transition-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "main\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const VALID_INTENT_CONTENT = `## Description
Test intent for gap 8.

## Success Criteria
All tests pass.

## Verification
Run npm test.
`;

async function createTransitionHarness(cwd: string) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, Function>();
  const shortcuts = new Map<string, Function>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];

  const api = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(options: any) {
      tools.set(options.name, options);
    },
    registerShortcut(key: string, options: any) {
      shortcuts.set(key, options.handler);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options.handler);
    },
    sendMessage() {},
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      emit(event: string, payload: unknown) {
        emittedEvents.push({ event, payload });
        for (const handler of eventHandlers.get(event) ?? []) {
          handler(payload);
        }
      },
    },
  } as unknown as ExtensionAPI;

  const { default: intentExtension } = await loadIntentExtension();
  intentExtension(api);

  async function runEvent(name: string, event: unknown = {}, ctx: any) {
    for (const handler of handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  }

  async function runCommand(name: string, args: string, ctx: any) {
    const handler = commands.get(name);
    if (!handler) throw new Error(`Command not found: ${name}`);
    await handler(args, ctx);
  }

  return { tools, handlers, commands, shortcuts, emittedEvents, runEvent, runCommand };
}

describe("Gap 8 — auto-switch active on transition to implementing", () => {
  test("non-active intent transitioned to implementing flips active and calls newSession", async () => {
    const originalCwd = process.cwd();
    const { dir, cleanup } = initGitRepo();
    const wtBase = mkdtempSync(join(tmpdir(), "pi-wt-base-"));
    process.env.PI_WORKTREE_BASE = wtBase;

    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "gap8 test intent");
      const fakeWtPath = mkdtempSync(join(tmpdir(), "pi-fake-wt-"));
      intent.worktreePath = fakeWtPath;
      intent.worktreeBranch = "intent/gap8-test";
      await saveStore(dir, store);
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);

      const harness = await createTransitionHarness(dir);

      let newSessionCalled = false;
      const notifications: Array<{ msg: string; level: string }> = [];

      const commandCtx = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify(msg: string, level: string) {
            notifications.push({ msg, level });
          },
          confirm() {
            return Promise.resolve(true);
          },
          custom() {
            return Promise.resolve({
              type: "transition",
              intentId: intent.id,
              toPhase: "implementing",
            });
          },
          editor() { return Promise.resolve(undefined); },
        },
        newSession() {
          newSessionCalled = true;
          return Promise.resolve();
        },
      };

      await harness.runEvent("session_start", {}, commandCtx);
      await harness.runCommand("intent", "", commandCtx);

      assert.equal(newSessionCalled, true, "newSession should be called");

      const activeAfter = readActiveIntent(dir);
      assert.equal(activeAfter, intent.id, "active intent should be flipped to transitioned intent");

      const activeChangedEvents = harness.emittedEvents.filter(
        (e) => e.event === "intent:active-changed",
      );
      assert.ok(
        activeChangedEvents.some((e: any) => (e.payload as any).id === intent.id),
        "intent:active-changed event should be emitted",
      );
    } finally {
      process.chdir(originalCwd);
      delete process.env.PI_WORKTREE_BASE;
      rmSync(wtBase, { recursive: true, force: true });
      cleanup();
    }
  });

  test("non-active intent transitioned to implementing without newSession notifies user", async () => {
    const originalCwd = process.cwd();
    const { dir, cleanup } = initGitRepo();
    const wtBase = mkdtempSync(join(tmpdir(), "pi-wt-base2-"));
    process.env.PI_WORKTREE_BASE = wtBase;

    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "gap8 notify test");
      const fakeWtPath = mkdtempSync(join(tmpdir(), "pi-fake-wt2-"));
      intent.worktreePath = fakeWtPath;
      intent.worktreeBranch = "intent/gap8-notify";
      await saveStore(dir, store);
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);

      const harness = await createTransitionHarness(dir);

      const notifications: Array<{ msg: string; level: string }> = [];

      // Context without newSession — simulates event/hook context
      const eventCtx = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify(msg: string, level: string) {
            notifications.push({ msg, level });
          },
          confirm() {
            return Promise.resolve(true);
          },
          custom() {
            return Promise.resolve({
              type: "transition",
              intentId: intent.id,
              toPhase: "implementing",
            });
          },
          editor() { return Promise.resolve(undefined); },
        },
        // no newSession property
      };

      await harness.runEvent("session_start", {}, eventCtx);
      await harness.runCommand("intent", "", eventCtx);

      const activeAfter = readActiveIntent(dir);
      assert.equal(activeAfter, intent.id, "active intent should still be flipped");

      const notifyMsg = notifications.find((n) => n.msg.includes("manually"));
      assert.ok(notifyMsg, "user should be notified to switch manually");

      const activeChangedEvents = harness.emittedEvents.filter(
        (e) => e.event === "intent:active-changed",
      );
      assert.ok(
        activeChangedEvents.some((e: any) => (e.payload as any).id === intent.id),
        "intent:active-changed event should be emitted even without newSession",
      );
    } finally {
      process.chdir(originalCwd);
      delete process.env.PI_WORKTREE_BASE;
      rmSync(wtBase, { recursive: true, force: true });
      cleanup();
    }
  });

  test("already-active intent transitioned to implementing still calls newSession (regression)", async () => {
    const originalCwd = process.cwd();
    const { dir, cleanup } = initGitRepo();
    const wtBase = mkdtempSync(join(tmpdir(), "pi-wt-base3-"));
    process.env.PI_WORKTREE_BASE = wtBase;

    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "gap8 active regression");
      const fakeWtPath = mkdtempSync(join(tmpdir(), "pi-fake-wt3-"));
      intent.worktreePath = fakeWtPath;
      intent.worktreeBranch = "intent/gap8-active";
      await saveStore(dir, store);
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);

      const harness = await createTransitionHarness(dir);

      let newSessionCalled = false;
      const notifications: Array<{ msg: string; level: string }> = [];

      const commandCtx = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify(msg: string, level: string) {
            notifications.push({ msg, level });
          },
          confirm() {
            return Promise.resolve(true);
          },
          custom() {
            return Promise.resolve({
              type: "transition",
              intentId: intent.id,
              toPhase: "implementing",
            });
          },
          editor() { return Promise.resolve(undefined); },
        },
        newSession() {
          newSessionCalled = true;
          return Promise.resolve();
        },
      };

      // Pre-set the intent as active before session_start
      const { writeActiveIntent: writeActive } = await import("./active-local.ts");
      writeActive(dir, intent.id);

      await harness.runEvent("session_start", {}, commandCtx);
      await harness.runCommand("intent", "", commandCtx);

      assert.equal(newSessionCalled, true, "newSession should still be called for already-active intent");

      const activeAfter = readActiveIntent(dir);
      assert.equal(activeAfter, intent.id, "active intent should remain the same");
    } finally {
      process.chdir(originalCwd);
      delete process.env.PI_WORKTREE_BASE;
      rmSync(wtBase, { recursive: true, force: true });
      cleanup();
    }
  });
});

describe("Gap 3 — propose_done blocks on stale or missing understanding.md", () => {
  test("rejects proposal when understanding.md missing", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("propose_done");
      assert.ok(tool);
      const result = await tool.execute(
        "call",
        { summary: "done", artifacts: [] },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /understanding\.md does not exist/);
    } finally {
      cleanup();
    }
  });

  test("rejects proposal when understanding.md is empty", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase, writeUnderstanding } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      writeUnderstanding(dir, intent.id, "   \n  ");
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("propose_done");
      const result = await tool.execute(
        "call",
        { summary: "done", artifacts: [] },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /understanding\.md is empty/);
    } finally {
      cleanup();
    }
  });

  test("rejects proposal when understanding.md is older than phaseEnteredAt", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase, writeUnderstanding, intentUnderstandingPath } =
        await import("./store.ts");
      writeUnderstanding(dir, intent.id, "stale content");
      // Force understanding mtime far in the past.
      const { utimesSync } = await import("fs");
      const past = new Date(Date.now() - 1000 * 60 * 60);
      const understandingPath = intentUnderstandingPath(dir, intent.id);
      utimesSync(understandingPath, past, past);
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("propose_done");
      const result = await tool.execute(
        "call",
        { summary: "done", artifacts: [] },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /has not been updated/);
    } finally {
      cleanup();
    }
  });

  test("accepts proposal when understanding.md is fresh and non-empty", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase, writeUnderstanding } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      writeUnderstanding(dir, intent.id, "Current state: foo done, bar pending.");
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");

      let signalEmitted = false;
      (harness.tools as any); // unused
      const apiAny = (harness as any);
      // Tap the events bus from the harness via reflection: use the
      // same eventHandlers map by re-registering our own listener via
      // ctx-less api access. Instead, just verify isError=false.
      void signalEmitted;
      void apiAny;

      const tool = harness.tools.get("propose_done");
      const result = await tool.execute(
        "call",
        { summary: "done", artifacts: [] },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /Proposal submitted/);
    } finally {
      cleanup();
    }
  });
});
