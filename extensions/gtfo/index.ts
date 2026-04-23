import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// GTFO state
interface GTFOState {
  nextThreshold: number | null;
  disabled: boolean;
  lastHandoverPath: string | null;
  assessmentInProgress: boolean;
  assessmentModel: string | null; // Configurable assessment model
}

let state: GTFOState = {
  nextThreshold: null,
  disabled: false,
  lastHandoverPath: null,
  assessmentInProgress: false,
  assessmentModel: null,
};

// Marker for handover auto-injection from file
const GTFO_HANDOVER_MARKER = "gtfo-handover-injected";
// Marker for ephemeral handover (passed via setup)
const GTFO_SETUP_HANDOVER = "gtfo-setup-handover";

export default function (pi: ExtensionAPI) {
  // ── Session start: restore state & inject setup handover ──────────────
  pi.on("session_start", async (_event, ctx) => {
    // Try to restore state from intent metadata
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "gtfo-state") {
        state = { ...state, ...(entry.data as Partial<GTFOState>) };
        break;
      }
    }

    // Check for setup handover (ephemeral, passed via setup callback)
    const setupHandover = entries.find(
      (e) => e.type === "custom" && e.customType === GTFO_SETUP_HANDOVER,
    ) as any;
    if (setupHandover) {
      const content = (setupHandover.data as any)?.content || "";
      if (content) {
        pi.sendMessage(
          {
            customType: "gtfo-handover",
            content: `# Handover from Previous Session\n\n${content}`,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
      }
      // Don't inject again on subsequent restarts
      return;
    }

    // Check if we should auto-inject handover from file
    if (state.lastHandoverPath && existsSync(state.lastHandoverPath)) {
      // Check if already injected
      const alreadyInjected = entries.some(
        (e) =>
          e.type === "custom" &&
          e.customType === GTFO_HANDOVER_MARKER &&
          (e.data as any)?.path === state.lastHandoverPath,
      );

      if (!alreadyInjected) {
        const handoverContent = readFileSync(state.lastHandoverPath, "utf-8");
        pi.sendMessage(
          {
            customType: "gtfo-handover",
            content: `# Handover from Previous Session\n\n${handoverContent}`,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );

        // Mark as injected
        pi.appendEntry(GTFO_HANDOVER_MARKER, { path: state.lastHandoverPath });

        // Clear the handover path so we don't inject again
        state.lastHandoverPath = null;
        persistState(pi, ctx);
      }
    }
  });

  // ── Token monitoring on turn_end ───────────────────────────────────────
  pi.on("turn_end", async (_event, ctx) => {
    if (state.disabled || state.assessmentInProgress) return;

    const usage = ctx.getContextUsage();
    if (!usage || !usage.tokens || !ctx.model) return;

    const contextWindow = ctx.model.contextWindow;
    const percentUsed = (usage.tokens / contextWindow) * 100;

    // Check if we've reached a threshold
    const baseThreshold = 60;
    const currentThreshold = state.nextThreshold ?? baseThreshold;

    if (percentUsed >= currentThreshold) {
      // Trigger assessment
      state.assessmentInProgress = true;
      persistState(pi, ctx);

      try {
        await runAssessment(pi, ctx, percentUsed);
      } finally {
        state.assessmentInProgress = false;
        persistState(pi, ctx);
      }
    }
  });

  // ── Manual trigger via Alt+G ───────────────────────────────────────────
  pi.registerShortcut("alt+g", {
    description: "Manually trigger GTFO assessment and handover flow",
    handler: async (ctx) => {
      if (state.assessmentInProgress) {
        ctx.ui.notify("GTFO assessment already in progress", "warning");
        return;
      }

      const usage = ctx.getContextUsage();
      const percentUsed =
        usage && usage.tokens && ctx.model
          ? (usage.tokens / ctx.model.contextWindow) * 100
          : 0;

      state.assessmentInProgress = true;
      persistState(pi, ctx);

      try {
        await runAssessment(pi, ctx, percentUsed, true);
      } finally {
        state.assessmentInProgress = false;
        persistState(pi, ctx);
      }
    },
  });

  // ── Command to re-enable GTFO ──────────────────────────────────────────
  pi.registerCommand("gtfo:enable", {
    description: "Re-enable GTFO monitoring after it was disabled",
    handler: async (_args, ctx) => {
      state.disabled = false;
      persistState(pi, ctx);
      ctx.ui.notify("GTFO monitoring re-enabled", "info");
    },
  });

  // ── Command to configure assessment model ──────────────────────────────
  pi.registerCommand("gtfo:model", {
    description: "Configure which model to use for task completion assessment",
    handler: async (args, ctx) => {
      const modelId = args.trim();
      if (!modelId) {
        const current =
          state.assessmentModel || "(using current session model)";
        ctx.ui.notify(`Current assessment model: ${current}`, "info");
        return;
      }

      // Validate model exists
      const model = ctx.modelRegistry.find("*", modelId);
      if (!model) {
        ctx.ui.notify(`Model not found: ${modelId}`, "error");
        return;
      }

      state.assessmentModel = modelId;
      persistState(pi, ctx);
      ctx.ui.notify(`Assessment model set to: ${modelId}`, "info");
    },
  });

  // ── Listen for intent changes to reset disabled flag ──────────────────
  pi.events.on("intent:active-changed", () => {
    // Reset disabled flag when switching to a different intent
    state.disabled = false;
  });

  pi.events.on("intent:created", () => {
    // Reset disabled flag when creating a new intent
    state.disabled = false;
  });

  // ── Assessment logic ───────────────────────────────────────────────────
  async function runAssessment(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    percentUsed: number,
    isManual: boolean = false,
  ): Promise<void> {
    if (!ctx.hasUI) return;

    // Get intent context if available
    const entries = ctx.sessionManager.getEntries();
    let intentContract = "";

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "intent-context") {
        intentContract = (entry.data as any)?.content || "";
        break;
      }
    }

    // Build assessment context (full messages minus tool calls)
    const messages = ctx.sessionManager
      .getBranch()
      .map((entry) => {
        if (entry.type === "message" && entry.message.role !== "toolResult") {
          const msg = entry.message;
          if (msg.role === "assistant") {
            // Strip tool calls, keep text only
            const content = Array.isArray(msg.content) ? msg.content : [];
            return {
              role: "assistant",
              content: content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n"),
            };
          } else if (msg.role === "user") {
            const content = Array.isArray(msg.content) ? msg.content : [];
            return {
              role: "user",
              content: content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n"),
            };
          }
        }
        return null;
      })
      .filter((m) => m !== null);

    // Create isolated assessment session
    const assessmentPrompt = `You are assessing whether a user is close to finishing their current task.

${intentContract ? `\n## Current Intent\n\n${intentContract}\n` : ""}

## Conversation History

${JSON.stringify(messages, null, 2)}

## Assessment Question

Is the user close to finishing their current task?

Answer with one of: YES, NO, or MAYBE

Then provide a brief reason (1-2 sentences) explaining your assessment.

Format your response as:
VERDICT: [YES|NO|MAYBE]
REASON: [your reasoning]`;

    try {
      // Use configured model or default to current model
      const assessmentModel = state.assessmentModel
        ? ctx.modelRegistry.find("*", state.assessmentModel) || ctx.model
        : ctx.model;

      const { session } = await createAgentSession({
        model: assessmentModel,
      });

      await session.prompt(assessmentPrompt);

      // Get the last assistant message
      const sessionMessages = session.state.messages;
      const lastAssistant = sessionMessages
        .reverse()
        .find((m: any) => m.role === "assistant");
      let text = "";
      if (lastAssistant && "content" in lastAssistant) {
        const content = (lastAssistant as any).content;
        text = content?.[0]?.text || "";
      }

      // Parse response
      const verdictMatch = text.match(/VERDICT:\s*(YES|NO|MAYBE)/i);
      const reasonMatch = text.match(/REASON:\s*(.+)/is);

      const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "MAYBE";
      const reason = reasonMatch
        ? reasonMatch[1].trim()
        : "Could not determine task status.";

      // Handle verdict
      if (verdict === "YES") {
        // YES flow: notification only
        ctx.ui.notify(
          "Task nearly complete. Recommend finishing in current session.",
          "info",
        );
        ctx.ui.setStatus(
          "gtfo",
          `[GTFO: ${Math.round(percentUsed)}% - Finishing]`,
        );
        ctx.ui.setWidget("gtfo", [
          `GTFO Assessment (${Math.round(percentUsed)}% context used)`,
          "",
          `Status: Task nearly complete`,
          `Reason: ${reason}`,
          "",
          "Recommendation: Complete your work in this session.",
        ]);

        // Set next threshold
        state.nextThreshold = Math.ceil(percentUsed / 10) * 10 + 10;
        persistState(pi, ctx);
      } else {
        // NO/MAYBE flow: use dialog with checkbox-like behavior
        const action = await (ctx as any).ui.select?.(
          `Context at ${Math.round(percentUsed)}%. Assessment: ${reason}\n\nWhat would you like to do?`,
          [
            "Create handover and switch to new session",
            "Continue in current session",
          ],
        );

        if (!action) {
          ctx.ui.notify("GTFO assessment cancelled", "info");
          return;
        }

        const disableChoice = await (ctx as any).ui.confirm?.(
          "Disable GTFO?",
          "Disable GTFO for this session?",
        );

        if (disableChoice) {
          state.disabled = true;
          persistState(pi, ctx);
          ctx.ui.notify(
            "GTFO disabled for this session. Use /gtfo:enable to re-enable.",
            "info",
          );
        }

        if (action === "Create handover and switch to new session") {
          await createHandoverAndSwitch(
            pi,
            ctx as ExtensionCommandContext,
            reason,
          );
        } else {
          // Continue - set next threshold
          state.nextThreshold = Math.ceil(percentUsed / 10) * 10 + 10;
          persistState(pi, ctx);
          ctx.ui.notify("Continuing in current session", "info");
        }
      }
    } catch (error) {
      ctx.ui.notify(
        `GTFO assessment failed: ${(error as Error).message}`,
        "error",
      );
    }
  }

  // ── Handover creation and session switch ───────────────────────────────
  async function createHandoverAndSwitch(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    assessmentReason: string,
  ): Promise<void> {
    // Generate handover content
    const handoverContent = await generateHandover(ctx, assessmentReason);

    // Determine handover path
    let handoverPath: string | null = null;
    const activeIntent = getActiveIntentId(ctx);

    if (activeIntent) {
      // Save to intent directory
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .split("T")
        .join("-")
        .slice(0, -5);
      handoverPath = join(
        ctx.cwd,
        ".pi",
        "intents",
        activeIntent,
        `handover-${timestamp}.md`,
      );
      writeFileSync(handoverPath, handoverContent, "utf-8");
      ctx.ui.notify(`Handover saved to: ${handoverPath}`, "info");
    }

    // Store previous state for rollback
    const previousHandoverPath = state.lastHandoverPath;
    state.lastHandoverPath = handoverPath;
    persistState(pi, ctx);

    try {
      // Create new session with handover
      const result = await ctx.newSession({
        setup: async (sm) => {
          if (handoverPath) {
            // Intent active: handover saved to file, will be auto-injected
            // No action needed here, session_start will handle it
          } else {
            // No intent: pass ephemeral handover content via marker
            // CRITICAL: Use sm.appendCustomEntry() to add to NEW session, not pi.appendEntry()
            sm.appendCustomEntry(GTFO_SETUP_HANDOVER, {
              content: handoverContent,
            });
          }
        },
      });

      // Check if user cancelled
      if (result.cancelled) {
        // Rollback state
        state.lastHandoverPath = previousHandoverPath;
        persistState(pi, ctx);
        ctx.ui.notify("Session switch cancelled, state rolled back", "info");
      }
    } catch (error) {
      // Rollback on error
      state.lastHandoverPath = previousHandoverPath;
      persistState(pi, ctx);
      throw error;
    }
  }

  // ── Handover generation ────────────────────────────────────────────────
  async function generateHandover(
    ctx: ExtensionContext,
    assessmentReason: string,
  ): Promise<string> {
    const entries = ctx.sessionManager.getBranch();

    // Extract intent info
    let intentSummary = "No active intent.";
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "intent-context") {
        const content = (entry.data as any)?.content || "";
        const descMatch = content.match(
          /## Description\n\n([\s\S]+?)(?=\n##|$)/,
        );
        if (descMatch) {
          intentSummary = descMatch[1].trim();
        }
        break;
      }
    }

    // Build handover sections
    const sections = [
      "# Session Handover Document",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Reason: ${assessmentReason}`,
      "",
      "## Current Task/Intent Summary",
      "",
      intentSummary,
      "",
      "## What Was Accomplished",
      "",
      "*(Review recent conversation for accomplishments)*",
      "",
      "## What Remains To Be Done",
      "",
      "*(Review intent success criteria and current progress)*",
      "",
      "## Key Decisions Made",
      "",
      "*(Extract important decisions from conversation)*",
      "",
      "## Important Discoveries",
      "",
      "*(Note any significant findings or insights)*",
      "",
      "## Next Steps/Recommendations",
      "",
      "*(Continue from where this session left off)*",
    ];

    return sections.join("\n");
  }

  // ── Helper functions ───────────────────────────────────────────────────
  function getActiveIntentId(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "intent-context") {
        const content = (entry.data as any)?.content || "";
        const idMatch = content.match(/\*\*Intent ID:\*\*\s+([a-f0-9-]+)/);
        if (idMatch) {
          return idMatch[1];
        }
        break;
      }
    }
    return null;
  }

  function persistState(pi: ExtensionAPI, ctx: ExtensionContext): void {
    const activeIntent = getActiveIntentId(ctx);
    if (activeIntent) {
      // Persist via intent metadata
      pi.appendEntry("gtfo-state", state);
    }
    // For non-intent sessions, state stays in-memory only
  }
}
