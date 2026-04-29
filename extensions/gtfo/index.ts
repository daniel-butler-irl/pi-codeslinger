import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";

// The subset of GTFOState that is meaningful to persist across restarts.
// Excludes transients: assessmentInProgress, nextThreshold.
interface PersistedGTFOState {
  disabled: boolean;
  lastHandoverPath: string | null;
  assessmentModel: string | null;
  pendingHandoverReason: string | null;
  baseThreshold: number;
}

// Full in-memory state including transients.
interface GTFOState {
  nextThreshold: number | null;
  disabled: boolean;
  lastHandoverPath: string | null;
  assessmentInProgress: boolean;
  assessmentModel: string | null;
  pendingHandoverReason: string | null;
  baseThreshold: number;
}

// Dependency injection seam — lets tests stub createAgentSession without
// needing the real SDK installed.
export interface GtfoDeps {
  createAgentSession?: typeof import("@mariozechner/pi-coding-agent").createAgentSession;
}

// True iff ctx exposes the command-only newSession action.
export function hasNewSession(
  ctx: ExtensionContext | ExtensionCommandContext,
): ctx is ExtensionCommandContext {
  return (
    typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
  );
}

// Marker for handover auto-injection from file
const GTFO_HANDOVER_MARKER = "gtfo-handover-injected";
// Marker for ephemeral handover (passed via setup)
const GTFO_SETUP_HANDOVER = "gtfo-setup-handover";

// Parse verdict and reason from assessment model output.
// Exported for unit testing.
export function parseVerdict(text: string): { verdict: string; reason: string } {
  const verdictMatch = text.match(/VERDICT:\s*(YES|NO|MAYBE)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/is);
  return {
    verdict: verdictMatch ? verdictMatch[1].toUpperCase() : "MAYBE",
    reason: reasonMatch
      ? reasonMatch[1].trim()
      : "Could not determine task status.",
  };
}

function createGtfoState(): GTFOState {
  return {
    nextThreshold: null,
    disabled: false,
    lastHandoverPath: null,
    assessmentInProgress: false,
    assessmentModel: null,
    pendingHandoverReason: null,
    baseThreshold: 60,
  };
}

