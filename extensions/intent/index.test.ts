import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  createIntent,
  loadStore,
  saveStore,
  saveIntentContent,
} from "./store.ts";
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
    .replaceAll("./paths.js", new URL("./paths.ts", import.meta.url).href)
    .replaceAll(
      "./active-local.js",
      new URL("./active-local.ts", import.meta.url).href,
    )
    .replaceAll("./lock.js", new URL("./lock.ts", import.meta.url).href)
    .replaceAll("./tools.js", new URL("./tools.ts", import.meta.url).href)
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

  return {
    tools,
    handlers,
    commands,
    shortcuts,
    emittedEvents,
    runEvent,
    runCommand,
  };
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
          editor() {
            return Promise.resolve(undefined);
          },
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
      assert.equal(
        activeAfter,
        intent.id,
        "active intent should be flipped to transitioned intent",
      );

      const activeChangedEvents = harness.emittedEvents.filter(
        (e) => e.event === "intent:active-changed",
      );
      assert.ok(
        activeChangedEvents.some(
          (e: any) => (e.payload as any).id === intent.id,
        ),
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
          editor() {
            return Promise.resolve(undefined);
          },
        },
        // no newSession property
      };

      await harness.runEvent("session_start", {}, eventCtx);
      await harness.runCommand("intent", "", eventCtx);

      const activeAfter = readActiveIntent(dir);
      assert.equal(
        activeAfter,
        intent.id,
        "active intent should still be flipped",
      );

      const notifyMsg = notifications.find((n) => n.msg.includes("manually"));
      assert.ok(notifyMsg, "user should be notified to switch manually");

      const activeChangedEvents = harness.emittedEvents.filter(
        (e) => e.event === "intent:active-changed",
      );
      assert.ok(
        activeChangedEvents.some(
          (e: any) => (e.payload as any).id === intent.id,
        ),
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
          editor() {
            return Promise.resolve(undefined);
          },
        },
        newSession() {
          newSessionCalled = true;
          return Promise.resolve();
        },
      };

      // Pre-set the intent as active before session_start
      const { writeActiveIntent: writeActive } =
        await import("./active-local.ts");
      writeActive(dir, intent.id);

      await harness.runEvent("session_start", {}, commandCtx);
      await harness.runCommand("intent", "", commandCtx);

      assert.equal(
        newSessionCalled,
        true,
        "newSession should still be called for already-active intent",
      );

      const activeAfter = readActiveIntent(dir);
      assert.equal(
        activeAfter,
        intent.id,
        "active intent should remain the same",
      );
    } finally {
      process.chdir(originalCwd);
      delete process.env.PI_WORKTREE_BASE;
      rmSync(wtBase, { recursive: true, force: true });
      cleanup();
    }
  });
});

