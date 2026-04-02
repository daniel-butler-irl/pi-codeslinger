// extensions/intent/index.ts
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  let store: IntentStore = { activeIntentId: null, intents: [] };

  pi.on("session_start", (_event, ctx) => {
    store = loadStore(ctx.cwd);
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
