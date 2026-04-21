// extensions/intent/index.ts
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { resolve, normalize } from "path";
import { validateIntentForLock } from "./validate.js";
import {
  loadStore,
  saveStore,
  createIntent,
  deleteIntent,
  getActiveIntent,
  loadIntentContent,
  saveIntentContent,
  intentContractPath,
  transitionPhase,
  type IntentStore,
  type IntentPhase,
} from "./store.js";
import { createIntentSidebar } from "./panel.js";

/**
 * Wraps a child Component so it renders at a limited width but pads its
 * lines out to the full TUI width. Used to squeeze the native chat UI
 * over to the left when we paint the intent sidebar on the right.
 */
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
  let cwdRef: string = process.cwd();

  // ── Helpers ─────────────────────────────────────────────────────────────

  function refreshPanel(): void {
    const active = getActiveIntent(store);
    const desc = active
      ? shortDesc(loadIntentContent(cwdRef, active.id))
      : null;
    panel?.update(store, desc, active?.phase ?? null);
  }

  function persist(cwd: string): void {
    saveStore(cwd, store);
    refreshPanel();
  }

  // ── Lifecycle: mount the sidebar ────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    store = loadStore(ctx.cwd);
    cwdRef = ctx.cwd;

    ctx.ui.custom(
      (tui, theme) => {
        tuiRef = tui;

        const sidebarWidth = () =>
          Math.min(40, Math.max(24, Math.floor(tui.terminal.columns * 0.25)));

        panel = createIntentSidebar(store, tui, theme);
        refreshPanel();

        // Squeeze the rest of the TUI so the sidebar has room.
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

  // ── Lock enforcement ────────────────────────────────────────────────────
  //
  // Any intent not in the "defining" phase has its contract file frozen.
  // If an agent tries to edit or overwrite a locked contract file, we block
  // the tool call with an explanatory reason. This is the hard enforcement;
  // skill/system-prompt language is the soft layer that keeps agents from
  // bumping against this in the first place.

  pi.on("tool_call", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as { path?: string };
    if (!input.path) return;

    const absolutePath = normalize(resolve(cwdRef, input.path));
    const match = store.intents.find(
      (i) => normalize(intentContractPath(cwdRef, i.id)) === absolutePath,
    );
    if (!match) return;

    if (match.phase !== "defining") {
      return {
        block: true,
        reason:
          `Intent contract is locked (phase: ${match.phase}). ` +
          `The contract is immutable outside the defining phase. ` +
          `If the contract needs to change, the user must amend it from the /intent menu.`,
      };
    }
  });

  // ── /intent command ─────────────────────────────────────────────────────

  pi.registerCommand("intent", {
    description: "Create, switch, edit, lock, or delete intents",
    handler: async (_args, ctx) => {
      const active = getActiveIntent(store);

      const items: string[] = ["Create new intent"];
      if (active) {
        if (active.phase === "defining") {
          items.push("Edit intent", "Lock intent (finish defining)");
        }
        items.push("Switch intent", "Delete intent");
      } else if (store.intents.length > 0) {
        items.push("Switch intent");
      }

      const action = await ctx.ui.select("Intent", items);
      if (!action) return;

      if (action === "Create new intent") await handleCreate(ctx);
      else if (action === "Edit intent") await handleEdit(ctx);
      else if (action === "Lock intent (finish defining)")
        await handleLock(ctx);
      else if (action === "Switch intent") await handleSwitch(ctx);
      else if (action === "Delete intent") await handleDelete(ctx);

      refreshPanel();
    },
  });

  // ── Command handlers ────────────────────────────────────────────────────

  async function handleCreate(ctx: ExtensionCommandContext): Promise<void> {
    const description = await ctx.ui.input(
      "Describe your intent",
      "e.g. Fix the auth bug in the login flow",
    );
    if (!description) return;
    const intent = createIntent(store, ctx.cwd, description);
    persist(ctx.cwd);
    pi.events.emit("intent:created", { id: intent.id });
    ctx.ui.notify(`Intent set: "${intent.title}"`, "info");
  }

  async function handleEdit(ctx: ExtensionCommandContext): Promise<void> {
    const active = getActiveIntent(store);
    if (!active) return;
    if (active.phase !== "defining") {
      ctx.ui.notify(
        `Intent is locked (${active.phase}). Cannot edit outside defining phase.`,
        "warning",
      );
      return;
    }
    const current = loadIntentContent(ctx.cwd, active.id);
    const updated = await ctx.ui.editor(
      `Edit intent: ${active.title}`,
      current,
    );
    if (!updated || updated === current) return;
    saveIntentContent(ctx.cwd, active.id, updated);
    active.updatedAt = Date.now();
    persist(ctx.cwd);
    pi.events.emit("intent:updated", { id: active.id });
    ctx.ui.notify("Intent updated", "info");
  }

  async function handleLock(ctx: ExtensionCommandContext): Promise<void> {
    const active = getActiveIntent(store);
    if (!active || active.phase !== "defining") return;

    const content = loadIntentContent(ctx.cwd, active.id);
    const result = validateIntentForLock(content);
    if (!result.valid) {
      ctx.ui.notify(
        `Cannot lock — missing: ${result.missing.join(", ")}`,
        "warning",
      );
      return;
    }

    const from: IntentPhase = active.phase;
    transitionPhase(store, active.id, "implementing");
    persist(ctx.cwd);
    pi.events.emit("intent:phase-changed", {
      id: active.id,
      from,
      to: "implementing",
    });
    ctx.ui.notify(`Intent locked: "${active.title}"`, "info");
  }

  async function handleSwitch(ctx: ExtensionCommandContext): Promise<void> {
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
    persist(ctx.cwd);
    pi.events.emit("intent:active-changed", { id: intent.id });
  }

  async function handleDelete(ctx: ExtensionCommandContext): Promise<void> {
    const active = getActiveIntent(store);
    if (!active) return;
    const confirmed = await ctx.ui.confirm(
      "Delete intent",
      `Delete "${active.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      deleteIntent(store, ctx.cwd, active.id);
    } catch (err) {
      ctx.ui.notify((err as Error).message, "warning");
      return;
    }
    persist(ctx.cwd);
    pi.events.emit("intent:deleted", { id: active.id });
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function shortDesc(content: string): string | null {
  const first = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return first ?? null;
}