// Extract plain-text transcript from session branch for use in prompts.
function extractTranscript(ctx: ExtensionContext): Array<{ role: string; content: string }> {
  return ctx.sessionManager
    .getBranch()
    .map((entry: any) => {
      if (entry.type === "message" && entry.message.role !== "toolResult") {
        const msg = entry.message;
        if (msg.role === "assistant") {
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
    .filter((m: any) => m !== null) as Array<{ role: string; content: string }>;
}

export default function (pi: ExtensionAPI, deps: GtfoDeps = {}) {
  // Per-session state map — keyed by session ID so concurrent sessions don't
  // share or trample each other's GTFO state.
  const states = new Map<string, GTFOState>();

  // Resolve (or lazily create) the state for the given session.
  // Falls back to "default" if the session manager does not expose getSessionId,
  // which guards against SDK versions that haven't shipped the method yet.
  function stateFor(ctx: ExtensionContext): GTFOState {
    const id =
      typeof (ctx.sessionManager as any).getSessionId === "function"
        ? ((ctx.sessionManager as any).getSessionId() as string) || "default"
        : "default";

    let s = states.get(id);
    if (!s) {
      s = createGtfoState();
      states.set(id, s);
    }
    return s;
  }

  // Cache for the lazily-resolved createAgentSession function.
  let cachedCreateAgentSession: typeof import("@mariozechner/pi-coding-agent").createAgentSession | null = null;

  // Single helper so both runAssessment and generateHandover share the same
  // resolution path.
  async function getCreateAgentSession(): Promise<typeof import("@mariozechner/pi-coding-agent").createAgentSession> {
    if (deps.createAgentSession) return deps.createAgentSession;
    if (!cachedCreateAgentSession) {
      const mod = await import("@mariozechner/pi-coding-agent");
      cachedCreateAgentSession = mod.createAgentSession;
    }
    return cachedCreateAgentSession;
  }

  // ── Session start: restore state & inject setup handover ──────────────
  pi.on("session_start", async (_event, ctx) => {
    const state = stateFor(ctx);

    // Soft cap: if the map has grown past 32 entries, evict the oldest entry
    // that isn't the current session. A long-running process could otherwise
    // accumulate state for every session ever started (sub-agents, worktrees, etc.).
    if (states.size > 32) {
      const currentId =
        typeof (ctx.sessionManager as any).getSessionId === "function"
          ? ((ctx.sessionManager as any).getSessionId() as string) || "default"
          : "default";
      for (const key of states.keys()) {
        if (key !== currentId) {
          states.delete(key);
          break; // Map preserves insertion order — first key is the oldest.
        }
      }
    }

    // Try to restore state from intent metadata — use LAST entry (most recent snapshot).
    const entries = ctx.sessionManager.getEntries();
    let lastGtfoEntry: any = null;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "gtfo-state") {
        lastGtfoEntry = entry;
        // Do NOT break — keep iterating to find the last one.
      }
    }
    if (lastGtfoEntry) {
      const persisted = lastGtfoEntry.data as Partial<PersistedGTFOState>;
      // Merge only persisted fields; reset transients to initial values.
      state.disabled = persisted.disabled ?? state.disabled;
      state.lastHandoverPath = persisted.lastHandoverPath ?? state.lastHandoverPath;
      state.assessmentModel = persisted.assessmentModel ?? state.assessmentModel;
      state.pendingHandoverReason = persisted.pendingHandoverReason ?? state.pendingHandoverReason;
      state.baseThreshold = persisted.baseThreshold ?? state.baseThreshold;
      // Transients always reset:
      state.assessmentInProgress = false;
      state.nextThreshold = null;
    }

    // Check for setup handover (ephemeral, passed via setup callback)
    const setupHandover = entries.find(
      (e: any) => e.type === "custom" && e.customType === GTFO_SETUP_HANDOVER,
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
        (e: any) =>
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
    const state = stateFor(ctx);
    if (state.disabled || state.assessmentInProgress) return;

    const usage = ctx.getContextUsage();
    if (!usage || !usage.tokens || !ctx.model) return;

    const contextWindow = ctx.model.contextWindow;
    const percentUsed = (usage.tokens / contextWindow) * 100;

    // Check if we've reached a threshold
    const currentThreshold = state.nextThreshold ?? state.baseThreshold;

    if (percentUsed >= currentThreshold) {
      // Trigger assessment
      state.assessmentInProgress = true;
      persistState(pi, ctx);

      try {
        await runAssessment(ctx, percentUsed);
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
      const state = stateFor(ctx);
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
        await runAssessment(ctx, percentUsed);
      } finally {
        state.assessmentInProgress = false;
        persistState(pi, ctx);
      }
    },
  });

  // ── Command: create handover + switch session ─────────────────────────
  // newSession is only available on ExtensionCommandContext (this handler),
  // so the handover-and-switch flow lives here. turn_end / shortcut paths
  // queue a pending reason and notify the user to invoke this command.
  pi.registerCommand("gtfo:handover", {
    description: "Create session handover document and switch to a new session",
    handler: async (args, ctx) => {
      const state = stateFor(ctx);
      const reason =
        args.trim() || state.pendingHandoverReason || "Manual handover";
      try {
        await createHandoverAndSwitch(ctx, reason);
        state.pendingHandoverReason = null;
        persistState(pi, ctx);
      } catch (err) {
        ctx.ui.notify(
          `GTFO handover failed: ${(err as Error).message}`,
          "error",
        );
      }
    },
  });

  // ── Command to re-enable GTFO ──────────────────────────────────────────
  pi.registerCommand("gtfo:enable", {
    description: "Re-enable GTFO monitoring after it was disabled",
    handler: async (_args, ctx) => {
      const state = stateFor(ctx);
      state.disabled = false;
      persistState(pi, ctx);
      ctx.ui.notify("GTFO monitoring re-enabled", "info");
    },
  });

  // ── Command to configure assessment model ──────────────────────────────
  pi.registerCommand("gtfo:model", {
    description: "Configure which model to use for task completion assessment",
    handler: async (args, ctx) => {
      const state = stateFor(ctx);
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

  // ── Command to configure base threshold ───────────────────────────────
  pi.registerCommand("gtfo:threshold", {
    description: "Get or set the base token-usage threshold (%) at which GTFO triggers",
    handler: async (args, ctx) => {
      const state = stateFor(ctx);
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          `Current GTFO threshold: ${state.baseThreshold}%`,
          "info",
        );
        return;
      }

      const parsed = parseFloat(trimmed);
      if (isNaN(parsed) || parsed < 1 || parsed > 99) {
        ctx.ui.notify(
          "Invalid threshold: must be a number between 1 and 99",
          "error",
        );
        return;
      }

      state.baseThreshold = parsed;
      // Clear nextThreshold so the new base takes effect immediately.
      state.nextThreshold = null;
      persistState(pi, ctx);
      ctx.ui.notify(`GTFO threshold set to: ${parsed}%`, "info");
    },
  });

  // ── Clear nextThreshold and pendingHandoverReason on intent switch ─────
  // Do NOT touch state.disabled — that persists until /gtfo:enable.
  // intent:active-changed fires without a ctx (no session ID), so clear these
  // transients for every tracked session — intent switches are process-wide.
  pi.events.on("intent:active-changed", (_payload: any) => {
    for (const s of states.values()) {
      s.nextThreshold = null;
      s.pendingHandoverReason = null;
    }
  });

  // ── Assessment logic ───────────────────────────────────────────────────
  async function runAssessment(
    ctx: ExtensionContext,
    percentUsed: number,
  ): Promise<void> {
    const state = stateFor(ctx);
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

    const messages = extractTranscript(ctx);

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

      const createAgentSession = await getCreateAgentSession();
      const { session } = await createAgentSession({
        model: assessmentModel,
      });

      await session.prompt(assessmentPrompt);

      // Get the last assistant message — use findLast to avoid mutating the array.
      const sessionMessages: any[] = session.state.messages;
      const lastAssistant = sessionMessages.findLast(
        (m: any) => m.role === "assistant",
      );
      let text = "";
      if (lastAssistant && "content" in lastAssistant) {
        const content = (lastAssistant as any).content;
        // Join all text blocks so leading thinking/citation blocks are skipped.
        text = Array.isArray(content)
          ? content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
          : "";
      }

      // Parse response
      const { verdict, reason } = parseVerdict(text);

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
        // NO/MAYBE flow: single select with disable as a first-class option.
        const HANDOVER = "Create handover and switch to new session";
        const CONTINUE = "Continue in current session";
        const DISABLE = "Disable GTFO for this session";
        const action = await ctx.ui.select(
          `Context at ${Math.round(percentUsed)}%. Assessment: ${reason}\n\nWhat would you like to do?`,
          [HANDOVER, CONTINUE, DISABLE],
        );

        if (!action) {
          // User dismissed without choosing — bump threshold to avoid re-triggering.
          state.nextThreshold = Math.ceil(percentUsed / 10) * 10 + 10;
          persistState(pi, ctx);
          ctx.ui.notify("GTFO assessment cancelled", "info");
          return;
        }

        if (action === DISABLE) {
          state.disabled = true;
          persistState(pi, ctx);
          ctx.ui.notify(
            "GTFO disabled for this session. Use /gtfo:enable to re-enable.",
            "info",
          );
          return;
        }

        if (action === HANDOVER) {
          if (hasNewSession(ctx)) {
            await createHandoverAndSwitch(ctx, reason);
          } else {
            // Event/shortcut ctx: newSession only available in command handler.
            state.pendingHandoverReason = reason;
            persistState(pi, ctx);
            ctx.ui.notify(
              "Run /gtfo:handover to create handover and switch sessions",
              "warning",
            );
          }
          // Bump threshold so we don't re-trigger on next turn while user works.
          state.nextThreshold = Math.ceil(percentUsed / 10) * 10 + 10;
          persistState(pi, ctx);
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
    ctx: ExtensionCommandContext,
    assessmentReason: string,
  ): Promise<void> {
    const state = stateFor(ctx);

    // Generate handover content (LLM-filled with template fallback)
    const handoverContent = await generateHandover(ctx, assessmentReason);

    // Determine handover path
    let handoverPath: string | null = null;
    const activeIntent = getActiveIntentId(ctx);

    if (activeIntent) {
      // Save to intent directory — ensure directory exists before writing.
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      handoverPath = join(
        ctx.cwd,
        ".pi",
        "intents",
        activeIntent,
        `handover-${timestamp}.md`,
      );
      mkdirSync(dirname(handoverPath), { recursive: true });
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
        setup: async (sm: any) => {
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
        // Best-effort cleanup of the file written to disk.
        if (handoverPath) {
          try {
            unlinkSync(handoverPath);
          } catch (unlinkErr) {
            ctx.ui.notify(
              `GTFO: could not remove orphan handover file: ${(unlinkErr as Error).message}`,
              "warning",
            );
          }
        }
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
    const state = stateFor(ctx);

    const header = [
      "# Session Handover Document",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Reason: ${assessmentReason}`,
      "",
    ].join("\n");

    // Build transcript for the model prompt.
    const messages = extractTranscript(ctx);

    // Extract intent summary for fallback template.
    const branch = ctx.sessionManager.getBranch();
    let intentSummary = "No active intent.";
    for (const entry of branch) {
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

    try {
      const createAgentSession = await getCreateAgentSession();

      const assessmentModel = state.assessmentModel
        ? ctx.modelRegistry.find("*", state.assessmentModel) || ctx.model
        : ctx.model;

      const { session } = await createAgentSession({ model: assessmentModel });

      const handoverPrompt = `You are generating a session handover document for a coding assistant session.

## Conversation Transcript
${JSON.stringify(messages, null, 2)}

## Task
Produce a detailed handover document with exactly these sections in this order:
1. Current Task/Intent Summary
2. What Was Accomplished
3. What Remains To Be Done
4. Key Decisions Made
5. Important Discoveries
6. Next Steps/Recommendations

Write each section with specific details from the conversation. Use markdown headings (##) for each section.
Do NOT include a top-level heading — it will be prepended. Start directly with "## Current Task/Intent Summary".`;

      await session.prompt(handoverPrompt);

      const sessionMessages: any[] = session.state.messages;
      const lastAssistant = sessionMessages.findLast(
        (m: any) => m.role === "assistant",
      );
      let modelOutput = "";
      if (lastAssistant && "content" in lastAssistant) {
        const content = (lastAssistant as any).content;
        modelOutput = Array.isArray(content)
          ? content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
          : "";
      }

      if (modelOutput.trim()) {
        return header + modelOutput.trim();
      }
    } catch {
      // Fall through to template fallback below.
    }

    // Fallback template when the model call fails (offline, quota, etc.)
    ctx.ui.notify(
      "GTFO: could not reach assessment model; using template handover",
      "warning",
    );
    const sections = [
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

    return header + sections.join("\n");
  }

  // ── Helper functions ───────────────────────────────────────────────────
  // getActiveIntentId parses the Intent ID from the intent extension's markdown
  // content. The intent-context entry is injected as a sendMessage (not appendEntry),
  // so it appears in the branch as a message with a `content` string in markdown
  // format. There is no structured `data.intentId` field available via getEntries();
  // regex parsing is the only option here.
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
    const state = stateFor(ctx);
    const activeIntent = getActiveIntentId(ctx);
    if (activeIntent) {
      // Persist only user-meaningful fields — exclude transients.
      const persisted: PersistedGTFOState = {
        disabled: state.disabled,
        lastHandoverPath: state.lastHandoverPath,
        assessmentModel: state.assessmentModel,
        pendingHandoverReason: state.pendingHandoverReason,
        baseThreshold: state.baseThreshold,
      };
      pi.appendEntry("gtfo-state", persisted);
    }
    // For non-intent sessions, state stays in-memory only
  }

  // Test-only accessor — do not use in production code paths.
  // Exposed solely to verify eviction behavior without re-introducing backdoors
  // that reveal full state internals.
  return {
    __statesForTesting: () => states,
  };
}
