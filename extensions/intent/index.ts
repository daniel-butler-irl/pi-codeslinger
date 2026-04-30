// extensions/intent/index.ts
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
// TODO: Migrate to 'typebox' once TypeScript types are fully compatible
// Currently using @sinclair/typebox with Pi 0.69.0's compatibility shims
import { Type } from "@sinclair/typebox";
import { visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { resolve, normalize, join } from "path";
import { rmSync, existsSync } from "node:fs";
import { decideTransitionToImplementing } from "./transition-gate.js";
import { validateIntentForLock } from "./validate.js";
import {
  createWorktree,
  worktreePath,
  branchName,
  isDirty,
  removeWorktree,
  type CreatedWorktree,
} from "./worktree-manager.js";
import { squashMergeWorktree, mergeStatus } from "./done-flow.js";
import { mainRepoRoot, mainIntentsJsonPath } from "./paths.js";
import {
  loadStore,
  saveStore,
  createIntent,
  deleteIntent,
  getActiveIntent,
  filterIntents,
  loadIntentContent,
  saveIntentContent,
  intentContractPath,
  transitionPhase,
  readUnderstanding,
  writeUnderstanding,
  intentUnderstandingPath,
  readLog,
  readVerification,
  readReviewResult,
  type IntentStore,
  type IntentPhase,
  type Intent,
} from "./store.js";
import { readActiveIntent, writeActiveIntent } from "./active-local.js";
import { createIntentSidebar } from "./panel.js";
import { IntentOverlayComponent, type OverlayAction } from "./overlay.js";
import { AgentOverlayComponent } from "../orchestrator/agent-overlay.js";
import { getDriver } from "../orchestrator/index.js";
import type { AgentRole } from "../orchestrator/state.js";
import { generateFallbackTitle } from "./title-generator.js";

/**
 * Wraps a child Component so it renders at a limited width but pads its
 * lines out to the full TUI width. Used to squeeze the native chat UI
 * over to the left when we paint the intent sidebar on the right.
 */
class WidthLimiter implements Component {
  private readonly inner: Component;
  private readonly getWidth: () => number;

  constructor(inner: Component, getWidth: () => number) {
    this.inner = inner;
    this.getWidth = getWidth;
  }

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
  let store: IntentStore = { intents: [] };
  let panel: ReturnType<typeof createIntentSidebar> | null = null;
  let tuiRef: TUI | null = null;
  let cwdRef: string = process.cwd();
  let sessionCtx: ExtensionContext | null = null;

  // Track last injection to determine when re-injection is needed
  interface InjectionState {
    intentId: string;
    phase: IntentPhase;
    contractUpdatedAt: number;
    understandingMtime: number | null;
  }
  let lastInjection: InjectionState | null = null;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function refreshPanel(): void {
    const active = getActiveIntent(store, cwdRef);
    const desc = active
      ? shortDesc(loadIntentContent(cwdRef, active.id))
      : null;
    const understanding = active ? readUnderstanding(cwdRef, active.id) : null;
    const reviewResult = active ? readReviewResult(cwdRef, active.id) : null;
    panel?.update(
      store,
      desc,
      active?.phase ?? null,
      understanding,
      reviewResult,
      cwdRef,
    );
  }

  function reloadStoreFromDisk(): void {
    store = loadStore(cwdRef);
    refreshPanel();
  }

  async function persist(cwd: string): Promise<void> {
    await saveStore(cwd, store);
    refreshPanel();
  }

  /**
   * Inject or re-inject the active intent contract and understanding into
   * the AI assistant context. Uses display: false to keep the UI clean.
   *
   * Note: When sessions are restored from disk, old intent-context messages
   * from previous active intents may appear in the context view. This is
   * cosmetic only - the LLM receives the latest context via deliverAs: nextTurn.
   * The customType includes the intent ID to distinguish between intents.
   */
  function injectIntentContext(): void {
    const active = getActiveIntent(store, cwdRef);
    if (!active) {
      lastInjection = null;
      return;
    }

    const contract = loadIntentContent(cwdRef, active.id);
    const understanding = readUnderstanding(cwdRef, active.id);
    const reviewResult = readReviewResult(cwdRef, active.id);

    // Build metadata section
    const metadata = [
      `**Intent ID:** ${active.id}`,
      `**Title:** ${active.title}`,
      `**Phase:** ${active.phase}`,
      `**Rework Count:** ${active.reworkCount}`,
      `**Last Updated:** ${new Date(active.updatedAt).toISOString()}`,
    ].join("\n");

    // Build the full context message
    const parts: string[] = [
      "# Active Intent Context",
      "",
      metadata,
      "",
      "## Intent Contract",
      "",
      contract || "(Contract is empty)",
    ];

    if (understanding) {
      parts.push("", "## Current Understanding", "", understanding);
    }

    if (reviewResult) {
      const verdict =
        reviewResult.verdict === "pass" ? "PASSED" : "REWORK NEEDED";
      parts.push("", `## Review Result (${verdict})`, "", reviewResult.summary);
      if (reviewResult.verdict === "rework" && reviewResult.findings?.length) {
        parts.push(
          "",
          "**Findings to address:**",
          ...reviewResult.findings.map((f) => `- ${f}`),
        );
      }
      if (
        reviewResult.verdict === "rework" &&
        reviewResult.nextActions?.length
      ) {
        parts.push(
          "",
          "**Suggested next actions:**",
          ...reviewResult.nextActions.map((a) => `- ${a}`),
        );
      }
    }

    const content = parts.join("\n");

    // Inject the message into the conversation
    // Include intent ID in customType to distinguish between different intents
    pi.sendMessage(
      {
        customType: `intent-context-${active.id}`,
        content,
        display: false,
      },
      { deliverAs: "nextTurn", triggerTurn: false },
    );

    // Track this injection
    const understandingPath = intentUnderstandingPath(cwdRef, active.id);
    let understandingMtime: number | null = null;
    try {
      const { existsSync, statSync } = require("fs");
      if (existsSync(understandingPath)) {
        understandingMtime = statSync(understandingPath).mtimeMs;
      }
    } catch {
      // File doesn't exist or can't be read
    }

    lastInjection = {
      intentId: active.id,
      phase: active.phase,
      contractUpdatedAt: active.updatedAt,
      understandingMtime,
    };
  }

  /**
   * Check if the intent context needs to be re-injected based on:
   * - Intent changed
   * - Phase changed
   * - Contract updated
   * - Understanding file modified
   */
  function needsReinjection(): boolean {
    const active = getActiveIntent(store, cwdRef);
    if (!active) {
      return false;
    }

    // No previous injection - needs injection
    if (!lastInjection) {
      return true;
    }

    // Intent changed
    if (lastInjection.intentId !== active.id) {
      return true;
    }

    // Phase changed
    if (lastInjection.phase !== active.phase) {
      return true;
    }

    // Contract updated
    if (lastInjection.contractUpdatedAt !== active.updatedAt) {
      return true;
    }

    // Understanding file modified
    try {
      const { existsSync, statSync } = require("fs");
      const understandingPath = intentUnderstandingPath(cwdRef, active.id);
      const currentMtime = existsSync(understandingPath)
        ? statSync(understandingPath).mtimeMs
        : null;
      if (currentMtime !== lastInjection.understandingMtime) {
        return true;
      }
    } catch {
      // If we can't check, err on the side of not re-injecting
    }

    return false;
  }

  // ── Lifecycle: mount the sidebar ────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    store = loadStore(ctx.cwd);
    cwdRef = ctx.cwd;
    sessionCtx = ctx;

    // Emit event if there's an active intent so the agent knows to load understanding
    const active = getActiveIntent(store, ctx.cwd);
    if (active) {
      pi.events.emit("intent:active-on-start", {
        id: active.id,
        title: active.title,
        phase: active.phase,
        contractPath: intentContractPath(ctx.cwd, active.id),
        understandingPath: intentUnderstandingPath(ctx.cwd, active.id),
      });

      // Auto-inject intent context on session start
      injectIntentContext();

      // For agent-driven phases, show a visible "new session" indicator so
      // the user can see the context has been cleared and a fresh run is starting.
      // Then auto-dispatch so the agent picks up exactly where it left off.
      if (active.phase === "implementing" || active.phase === "reviewing") {
        const phaseLabel =
          active.phase === "implementing"
            ? `implementing${active.reworkCount > 0 ? ` (rework #${active.reworkCount})` : ""}`
            : "reviewing";
        pi.sendMessage(
          {
            customType: "session-start-notice",
            content: `Fresh session — ${phaseLabel}: "${active.title}"`,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );

        setImmediate(() => {
          pi.events.emit("intent:phase-changed", {
            id: active.id,
            from: active.phase,
            to: active.phase,
          });
        });
      }
    }

    ctx.ui.custom(
      (tui, theme) => {
        tuiRef = tui;

        const sidebarWidth = () =>
          Math.min(40, Math.max(24, Math.floor(tui.terminal.columns * 0.25)));

        panel = createIntentSidebar(store, tui, theme, cwdRef);
        refreshPanel();

        panel.setOnSelectAgent((intentId, role) => {
          void showAgentOverlay(intentId, role, tui, theme);
        });

        const stored = (tui as any).__intentOriginalChildren as
          | Component[]
          | undefined;
        if (stored) {
          for (let i = 0; i < stored.length; i++) {
            tui.children[i] = stored[i];
          }
          tui.children.length = stored.length;
        }
        (tui as any).__intentOriginalChildren = [...tui.children];

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

  // ── Context injection and re-injection ─────────────────────────────────────
  //
  // Inject intent context at session start (already done in session_start).
  // Re-inject before agent starts if changes detected.
  // Also handle dynamic refresh based on message distance.

  pi.on("before_agent_start", () => {
    if (needsReinjection()) {
      injectIntentContext();
    }
  });

  // Monitor context to check if re-injection needed based on message distance
  pi.on("context", (event) => {
    // Count messages since last injection by looking for our custom type
    // in the last 20 messages
    const messages = event.messages;
    const last20 = messages.slice(-20);

    // Check if our intent-context message is in the last 20
    const hasRecentContext = last20.some(
      (m: any) => m.role === "custom" && m.customType === "intent-context",
    );

    // If not in last 20 and we have an active intent, mark that we need reinjection
    // The before_agent_start hook will handle the actual injection
    if (!hasRecentContext && getActiveIntent(store, cwdRef)) {
      // Force re-injection by clearing the lastInjection state
      // This will make needsReinjection() return true
      lastInjection = null;
    }
  });

  // ── Dynamic refresh on events ───────────────────────────────────────────────
  //
  // Listen for events that should trigger re-injection or refresh the sidebar.

  function syncIntentStateFromEvents(): void {
    reloadStoreFromDisk();
    injectIntentContext();
  }

  pi.events.on("intent:phase-changed", () => {
    syncIntentStateFromEvents();
  });

  pi.events.on("intent:updated", () => {
    syncIntentStateFromEvents();
  });

  pi.events.on("intent:active-changed", () => {
    syncIntentStateFromEvents();
  });

  pi.events.on("intent:created", () => {
    syncIntentStateFromEvents();
  });

  pi.events.on("intent:deleted", () => {
    syncIntentStateFromEvents();
  });

  pi.events.on("orchestrator:reviewer-status", (payload: unknown) => {
    const { message } = payload as { intentId: string; message: string };
    panel?.updateStatus(message);
  });

  pi.events.on("orchestrator:agents-changed", (payload: unknown) => {
    const { agents } = payload as {
      agents: Array<{
        intentId: string;
        intentTitle: string;
        role: AgentRole;
        status: string;
      }>;
    };
    panel?.updateAgents(agents);
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

  // ── Agent overlay handler ──────────────────────────────────────────────────

  async function showAgentOverlay(
    intentId: string,
    role: AgentRole,
    tui: import("@mariozechner/pi-tui").TUI,
    theme: import("@mariozechner/pi-coding-agent").Theme,
  ): Promise<void> {
    const driver = getDriver(cwdRef);
    if (!driver) return;
    const handle = driver.getAgentHandle(intentId, role);
    if (!handle) return;

    const store2 = loadStore(cwdRef);
    const intent = store2.intents.find((i) => i.id === intentId);
    const intentTitle = intent?.title ?? intentId;

    if (!sessionCtx) return;
    await sessionCtx.ui.custom<void>(
      (_t, _theme, _kb, done) =>
        new AgentOverlayComponent(tui, theme, handle, intentTitle, () =>
          done(undefined),
        ),
      { overlay: true },
    );
  }

  // ── Intent overlay handler ─────────────────────────────────────────────────

  async function showIntentOverlay(
    ctx: ExtensionCommandContext | ExtensionContext,
  ): Promise<void> {
    const result = await ctx.ui.custom<OverlayAction>(
      (_tui, theme, _kb, done) =>
        new IntentOverlayComponent(store, theme, done, ctx.cwd),
      { overlay: true },
    );

    if (!result || result.type === "cancel") {
      return;
    }

    if (result.type === "create") {
      // Create the intent (does NOT auto-activate in new API)
      const intent = createIntent(store, ctx.cwd, result.description);

      // Use the title from overlay if provided, otherwise generate fallback
      const title = result.title || generateFallbackTitle(result.description);
      intent.title = title;

      // Active intent is not changed — createIntent no longer auto-activates.

      await persist(ctx.cwd);
      pi.events.emit("intent:created", { id: intent.id });
      ctx.ui.notify(
        `Intent created: "${intent.title}" (not activated)`,
        "info",
      );
    } else if (result.type === "switch") {
      const intent = store.intents.find((i) => i.id === result.intentId);
      if (!intent) return;

      // Switch intent
      writeActiveIntent(ctx.cwd, intent.id);
      await persist(ctx.cwd);
      pi.events.emit("intent:active-changed", { id: intent.id });

      ctx.ui.notify(`Switching to: ${intent.title}`, "info");

      // Start a fresh session with the new intent active (if we have command context)
      // Note: No post-switch work needed - function returns immediately after.
      // If we needed to do work after the switch, we'd use withSession callback.
      if ("newSession" in ctx) {
        await ctx.newSession();
      }
    } else if (result.type === "edit") {
      await handleEdit(ctx, result.intentId);
      refreshPanel();
    } else if (result.type === "lock") {
      await handleLock(ctx, result.intentId);
      refreshPanel();
    } else if (result.type === "transition") {
      await handleTransition(ctx, result.intentId, result.toPhase);
      refreshPanel();
    } else if (result.type === "review") {
      await handleReview(ctx, result.intentId);
      refreshPanel();
    } else if (result.type === "delete") {
      await handleDelete(ctx, result.intentId);
      refreshPanel();
    }

    refreshPanel();
  }

  // ── Hotkey registration ─────────────────────────────────────────────────

  pi.registerShortcut("ctrl+i", {
    description: "Open intent management overlay",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showIntentOverlay(ctx);
    },
  });

  // ── /intent command ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "update_understanding",
    label: "Update Understanding",
    description:
      "Update the session's understanding of the current intent problem. " +
      "This should capture: 1) current problem understanding, 2) key discoveries, " +
      "3) next steps needed, 4) open questions. This persists across sessions.",
    parameters: Type.Object({
      understanding: Type.String({
        description:
          "Markdown-formatted summary of current problem understanding, " +
          "next steps, and open questions. Should be concise but informative.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active intent. Create or switch to an intent first.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      writeUnderstanding(cwdRef, active.id, params.understanding);
      refreshPanel();

      // Trigger re-injection since understanding changed
      injectIntentContext();

      return {
        content: [
          {
            type: "text" as const,
            text: "Understanding updated and will persist across sessions.",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "read_intent",
    label: "Read Intent",
    description:
      "Read the contract for the active intent. Returns the full content " +
      "of the intent.md file (Description, Success Criteria, and Verification sections).",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active intent. Create or switch to an intent first.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const content = loadIntentContent(cwdRef, active.id);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Intent contract file is empty)",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "list_intents",
    label: "List Intents",
    description:
      "List all intents in the project with their metadata (id, title, phase, " +
      "parent relationship). Useful for understanding the intent tree structure, " +
      "finding related work, or checking status.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("active"),
            Type.Literal("done"),
            Type.Literal("children"),
          ],
          {
            description:
              'Filter: "all" (default), "active" (current intent only), ' +
              '"done" (completed intents), "children" (children of current intent)',
          },
        ),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const filter = params.filter ?? "all";
      const intents = filterIntents(store, filter, cwdRef);
      const currentActiveId = readActiveIntent(cwdRef);

      if (intents.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No intents found matching the filter.",
            },
          ],
          isError: false,
          details: undefined,
        };
      }

      const lines = intents.map((intent) => {
        const active = intent.id === currentActiveId ? " [ACTIVE]" : "";
        const parent = intent.parentId ? ` (child of ${intent.parentId})` : "";
        return (
          `- ${intent.title}${active}\n` +
          `  ID: ${intent.id}\n` +
          `  Phase: ${intent.phase}\n` +
          `  Rework count: ${intent.reworkCount}${parent}`
        );
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${intents.length} intent(s):\n\n${lines.join("\n\n")}`,
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "read_intent_log",
    label: "Read Intent Log",
    description:
      "Read the append-only log for the active intent. The log contains " +
      "discoveries, decisions, verification results, review findings, and " +
      "other timestamped events from the intent's lifecycle.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active intent. Create or switch to an intent first.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const content = readLog(cwdRef, active.id);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Log is empty)",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "read_intent_understanding",
    label: "Read Intent Understanding",
    description:
      "Read the understanding file for the active intent. This contains " +
      "the session's current problem understanding, key discoveries, next " +
      "steps needed, and open questions.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active intent. Create or switch to an intent first.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const content = readUnderstanding(cwdRef, active.id);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Understanding file is empty)",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "read_verification_results",
    label: "Read Verification Results",
    description:
      "Read the cached verification results for the active intent. Shows " +
      "which commands passed or failed in the most recent verification run, " +
      "with exit codes and output.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active intent. Create or switch to an intent first.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      const result = readVerification(cwdRef, active.id);
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No verification results available yet.",
            },
          ],
          isError: false,
          details: undefined,
        };
      }

      const summary = `Verification ran at: ${result.ranAt}\nOverall: ${
        result.passed ? "PASSED" : "FAILED"
      }\n\n`;
      const commands = result.commands
        .map(
          (cmd) =>
            `Command: ${cmd.command}\n` +
            `Status: ${cmd.passed ? "✓ PASS" : "✗ FAIL"} (exit ${cmd.exitCode})\n` +
            (cmd.output ? `Output:\n${cmd.output}\n` : ""),
        )
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: summary + commands,
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "switch_intent",
    label: "Switch Intent",
    description:
      "Switch the active intent to a different intent by ID. This changes which " +
      "intent's contract, understanding, and tools are active.",
    parameters: Type.Object({
      intentId: Type.String({
        description: "The ID of the intent to switch to",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const intent = store.intents.find((i) => i.id === params.intentId);
      if (!intent) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No intent found with ID: ${params.intentId}`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      writeActiveIntent(cwdRef, intent.id);
      await persist(cwdRef);
      pi.events.emit("intent:active-changed", { id: intent.id });
      return {
        content: [
          {
            type: "text" as const,
            text: `Switched to intent: ${intent.title} (${intent.id})\nPhase: ${intent.phase}`,
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "propose_done",
    label: "Propose Done",
    description:
      "Signal that you believe the current intent is complete. " +
      "Call only after all success criteria are satisfied and verification passes. " +
      "The orchestrator will route your proposal to the reviewer.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Short summary of what was done and why it satisfies the contract.",
      }),
      artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description: "Paths, test names, or other artefacts to inspect.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active || active.phase !== "implementing") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No intent is currently in the implementing phase.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      // Gate: understanding.md must exist, be non-empty, and be no older
      // than the current implementing phase entry. The next session is
      // bootstrapped from intent.md + understanding.md, so the
      // implementer must update understanding before signaling done.
      const understandingPath = intentUnderstandingPath(cwdRef, active.id);
      const phaseEnteredAt = active.phaseEnteredAt ?? active.updatedAt;
      let stale = false;
      let reason = "";
      try {
        const { existsSync, statSync } = await import("fs");
        if (!existsSync(understandingPath)) {
          stale = true;
          reason = "understanding.md does not exist";
        } else {
          const understanding = readUnderstanding(cwdRef, active.id).trim();
          if (!understanding) {
            stale = true;
            reason = "understanding.md is empty";
          } else if (statSync(understandingPath).mtimeMs < phaseEnteredAt) {
            stale = true;
            reason =
              "understanding.md has not been updated this implementing phase";
          }
        }
      } catch (err) {
        stale = true;
        reason = `could not stat understanding.md: ${(err as Error).message}`;
      }
      if (stale) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Cannot propose done: ${reason}. Call update_understanding ` +
                `with the current state of work (what was done, key decisions, ` +
                `what remains) before signalling done. The next session ` +
                `bootstraps from understanding.md.`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      pi.events.emit("orchestrator:proposal-signal", {
        intentId: active.id,
        summary: params.summary,
        artifacts: params.artifacts ?? [],
        proposedAt: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "Proposal submitted. The orchestrator will route it to review.",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "spawn_child_intent",
    label: "Spawn Child Intent",
    description:
      "Request a child intent for a blocking prerequisite. " +
      "The orchestrator will pause the current intent until the child reaches done.",
    parameters: Type.Object({
      description: Type.String({
        description: "Plain-language description of the prerequisite work.",
      }),
      reason: Type.String({
        description:
          "Why this is a prerequisite — what cannot proceed without it.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active || active.phase !== "implementing") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No intent is currently in the implementing phase.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      pi.events.emit("orchestrator:spawn-signal", {
        intentId: active.id,
        description: params.description,
        reason: params.reason,
        requestedAt: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "Child intent requested. The orchestrator will pause this intent until the child is done.",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "ask_orchestrator",
    label: "Ask Orchestrator",
    description:
      "Escalate a question you cannot answer from context. " +
      "In the main session, prefer asking the user directly instead.",
    parameters: Type.Object({
      question: Type.String({ description: "Clear, answerable question." }),
      context: Type.Optional(
        Type.String({
          description: "Background the orchestrator needs to answer.",
        }),
      ),
    }),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      return {
        content: [
          {
            type: "text" as const,
            text: "You are in the main session — the user is here. Ask them directly instead of using this tool.",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "report_review",
    label: "Report Review",
    description:
      "Submit a review verdict for the active intent. " +
      "Call with verdict 'pass' only after actively hunting for problems and finding none. " +
      "Call with 'rework' and concrete findings if any problems were found.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("rework")], {
        description: "'pass' if no problems found, 'rework' if problems exist",
      }),
      summary: Type.String({
        description: "One-paragraph summary of the review",
      }),
      findings: Type.Array(Type.String(), {
        description: "Concrete problems found (empty array for pass)",
      }),
      nextActions: Type.Array(Type.String(), {
        description:
          "Specific actions for the implementer to address each finding",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const active = getActiveIntent(store, cwdRef);
      if (!active || active.phase !== "reviewing") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No intent is currently in the reviewing phase.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }
      pi.events.emit("orchestrator:review-signal", {
        intentId: active.id,
        verdict: params.verdict,
        summary: params.summary,
        findings: params.findings,
        nextActions: params.nextActions,
        reportedAt: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Review verdict "${params.verdict}" submitted.`,
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "report_status",
    label: "Report Status",
    description:
      "Report a one-line status message while reviewing. Shown live in the sidebar.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "Brief status message (one line, e.g. 'Checking test coverage...')",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      panel?.updateStatus(params.message);
      return {
        content: [
          {
            type: "text" as const,
            text: "Status noted.",
          },
        ],
        isError: false,
        details: undefined,
      };
    },
  });

  pi.registerCommand("intent", {
    description: "Manage intents. Subcommands: unlock (clear a stale lock).",
    handler: async (args, ctx) => {
      if (args.trim() === "unlock") {
        const { forceUnlock } = await import("./lock.js");
        const lockPath = mainIntentsJsonPath(ctx.cwd);
        forceUnlock(lockPath);
        ctx.ui.notify(`Cleared lock on ${lockPath}`, "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/intent requires interactive mode", "error");
        return;
      }
      await showIntentOverlay(ctx);
      refreshPanel();
    },
  });

  // ── Command handlers ────────────────────────────────────────────────────

  async function gateAndCreateWorktree(
    ctx: ExtensionCommandContext | ExtensionContext,
    intent: Intent,
  ): Promise<CreatedWorktree | null> {
    // Skip the gate if a worktree already exists (re-entry, rework after review).
    if (intent.worktreePath && intent.worktreeBranch) {
      if (existsSync(intent.worktreePath)) {
        return { path: intent.worktreePath, branch: intent.worktreeBranch };
      }
      // Worktree was deleted out-of-band — clear stale state and fall through to re-create.
      intent.worktreePath = undefined;
      intent.worktreeBranch = undefined;
    }

    const proposedPath = worktreePath(
      mainRepoRoot(ctx.cwd),
      intent.title,
      intent.id,
    );
    const proposedBranch = branchName(intent.title, intent.id);

    // Recovery: if a worktree was previously created but persist failed
    // (so we have no record), adopt it without re-prompting.
    if (existsSync(proposedPath)) {
      intent.worktreePath = proposedPath;
      intent.worktreeBranch = proposedBranch;
      return { path: proposedPath, branch: proposedBranch };
    }

    const decision = await decideTransitionToImplementing({
      confirm: () =>
        ctx.ui.confirm(
          "Ready to start implementation?",
          `This will create a worktree at ${proposedPath} on branch ${proposedBranch} and start the implementer.`,
        ),
    });
    if (decision === "cancel") {
      ctx.ui.notify("Implementation not started.", "info");
      return null;
    }
    try {
      const created = createWorktree(ctx.cwd, intent.title, intent.id);
      intent.worktreeBranch = created.branch;
      intent.worktreePath = created.path;
      return created;
    } catch (err) {
      ctx.ui.notify(
        `Worktree creation failed: ${(err as Error).message}`,
        "warning",
      );
      return null;
    }
  }

  async function handleEdit(
    ctx: ExtensionCommandContext | ExtensionContext,
    intentId?: string,
  ): Promise<void> {
    const intent = intentId
      ? store.intents.find((i) => i.id === intentId)
      : getActiveIntent(store, ctx.cwd);
    if (!intent) return;
    if (intent.phase !== "defining") {
      ctx.ui.notify(
        `Intent is locked (${intent.phase}). Cannot edit outside defining phase.`,
        "warning",
      );
      return;
    }
    const current = loadIntentContent(ctx.cwd, intent.id);
    const updated = await ctx.ui.editor(
      `Edit intent: ${intent.title}`,
      current,
    );
    if (!updated || updated === current) return;
    saveIntentContent(ctx.cwd, intent.id, updated);
    intent.updatedAt = Date.now();
    await persist(ctx.cwd);
    pi.events.emit("intent:updated", { id: intent.id });
    ctx.ui.notify("Intent updated", "info");
  }

  async function handleLock(
    ctx: ExtensionCommandContext | ExtensionContext,
    intentId?: string,
  ): Promise<void> {
    const intent = intentId
      ? store.intents.find((i) => i.id === intentId)
      : getActiveIntent(store, ctx.cwd);
    if (!intent || intent.phase !== "defining") return;

    const content = loadIntentContent(ctx.cwd, intent.id);
    const result = validateIntentForLock(content);
    if (!result.valid) {
      ctx.ui.notify(
        `Cannot lock — missing: ${result.missing.join(", ")}`,
        "warning",
      );
      return;
    }

    const created = await gateAndCreateWorktree(ctx, intent);
    if (!created) return; // user declined or worktree creation failed

    const from: IntentPhase = intent.phase;
    const isActiveIntent = readActiveIntent(ctx.cwd) === intent.id;

    try {
      transitionPhase(store, intent.id, "implementing");
      await persist(ctx.cwd);
      pi.events.emit("intent:phase-changed", {
        id: intent.id,
        from,
        to: "implementing",
      });
      ctx.ui.notify(`Worktree created: ${created.path}`, "info");

      if (isActiveIntent && "newSession" in ctx) {
        // pi-coding-agent's newSession() does not accept a cwd option, so we
        // change the process cwd before starting the fresh session. The new
        // session_start handler will pick up ctx.cwd from the new process cwd.
        process.chdir(created.path);
        await ctx.newSession();
      } else if (!isActiveIntent) {
        writeActiveIntent(ctx.cwd, intent.id);
        pi.events.emit("intent:active-changed", { id: intent.id });
        if ("newSession" in ctx) {
          process.chdir(created.path);
          await ctx.newSession();
        } else {
          ctx.ui.notify(
            `Intent "${intent.title}" is now active. Switch to it manually to start a fresh session.`,
            "info",
          );
        }
      }
    } catch (err) {
      ctx.ui.notify((err as Error).message, "warning");
    }
  }

  async function handleDoneTransition(
    ctx: ExtensionCommandContext | ExtensionContext,
    intent: Intent,
  ): Promise<"done" | "blocked"> {
    // For child intents, enforce that understanding.md is current at done.
    // The parent's resume prompt embeds the child's understanding.md as
    // its summary; an empty/stale file leaves the parent without context.
    if (intent.parentId) {
      const understandingPath = intentUnderstandingPath(ctx.cwd, intent.id);
      const phaseEnteredAt = intent.phaseEnteredAt ?? intent.updatedAt;
      const { existsSync, statSync } = await import("fs");
      let stale = false;
      let reason = "";
      if (!existsSync(understandingPath)) {
        stale = true;
        reason = "understanding.md does not exist";
      } else {
        const understanding = readUnderstanding(ctx.cwd, intent.id).trim();
        if (!understanding) {
          stale = true;
          reason = "understanding.md is empty";
        } else if (statSync(understandingPath).mtimeMs < phaseEnteredAt) {
          stale = true;
          reason =
            "understanding.md has not been updated since the latest implementing phase";
        }
      }
      if (stale) {
        ctx.ui.notify(
          `Cannot mark child intent done: ${reason}. The parent's resume prompt embeds this file. Call update_understanding with a summary of what the child accomplished.`,
          "warning",
        );
        return "blocked";
      }
    }

    if (intent.worktreePath && intent.worktreeBranch) {
      if (isDirty(intent.worktreePath)) {
        ctx.ui.notify(
          `Cannot mark done: worktree has uncommitted changes at ${intent.worktreePath}. Commit or stash first.`,
          "warning",
        );
        return "blocked";
      }
      const result = squashMergeWorktree(
        ctx.cwd,
        intent.worktreeBranch,
        `feat(${intent.id.slice(0, 8)}): ${intent.title}`,
      );
      if (result.kind !== "merged") {
        ctx.ui.notify(mergeStatus(result), "warning");
        return "blocked";
      }
      ctx.ui.notify(mergeStatus(result), "info");

      const remove = await ctx.ui.confirm(
        "Delete worktree?",
        `Worktree at ${intent.worktreePath} (branch ${intent.worktreeBranch}) is no longer needed. Delete it?`,
      );
      if (remove) {
        if (
          ctx.cwd === intent.worktreePath ||
          ctx.cwd.startsWith(intent.worktreePath + "/")
        ) {
          ctx.ui.notify(
            `Note: current shell is inside the worktree. cd to main repo manually after deletion.`,
            "info",
          );
        }
        removeWorktree(ctx.cwd, intent.worktreePath, intent.worktreeBranch);
        intent.worktreePath = undefined;
        intent.worktreeBranch = undefined;
        ctx.ui.notify("Worktree deleted.", "info");
      }
    }
    return "done";
  }

  async function handleTransition(
    ctx: ExtensionCommandContext | ExtensionContext,
    intentId: string,
    toPhase: IntentPhase,
  ): Promise<void> {
    const intent = store.intents.find((i) => i.id === intentId);
    if (!intent) return;

    const from: IntentPhase = intent.phase;
    const isActiveIntent = readActiveIntent(ctx.cwd) === intentId;

    try {
      if (toPhase === "done") {
        const outcome = await handleDoneTransition(ctx, intent);
        if (outcome === "blocked") return;
        transitionPhase(store, intentId, toPhase);
        await persist(ctx.cwd);
        pi.events.emit("intent:phase-changed", {
          id: intentId,
          from,
          to: toPhase,
        });
        ctx.ui.notify(`Intent "${intent.title}" moved to ${toPhase}`, "info");
        return;
      } else if (toPhase === "implementing") {
        const created = await gateAndCreateWorktree(ctx, intent);
        if (!created) return;
        transitionPhase(store, intentId, toPhase);
        await persist(ctx.cwd);
        pi.events.emit("intent:phase-changed", {
          id: intentId,
          from,
          to: toPhase,
        });
        ctx.ui.notify(`Intent "${intent.title}" moved to ${toPhase}`, "info");
        if (isActiveIntent && "newSession" in ctx) {
          // pi-coding-agent's newSession() does not accept a cwd option, so we
          // change the process cwd before starting the fresh session. The new
          // session_start handler will pick up ctx.cwd from the new process cwd.
          process.chdir(created.path);
          await ctx.newSession();
        } else if (!isActiveIntent) {
          writeActiveIntent(ctx.cwd, intentId);
          pi.events.emit("intent:active-changed", { id: intentId });
          if ("newSession" in ctx) {
            process.chdir(created.path);
            await ctx.newSession();
          } else {
            ctx.ui.notify(
              `Intent "${intent.title}" is now active. Switch to it manually to start a fresh session.`,
              "info",
            );
          }
        }
      } else {
        transitionPhase(store, intentId, toPhase);
        await persist(ctx.cwd);
        pi.events.emit("intent:phase-changed", {
          id: intentId,
          from,
          to: toPhase,
        });
        ctx.ui.notify(`Intent "${intent.title}" moved to ${toPhase}`, "info");
      }
    } catch (err) {
      ctx.ui.notify((err as Error).message, "warning");
    }
  }

  async function handleReview(
    ctx: ExtensionCommandContext | ExtensionContext,
    intentId: string,
  ): Promise<void> {
    const intent = store.intents.find((i) => i.id === intentId);
    if (!intent) return;

    if (intent.phase !== "reviewing") {
      ctx.ui.notify(
        `Cannot review: intent is in ${intent.phase} phase`,
        "warning",
      );
      return;
    }

    if (readActiveIntent(ctx.cwd) !== intentId) {
      writeActiveIntent(ctx.cwd, intentId);
      await persist(ctx.cwd);
      pi.events.emit("intent:active-changed", { id: intentId });
    }

    ctx.ui.notify(`Starting review for "${intent.title}"...`, "info");

    // Re-emit the reviewing phase event so the orchestrator dispatches the reviewer agent.
    // This works from both shortcut (ExtensionContext) and command (ExtensionCommandContext)
    // contexts because it uses the event bus, not newSession().
    pi.events.emit("intent:phase-changed", {
      id: intentId,
      from: "reviewing",
      to: "reviewing",
    });
  }

  async function handleDelete(
    ctx: ExtensionCommandContext | ExtensionContext,
    intentId?: string,
  ): Promise<void> {
    const intent = intentId
      ? store.intents.find((i) => i.id === intentId)
      : getActiveIntent(store, ctx.cwd);
    if (!intent) return;
    const confirmed = await ctx.ui.confirm(
      "Delete intent",
      `Delete "${intent.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      deleteIntent(store, ctx.cwd, intent.id);
    } catch (err) {
      ctx.ui.notify((err as Error).message, "warning");
      return;
    }
    // Clean local audit-trail dir under ctx.cwd.
    rmSync(join(ctx.cwd, ".pi", "intents", intent.id), {
      recursive: true,
      force: true,
    });
    // If the intent has a worktree at a different path, clean that audit dir too.
    if (intent.worktreePath && intent.worktreePath !== ctx.cwd) {
      rmSync(join(intent.worktreePath, ".pi", "intents", intent.id), {
        recursive: true,
        force: true,
      });
    }
    // Then if the worktree exists (i.e., wasn't already deleted via done-flow), remove it.
    if (
      intent.worktreePath &&
      intent.worktreeBranch &&
      existsSync(intent.worktreePath)
    ) {
      removeWorktree(ctx.cwd, intent.worktreePath, intent.worktreeBranch);
    }
    // Clear active state if this was the active intent.
    if (readActiveIntent(ctx.cwd) === intent.id) {
      writeActiveIntent(ctx.cwd, null);
    }
    await persist(ctx.cwd);
    pi.events.emit("intent:deleted", { id: intent.id });
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function shortDesc(content: string): string | null {
  const lines = content.split("\n");
  let inDescription = false;
  const descriptionLines: string[] = [];

  for (const line of lines) {
    if (!inDescription) {
      if (/^##\s+Description\s*$/i.test(line.trim())) {
        inDescription = true;
      }
      continue;
    }

    if (/^##\s+/.test(line)) {
      break;
    }

    descriptionLines.push(line);
  }

  const description = descriptionLines.join("\n").trim();
  if (description) {
    return description;
  }

  const fallbackLines: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed || trimmed.startsWith("#")) continue;
      started = true;
      fallbackLines.push(line);
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) {
      break;
    }

    fallbackLines.push(line);
  }

  const fallback = fallbackLines.join("\n").trim();
  return fallback || null;
}
