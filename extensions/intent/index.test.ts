import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createIntent, loadStore, saveStore } from "./store.ts";

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