describe("session-start-notice suppressed on hot-reload", () => {
  async function makeNoticeHarness(cwd: string) {
    const handlers = new Map<string, Function[]>();
    const sentMessages: any[] = [];
    const api = {
      on(event: string, handler: Function) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool() {},
      registerShortcut() {},
      registerCommand() {},
      sendMessage(msg: any) {
        sentMessages.push(msg);
      },
      events: { on() {}, emit() {} },
    } as any;
    const { default: intentExtension } = await loadIntentExtension();
    intentExtension(api);
    async function runSessionStart(sessionEntries: any[]) {
      const ctx = {
        cwd,
        hasUI: false,
        ui: { notify() {}, custom() {} },
        sessionManager: {
          getEntries() {
            return sessionEntries;
          },
        },
      };
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({}, ctx);
      }
    }
    return { runSessionStart, sentMessages };
  }

  test("does not send notice when sessionManager has prior entries (reload)", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "reload test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const { runSessionStart, sentMessages } = await makeNoticeHarness(dir);
      await runSessionStart([{ type: "assistant", content: "prior turn" }]);

      const notices = sentMessages.filter(
        (m) => m?.customType === "session-start-notice",
      );
      assert.equal(notices.length, 0, "notice must not be sent on hot-reload");
    } finally {
      cleanup();
    }
  });

  test("sends notice when sessionManager has no prior entries (genuine new session)", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "fresh session test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const { runSessionStart, sentMessages } = await makeNoticeHarness(dir);
      await runSessionStart([]);

      const notices = sentMessages.filter(
        (m) => m?.customType === "session-start-notice",
      );
      assert.equal(
        notices.length,
        1,
        "notice must be sent on genuine fresh session",
      );
    } finally {
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
      const { transitionPhase, writeUnderstanding } =
        await import("./store.ts");
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
      const { transitionPhase, writeUnderstanding } =
        await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      writeUnderstanding(
        dir,
        intent.id,
        "Current state: foo done, bar pending.",
      );
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");

      let signalEmitted = false;
      harness.tools as any; // unused
      const apiAny = harness as any;
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

describe("write_intent_contract tool", () => {
  test("writes provided sections and refuses with wrong phase", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "wic test");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("write_intent_contract");
      assert.ok(tool);

      // Successful write
      const result = await tool.execute(
        "call",
        {
          description: "Refactor login.",
          successCriteria: "All login tests pass.",
          verification: "Run npm test.",
        },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.details.written, [
        "Description",
        "Success Criteria",
        "Verification",
      ]);
      const { loadIntentContent } = await import("./store.ts");
      const updated = loadIntentContent(dir, intent.id);
      assert.match(updated, /Refactor login\./);
      assert.match(updated, /All login tests pass\./);
      assert.match(updated, /Run npm test\./);
      // Path is in the main repo (compare via realpath to dodge /private prefix on macOS)
      const dirReal = realpathSync(dir);
      assert.ok(
        realpathSync(result.details.path).startsWith(dirReal),
        `expected path under ${dirReal}, got ${result.details.path}`,
      );

      // After lock (phase != defining), refuses
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      // Reload harness so it picks up the new phase
      const harness2 = await createHarness(dir);
      await harness2.runEvent("session_start");
      const tool2 = harness2.tools.get("write_intent_contract");
      const refused = await tool2.execute(
        "call",
        { description: "nope" },
        undefined,
        undefined,
        harness2.ctx,
      );
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /locked/i);
    } finally {
      cleanup();
    }
  });

  test("from a worktree cwd, writes to the main repo path", async () => {
    const { dir, cleanup } = initGitRepo();
    const wtBase = mkdtempSync(join(tmpdir(), "pi-wic-wt-base-"));
    process.env.PI_WORKTREE_BASE = wtBase;
    try {
      // Create the intent in the main repo
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "wic worktree test");
      await saveStore(dir, store);

      // Create a worktree for the intent and run the tool from there
      const { createWorktree } = await import("./worktree-manager.ts");
      const wt = createWorktree(dir, intent.title, intent.id);

      // Make the intent active under the worktree's git-dir
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(wt.path, intent.id);

      const harness = await createHarness(wt.path);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("write_intent_contract");
      assert.ok(tool);

      const result = await tool.execute(
        "call",
        {
          description: "From worktree.",
          successCriteria: "Path resolves to main.",
          verification: "Verify file.",
        },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, false);
      // The written path lives under the MAIN repo, not the worktree.
      const dirReal = realpathSync(dir);
      const wtReal = realpathSync(wt.path);
      const pathReal = realpathSync(result.details.path);
      assert.ok(
        pathReal.startsWith(dirReal),
        `expected main-repo path under ${dirReal}, got ${pathReal}`,
      );
      assert.ok(!pathReal.startsWith(wtReal), "must not write into worktree");

      // The main-repo file actually contains the new content.
      const mainContent = readFileSync(result.details.path, "utf-8");
      assert.match(mainContent, /From worktree\./);
    } finally {
      delete process.env.PI_WORKTREE_BASE;
      rmSync(wtBase, { recursive: true, force: true });
      cleanup();
    }
  });
});

