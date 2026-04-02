// extensions/intent/index.ts
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import {
  loadStore,
  saveStore,
  createIntent,
  deleteIntent,
  getActiveIntent,
  loadIntentContent,
  saveIntentContent,
  intentFilePath,
  type IntentStore,
} from "./store.js";
import { createIntentSidebar } from "./panel.js";

class WidthLimiter implements Component {
  constructor(
    private readonly inner: Component,
    private readonly getWidth: () => number,
  ) {}

  render(width: number): string[] {
    const limited = this.getWidth();
    const lines = this.inner.render(limited);
    return lines.map(
      (line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))),
    );
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }
}

export default function (pi: ExtensionAPI) {
  let store: IntentStore = { activeIntentId: null, intents: [] };
  let panel: ReturnType<typeof createIntentSidebar> | null = null;
  let tuiRef: TUI | null = null;

  pi.on("session_start", (_event, ctx) => {
    store = loadStore(ctx.cwd);

    ctx.ui.custom(
      (tui, theme) => {
        tuiRef = tui;

        const sidebarWidth = () =>
          Math.min(40, Math.max(24, Math.floor(tui.terminal.columns * 0.25)));

        panel = createIntentSidebar(store, tui, theme);

        for (let i = 0; i < tui.children.length; i++) {
          tui.children[i] = new WidthLimiter(
            tui.children[i],
            () => tui.terminal.columns - sidebarWidth(),
          );
        }

        return panel;
      },
      {
        overlay: true,
        overlayOptions: () => {
          const cols = tuiRef?.terminal.columns ?? 80;
          const w = Math.min(40, Math.max(24, Math.floor(cols * 0.25)));
          return {
            anchor: "top-right" as const,
            width: w,
            maxHeight: "100%" as const,
            nonCapturing: true,
          };
        },
      },
    );
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const active = getActiveIntent(store);
    if (!active) return;
    const path = intentFilePath(ctx.cwd, active.id);
    const base = ctx.getSystemPrompt();
    return {
      systemPrompt: `${base}\n\n## Current Intent\nThe user's current intent is described in \`${path}\`. Read this file to understand their goals and context before starting work.`,
    };
  });

  pi.registerCommand("intent", {
    description: "Create, switch, edit, or delete intents",
    handler: async (_args, ctx) => {
      const active = getActiveIntent(store);
      const items = ["Create new intent"];
      if (active) items.push("Edit intent", "Switch intent", "Delete intent");
      else if (store.intents.length > 0) items.push("Switch intent");

      const action = await ctx.ui.select("Intent", items);
      if (!action) return;

      if (action === "Create new intent") await handleCreate(ctx);
      else if (action === "Edit intent") await handleEdit(ctx);
      else if (action === "Switch intent") await handleSwitch(ctx);
      else if (action === "Delete intent") await handleDelete(ctx);

      const active2 = getActiveIntent(store);
      const desc = active2
        ? shortDesc(loadIntentContent(ctx.cwd, active2.id))
        : null;
      panel?.update(store, desc);
    },
  });

  async function handleCreate(ctx: ExtensionCommandContext) {
    const description = await ctx.ui.input(
      "Describe your intent",
      "e.g. Fix the auth bug in the login flow",
    );
    if (!description) return;
    createIntent(store, ctx.cwd, description);
    saveStore(ctx.cwd, store);
    ctx.ui.notify(`Intent set: "${getActiveIntent(store)?.title}"`, "info");
  }

  async function handleEdit(ctx: ExtensionCommandContext) {
    const active = getActiveIntent(store);
    if (!active) return;
    const current = loadIntentContent(ctx.cwd, active.id);
    const updated = await ctx.ui.editor(
      `Edit intent: ${active.title}`,
      current,
    );
    if (!updated || updated === current) return;
    saveIntentContent(ctx.cwd, active.id, updated);
    ctx.ui.notify("Intent updated", "info");
  }

  async function handleSwitch(ctx: ExtensionCommandContext) {
    if (store.intents.length === 0) {
      ctx.ui.notify("No intents yet — create one first", "warning");
      return;
    }
    const options = store.intents.map((i) => i.title);
    const chosen = await ctx.ui.select("Switch to", options);
    if (!chosen) return;
    const intent = store.intents.find((i) => i.title === chosen);
    if (!intent) return;
    store.activeIntentId = intent.id;
    saveStore(ctx.cwd, store);
  }

  async function handleDelete(ctx: ExtensionCommandContext) {
    const active = getActiveIntent(store);
    if (!active) return;
    const confirmed = await ctx.ui.confirm(
      "Delete intent",
      `Delete "${active.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    deleteIntent(store, ctx.cwd, active.id);
    saveStore(ctx.cwd, store);
  }
}

function shortDesc(content: string): string | null {
  const first = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? null;
}
