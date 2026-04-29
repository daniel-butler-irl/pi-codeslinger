import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createIntent, loadStore, saveStore } from "../intent/store.ts";
import { registerQqExtension } from "./index.ts";
import { buildTranscriptLines } from "./overlay.ts";

class FakeOverlayHandle {
  hidden = false;
  focused = false;
  hideCalls = 0;

  setHidden(hidden: boolean) {
    this.hidden = hidden;
  }

  isHidden() {
    return this.hidden;
  }

  focus() {
    this.focused = true;
  }

  unfocus() {
    this.focused = false;
  }

  isFocused() {
    return this.focused;
  }

  hide() {
    this.hideCalls += 1;
    this.hidden = true;
    this.focused = false;
  }
}

function makeAssistantMessage(
  answer: string,
  stopReason: "stop" | "error" | "aborted" = "stop",
  errorMessage?: string,
) {
  return {
    role: "assistant",
    content: answer ? [{ type: "text" as const, text: answer }] : [],
    provider: "test-provider",
    model: "test-model",
    api: "openai-responses" as const,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function createMockSession(
  answerFor: (text: string) => string = (text) => `QQ:${text}`,
) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let messages: any[] = [];
  let isStreaming = false;
  const promptCalls: string[] = [];
  let abortCalls = 0;
  let disposeCalls = 0;

  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const session = {
    state: {
      get messages() {
        return messages;
      },
    },
    get isStreaming() {
      return isStreaming;
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (text: string) => {
      promptCalls.push(text);
      const userMessage = {
        role: "user",
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
      };
      const answer = answerFor(text);
      const partial = answer.slice(
        0,
        Math.max(1, Math.floor(answer.length / 2)),
      );
      const finalMessage = makeAssistantMessage(answer);

      isStreaming = true;
      emit({
        type: "message_start",
        message: userMessage,
      } as AgentSessionEvent);
      emit({
        type: "message_update",
        message: {
          ...makeAssistantMessage(partial),
          content: [{ type: "text" as const, text: partial }],
        },
        assistantMessageEvent: { type: "text_delta", delta: partial },
      } as AgentSessionEvent);
      emit({ type: "message_end", message: finalMessage } as AgentSessionEvent);
      emit({
        type: "turn_end",
        turnIndex: 0,
        message: finalMessage,
        toolResults: [],
      } as AgentSessionEvent);
      isStreaming = false;
      messages = [...messages, userMessage, finalMessage];
    },
    abort: async () => {
      abortCalls += 1;
      isStreaming = false;
    },
    dispose: () => {
      disposeCalls += 1;
      listeners.clear();
    },
  };

  return {
    session,
    promptCalls,
    getListenerCount: () => listeners.size,
    getAbortCalls: () => abortCalls,
    getDisposeCalls: () => disposeCalls,
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTempDir(fn: (cwd: string) => Promise<void> | void) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-qq-test-"));
  return Promise.resolve()
    .then(() => fn(cwd))
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
}

function createHarness() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const overlayHandles: FakeOverlayHandle[] = [];
  const overlays: Array<{ component?: any; options?: any }> = [];
  const createSessionCalls: any[] = [];
  const sessions: Array<ReturnType<typeof createMockSession>> = [];
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  let idle = true;

  const api = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerShortcut(name: string, options: any) {
      shortcuts.set(name, options);
    },
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

  const createResourceLoader = async () => ({
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "system",
    getAppendSystemPrompt: () => ["qq"],
    extendResources: () => {},
    reload: async () => {},
  });

  registerQqExtension(api, {
    createAgentSession: async (options: any) => {
      createSessionCalls.push(options);
      const record = createMockSession();
      sessions.push(record);
      return { session: record.session } as any;
    },
    createResourceLoader,
  });

  const ui = {
    notify(message: string, type?: "info" | "warning" | "error") {
      notifications.push({ message, type });
    },
    custom: async (factory: any, options?: any) => {
      let done!: (value: unknown) => void;
      const result = new Promise((resolve) => {
        done = resolve;
      });
      const handle = new FakeOverlayHandle();
      overlayHandles.push(handle);
      options?.onHandle?.(handle);
      const component = await factory(
        { terminal: { rows: 30, columns: 100 }, requestRender() {} },
        {
          fg: (_name: string, text: string) => text,
          bg: (_name: string, text: string) => text,
          bold: (text: string) => text,
          italic: (text: string) => text,
          underline: (text: string) => text,
          strikethrough: (text: string) => text,
        },
        { matches: () => false }, // pragma: allowlist secret
        done,
      );
      overlays.push({ component, options });
      return result;
    },
  };

  const baseCtx = {
    hasUI: true,
    ui,
    cwd: "/tmp/project",
    model: {
      provider: "test-provider",
      id: "test-model",
      api: "openai-responses",
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key", // pragma: allowlist secret
        headers: undefined,
      }),
    },
    isIdle: () => idle,
  } as unknown as ExtensionCommandContext & ExtensionContext;

  async function runEvent(
    name: string,
    event: unknown = {},
    ctx: any = baseCtx,
  ) {
    const list = handlers.get(name) ?? [];
    const results = [];
    for (const handler of list) {
      results.push(await handler(event, ctx));
    }
    return results;
  }

  async function command(name: string, args = "") {
    const cmd = commands.get(name);
    if (!cmd) throw new Error(`Missing command: ${name}`);
    await cmd.handler(args, baseCtx);
  }

  async function shortcut(name: string) {
    const entry = shortcuts.get(name);
    if (!entry) throw new Error(`Missing shortcut: ${name}`);
    await entry.handler(baseCtx);
  }

  return {
    notifications,
    overlayHandles,
    overlays,
    createSessionCalls,
    sessions,
    baseCtx,
    command,
    shortcut,
    runEvent,
    latestOverlay() {
      const overlay = overlays.at(-1)?.component;
      if (!overlay) throw new Error("Overlay not created");
      return overlay;
    },
    latestOverlayOptions() {
      return overlays.at(-1)?.options;
    },
    emitEvent(name: string, payload: unknown) {
      for (const handler of eventHandlers.get(name) ?? []) {
        handler(payload);
      }
    },
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

describe("qq extension", () => {
  test("registers /qq, /qq:clear, and ctrl+q", async () => {
    const harness = createHarness();

    await harness.shortcut("ctrl+q");
    await flushAsyncWork();

    assert.equal(harness.overlayHandles.length, 1);
    assert.equal(harness.createSessionCalls.length, 0);

    await harness.command("qq", "");
    await flushAsyncWork();
    assert.equal(harness.overlayHandles.length, 1);

    await harness.command("qq:clear", "");
    assert.deepEqual(harness.notifications.at(-1), {
      message: "Cleared quick-question chat.",
      type: "info",
    });
  });

  test("qq overlay is non-capturing and uses the full available height", async () => {
    const harness = createHarness();

    await harness.shortcut("ctrl+q");
    await flushAsyncWork();

    assert.deepEqual(harness.latestOverlayOptions()?.overlayOptions, {
      width: "72%",
      minWidth: 68,
      maxHeight: "100%",
      anchor: "top-center",
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      nonCapturing: true,
    });

    const overlay = harness.latestOverlay();
    assert.equal(overlay.render(80).length, 30);
  });

  test("qq transcript renders user markdown instead of showing raw markdown markers", () => {
    const lines = buildTranscriptLines(
      [
        {
          id: 1,
          type: "user",
          text: "# Question\n\n**bold**\n- item one",
        },
      ],
      {
        fg: (_name: string, text: string) => text,
        bg: (_name: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
      } as any,
      60,
    );

    const rendered = stripAnsi(lines.join("\n"));
    assert.match(rendered, /Question/);
    assert.match(rendered, /bold/);
    assert.match(rendered, /item one/);
    assert.doesNotMatch(rendered, /# Question/);
    assert.doesNotMatch(rendered, /\*\*bold\*\*/);
  });

  test("qq transcript renders assistant markdown instead of showing raw markdown markers", () => {
    const lines = buildTranscriptLines(
      [
        { id: 1, type: "user", text: "show me markdown" },
        {
          id: 2,
          type: "assistant",
          text: "# Heading\n\n**bold**\n- item one\n- item two",
          streaming: false,
        },
      ],
      {
        fg: (_name: string, text: string) => text,
        bg: (_name: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
      } as any,
      60,
    );

    const rendered = stripAnsi(lines.join("\n"));
    assert.match(rendered, /Heading/);
    assert.match(rendered, /bold/);
    assert.match(rendered, /item one/);
    assert.doesNotMatch(rendered, /\*\*bold\*\*/);
  });

  test("qq transcript renders system entries as a notice", () => {
    const lines = buildTranscriptLines(
      [{ id: 1, type: "system", text: "Session cleared — ask a new question" }],
      {
        fg: (_name: string, text: string) => text,
        bg: (_name: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
      } as any,
      60,
    );

    const rendered = stripAnsi(lines.join("\n"));
    assert.match(rendered, /Session cleared/);
    assert.match(rendered, /◆/);
  });

  test("/qq with a prompt creates a separate in-memory side session with repo tools plus intent tools", async () => {
    await withTempDir(async (cwd) => {
      const harness = createHarness();
      harness.baseCtx.cwd = cwd;

      await harness.command("qq", "where is auth configured?");
      await flushAsyncWork();

      assert.equal(harness.createSessionCalls.length, 1);
      const options = harness.createSessionCalls[0];
      assert.equal(options.cwd, cwd);
      assert.deepEqual(
        options.tools.map((tool: any) => tool.name),
        ["read", "grep", "find", "ls"],
      );
      assert.deepEqual(
        options.customTools.map((tool: any) => tool.name),
        [
          "create_intent",
          "update_understanding",
          "read_intent",
          "list_intents",
          "read_intent_log",
          "read_intent_understanding",
          "read_verification_results",
          "switch_intent",
          "lock_intent",
          "delete_intent",
        ],
      );
      assert.ok(options.sessionManager);
      assert.equal(
        harness.sessions[0]?.promptCalls[0],
        "where is auth configured?",
      );
    });
  });

  test("qq intent tools can create and switch intents from the side session", async () => {
    await withTempDir(async (cwd) => {
      const harness = createHarness();
      harness.baseCtx.cwd = cwd;

      await harness.command("qq", "open qq");
      await flushAsyncWork();

      const options = harness.createSessionCalls[0];
      const createIntentTool = options.customTools.find(
        (tool: any) => tool.name === "create_intent",
      );
      const listIntentsTool = options.customTools.find(
        (tool: any) => tool.name === "list_intents",
      );
      const switchIntentTool = options.customTools.find(
        (tool: any) => tool.name === "switch_intent",
      );

      assert.ok(createIntentTool);
      assert.ok(listIntentsTool);
      assert.ok(switchIntentTool);

      const created = await createIntentTool.execute(
        "tool-1",
        { description: "Investigate auth race condition" },
        undefined,
        undefined,
        harness.baseCtx,
      );
      assert.equal(created.isError, false);
      assert.match(created.content[0].text, /Created intent:/);

      const listed = await listIntentsTool.execute(
        "tool-2",
        { filter: "all" },
        undefined,
        undefined,
        harness.baseCtx,
      );
      assert.equal(listed.isError, false);
      assert.match(listed.content[0].text, /Investigate auth race condition/);

      const match = /\(([0-9a-f-]+)\)/.exec(created.content[0].text);
      assert.ok(match);
      const intentId = match![1]!;

      const switched = await switchIntentTool.execute(
        "tool-3",
        { intentId },
        undefined,
        undefined,
        harness.baseCtx,
      );
      assert.equal(switched.isError, false);
      assert.match(switched.content[0].text, /Switched to intent:/);
    });
  });

  test("qq list_intents active filter returns no intents when no active intent exists", async () => {
    await withTempDir(async (cwd) => {
      const harness = createHarness();
      harness.baseCtx.cwd = cwd;

      // No git repo in cwd, so readActiveIntent returns null — no active intent.
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      createIntent(store, cwd, "second intent");

      await harness.command("qq", "open qq");
      await flushAsyncWork();

      const options = harness.createSessionCalls[0];
      const listIntentsTool = options.customTools.find(
        (tool: any) => tool.name === "list_intents",
      );
      assert.ok(listIntentsTool);

      const listed = await listIntentsTool.execute(
        "tool-4",
        { filter: "active" },
        undefined,
        undefined,
        harness.baseCtx,
      );
      assert.equal(listed.isError, false);
      assert.equal(
        listed.content[0].text,
        "No intents found matching the filter.",
      );
    });
  });

  test("qq list_intents children filter returns no intents when no active intent exists", async () => {
    await withTempDir(async (cwd) => {
      const harness = createHarness();
      harness.baseCtx.cwd = cwd;

      // No git repo in cwd, so readActiveIntent returns null — no active intent.
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      createIntent(store, cwd, "second intent");

      await harness.command("qq", "open qq");
      await flushAsyncWork();

      const options = harness.createSessionCalls[0];
      const listIntentsTool = options.customTools.find(
        (tool: any) => tool.name === "list_intents",
      );
      assert.ok(listIntentsTool);

      const listed = await listIntentsTool.execute(
        "tool-5",
        { filter: "children" },
        undefined,
        undefined,
        harness.baseCtx,
      );
      assert.equal(listed.isError, false);
      assert.equal(
        listed.content[0].text,
        "No intents found matching the filter.",
      );
    });
  });

  test("qq keeps a back-and-forth transcript and can continue while the main session is busy", async () => {
    const harness = createHarness();

    await harness.command("qq", "first question");
    await flushAsyncWork();

    harness.setIdle(false);
    const overlay = harness.latestOverlay();
    overlay.input.onSubmit?.("follow-up question");
    await flushAsyncWork();

    assert.equal(harness.sessions[0]?.promptCalls.length, 2);
    assert.deepEqual(harness.sessions[0]?.promptCalls, [
      "first question",
      "follow-up question",
    ]);

    const entries = overlay.getTranscriptEntries();
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "user" && entry.text === "first question",
      ),
    );
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "assistant" &&
          entry.text.includes("QQ:first question"),
      ),
    );
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "user" && entry.text === "follow-up question",
      ),
    );
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "assistant" &&
          entry.text.includes("QQ:follow-up question"),
      ),
    );
  });

  test("ctrl+q reopens the hidden overlay and preserves the in-memory transcript", async () => {
    const harness = createHarness();

    await harness.command("qq", "first question");
    await flushAsyncWork();

    const firstOverlay = harness.latestOverlay();
    firstOverlay.input.onEscape?.();
    await flushAsyncWork();
    assert.equal(harness.overlayHandles.at(-1)?.isHidden(), true);
    assert.equal(harness.overlayHandles.length, 1);

    await harness.shortcut("ctrl+q");
    await flushAsyncWork();

    assert.equal(harness.overlayHandles.at(-1)?.isHidden(), false);
    assert.equal(harness.overlayHandles.length, 1);
    const reopened = harness.latestOverlay();
    const entries = reopened.getTranscriptEntries();
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "user" && entry.text === "first question",
      ),
    );
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.type === "assistant" &&
          entry.text.includes("QQ:first question"),
      ),
    );
  });

  test("/qq:clear aborts, disposes, shows a system notice, and keeps the overlay open", async () => {
    const harness = createHarness();

    await harness.command("qq", "first question");
    await flushAsyncWork();

    const session = harness.sessions[0];
    assert.ok(session);

    await harness.command("qq:clear", "");
    await flushAsyncWork();

    assert.equal(session?.getAbortCalls(), 1);
    assert.equal(session?.getDisposeCalls(), 1);

    const overlay = harness.latestOverlay();
    const entries = overlay.getTranscriptEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.type, "system");
    assert.match(entries[0]?.text ?? "", /Session cleared/);
    assert.equal(harness.overlayHandles.at(-1)?.isHidden(), false);
  });
});