describe("lock_intent tool", () => {
  test("returns structured missing list when sections are empty", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "lock missing test");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("lock_intent");
      assert.ok(tool);

      const result = await tool.execute(
        "call",
        { createWorktree: false },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.equal(result.details.ok, false);
      assert.deepEqual(result.details.missing, [
        "Success Criteria",
        "Verification",
      ]);
    } finally {
      cleanup();
    }
  });

  test("locks successfully without a worktree when createWorktree=false", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "lock ok test");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("lock_intent");

      const result = await tool.execute(
        "call",
        { createWorktree: false },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, false);
      assert.equal(result.details.ok, true);
      assert.equal(result.details.phase, "implementing");
      assert.equal(result.details.worktreePath, undefined);
    } finally {
      cleanup();
    }
  });

  test("refuses when phase is not defining", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "lock wrong phase");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("lock_intent");
      const result = await tool.execute(
        "call",
        { createWorktree: false },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.equal(result.details.ok, false);
      assert.match(result.content[0].text, /already locked/);
    } finally {
      cleanup();
    }
  });
});

describe("transition_phase tool", () => {
  test("legal transition succeeds and emits intent:phase-changed", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "tp ok");
      saveIntentContent(dir, intent.id, VALID_INTENT_CONTENT);
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("transition_phase");
      assert.ok(tool);

      const result = await tool.execute(
        "call",
        { toPhase: "reviewing" },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, false);
      assert.equal(result.details.ok, true);
      assert.equal(result.details.to, "reviewing");
    } finally {
      cleanup();
    }
  });

  test("illegal transition returns structured error", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "tp illegal");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");
      const tool = harness.tools.get("transition_phase");

      // defining -> done is not legal
      const result = await tool.execute(
        "call",
        { toPhase: "done" },
        undefined,
        undefined,
        harness.ctx,
      );
      assert.equal(result.isError, true);
      assert.equal(result.details.ok, false);
      assert.match(result.details.reason, /Illegal phase transition/);
    } finally {
      cleanup();
    }
  });
});

describe("lock-edit guard", () => {
  test("blocks Edit/Write on intent.md regardless of phase", async () => {
    const { dir, cleanup } = initGitRepo();
    try {
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "guard test");
      await saveStore(dir, store);
      const { writeActiveIntent } = await import("./active-local.ts");
      writeActiveIntent(dir, intent.id);

      const harness = await createHarness(dir);
      await harness.runEvent("session_start");

      // The harness installs `tool_call` handlers via api.on. We need to
      // grab them and invoke directly. Check the per-event handler list.
      const handlers = (harness as any).runEvent ? null : null;
      void handlers;

      // Use a tiny inline handler invocation by re-creating an api spy.
      // Instead, easier: invoke the tool_call hook by looking at all
      // handlers registered on the underlying api. Recreate harness with
      // our own probe.
      const probe = await createGuardHarness(dir);
      const { intentContractPath } = await import("./store.ts");
      const path = intentContractPath(dir, intent.id);

      // Phase is `defining` — guard must still block.
      const definingResult = await probe.runToolCall({
        toolName: "edit",
        input: { path },
      });
      assert.ok(definingResult);
      assert.equal(definingResult.block, true);
      assert.match(definingResult.reason, /write_intent_contract/);

      // After lock, still blocked.
      const { transitionPhase } = await import("./store.ts");
      transitionPhase(store, intent.id, "implementing");
      await saveStore(dir, store);
      const probe2 = await createGuardHarness(dir);
      const lockedResult = await probe2.runToolCall({
        toolName: "write",
        input: { path },
      });
      assert.equal(lockedResult.block, true);
    } finally {
      cleanup();
    }
  });
});

async function createGuardHarness(cwd: string) {
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
        for (const h of eventHandlers.get(event) ?? []) h(payload);
      },
    },
  } as unknown as ExtensionAPI;

  const { default: intentExtension } = await loadIntentExtension();
  intentExtension(api);

  const ctx = {
    cwd,
    hasUI: true,
    ui: { custom() {}, notify() {} },
  } as unknown as ExtensionContext;

  // Run session_start so the store is populated in-memory.
  for (const h of handlers.get("session_start") ?? []) {
    await h({}, ctx);
  }

  async function runToolCall(event: any) {
    let last: unknown = undefined;
    for (const h of handlers.get("tool_call") ?? []) {
      last = await h(event, ctx);
    }
    return last as any;
  }

  return { runToolCall };
}
