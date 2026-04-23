import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OverlayHandle } from "@mariozechner/pi-tui";
import { validateIntentForLock } from "../intent/validate.ts";
import {
  createIntent,
  deleteIntent,
  getActiveIntent,
  getChildren,
  loadIntentContent,
  loadStore,
  readLog,
  readUnderstanding,
  readVerification,
  saveStore,
  transitionPhase,
  writeUnderstanding,
} from "../intent/store.ts";
import { QqOverlayComponent, type QqTranscriptEntry } from "./overlay.ts";

const QQ_APPEND_SYSTEM_PROMPT = `## Quick Question Side Session

You are a quick-question side chat that runs in parallel with the user's main coding session.

- This chat is independent from the main conversation history.
- Do not assume prior chat context unless the user explicitly gives it here.
- You do have access to the current repository and may inspect it to answer questions.
- Focus on fast, practical answers that help the user while the main agent keeps working.
- Treat repository inspection as read-only: inspect the codebase, explain findings, and avoid making code changes.
- Intent-management tools are available here as well, so you may create, switch, lock, inspect, update, and delete intents when that helps the user.`;

const QQ_READY_STATUS =
  "Ask about the repo. Enter submits; Esc dismisses; /qq:clear resets.";

type QqRuntime = {
  session: AgentSession;
  unsubscribe?: () => void;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

type TranscriptState = {
  entries: QqTranscriptEntry[];
  nextId: number;
};

export interface QqDependencies {
  createAgentSession: typeof createAgentSession;
  createResourceLoader: (
    ctx: ExtensionContext | ExtensionCommandContext,
  ) => Promise<ResourceLoader>;
}

export async function createQqResourceLoader(
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    appendSystemPromptOverride: (base) => [...base, QQ_APPEND_SYSTEM_PROMPT],
  });
  await loader.reload();
  return loader;
}

function createEmptyTranscriptState(): TranscriptState {
  return { entries: [], nextId: 1 };
}

function extractMessageText(message: {
  content?: string | Array<{ type?: string; text?: string }>;
}): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function appendTranscriptEntry(
  state: TranscriptState,
  entry: Omit<QqTranscriptEntry, "id"> | Record<string, unknown>,
): QqTranscriptEntry {
  const nextEntry = { ...entry, id: state.nextId++ } as QqTranscriptEntry;
  state.entries.push(nextEntry);
  return nextEntry;
}

function appendUserEntry(state: TranscriptState, text: string): void {
  if (!text) return;
  appendTranscriptEntry(state, { type: "user", text });
}

function upsertAssistantEntry(
  state: TranscriptState,
  text: string,
  streaming: boolean,
): void {
  const content = text || "(no text response)";
  const last = state.entries[state.entries.length - 1];
  if (last && last.type === "assistant" && last.streaming) {
    last.text = content;
    last.streaming = streaming;
    return;
  }
  appendTranscriptEntry(state, { type: "assistant", text: content, streaming });
}

function appendAssistantFailure(state: TranscriptState, message: string): void {
  appendTranscriptEntry(state, {
    type: "assistant",
    text: `❌ ${message}`,
    streaming: false,
  });
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") return path;
  }
  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") return "";
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function summarizeToolResult(
  value: unknown,
  maxLength = 240,
): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function startToolEntry(
  state: TranscriptState,
  toolCallId: string,
  toolName: string,
  args: string,
): void {
  appendTranscriptEntry(state, {
    type: "tool",
    toolCallId,
    toolName,
    args,
    status: "running",
  });
}

function finishToolEntry(
  state: TranscriptState,
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const summary = summarizeToolResult(result);
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.type !== "tool" || entry.toolCallId !== toolCallId) {
      continue;
    }

    entry.status = isError ? "error" : "success";
    entry.content = summary.content;
    entry.truncated = summary.truncated;
    return;
  }

  appendTranscriptEntry(state, {
    type: "tool",
    toolCallId,
    toolName,
    args: "",
    status: isError ? "error" : "success",
    content: summary.content,
    truncated: summary.truncated,
  });
}

function applySessionEvent(
  state: TranscriptState,
  event: AgentSessionEvent,
): void {
  switch (event.type) {
    case "message_start": {
      if (event.message.role === "user") {
        appendUserEntry(state, extractMessageText(event.message));
      }
      return;
    }
    case "message_update": {
      if (event.message.role === "assistant") {
        upsertAssistantEntry(state, extractMessageText(event.message), true);
      }
      return;
    }
    case "message_end": {
      if (event.message.role === "assistant") {
        upsertAssistantEntry(state, extractMessageText(event.message), false);
      }
      return;
    }
    case "tool_execution_start": {
      startToolEntry(
        state,
        event.toolCallId,
        event.toolName,
        formatToolPreview(event.args),
      );
      return;
    }
    case "tool_execution_end": {
      finishToolEntry(
        state,
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
      );
      return;
    }
    default:
      return;
  }
}

function getLastAssistantMessage(
  session: AgentSession,
): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return null;
}

function buildQqTools(cwd: string): any[] {
  return [
    createReadTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

function buildQqIntentTools(pi: ExtensionAPI, cwd: string): any[] {
  const noActiveIntent = {
    content: [
      {
        type: "text" as const,
        text: "No active intent. Create or switch to an intent first.",
      },
    ],
    isError: true,
    details: undefined,
  };

  return [
    {
      name: "create_intent",
      label: "Create Intent",
      description:
        "Create a new intent from a description and make it the active intent. Optionally create it as a child of an existing intent.",
      promptSnippet:
        "Create a new intent or child intent from a short description.",
      parameters: Type.Object({
        description: Type.String({
          description: "Short description of the new intent.",
        }),
        parentIntentId: Type.Optional(
          Type.String({
            description:
              "Optional parent intent ID to create a child intent under.",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { description: string; parentIntentId?: string },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) => {
        const store = loadStore(cwd);
        const parentIntentId = params.parentIntentId?.trim();
        if (
          parentIntentId &&
          !store.intents.some((intent) => intent.id === parentIntentId)
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No intent found with ID: ${parentIntentId}`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        const intent = createIntent(store, cwd, params.description, {
          parentId: parentIntentId ?? null,
        });
        saveStore(cwd, store);
        pi.events.emit("intent:created", { id: intent.id });
        pi.events.emit("intent:active-changed", { id: intent.id });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Created intent: ${intent.title} (${intent.id})\n` +
                `Phase: ${intent.phase}` +
                (intent.parentId ? `\nParent: ${intent.parentId}` : ""),
            },
          ],
          isError: false,
          details: undefined,
        };
      },
    },
    {
      name: "update_understanding",
      label: "Update Understanding",
      description:
        "Update the understanding file for the active intent with current discoveries, next steps, and open questions.",
      parameters: Type.Object({
        understanding: Type.String({
          description: "Markdown summary of the current understanding.",
        }),
      }),
      execute: async (
        _toolCallId: string,
        params: { understanding: string },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        writeUnderstanding(cwd, active.id, params.understanding);
        pi.events.emit("intent:updated", { id: active.id });
        return {
          content: [
            {
              type: "text" as const,
              text: "Understanding updated.",
            },
          ],
          isError: false,
          details: undefined,
        };
      },
    },
    {
      name: "read_intent",
      label: "Read Intent",
      description: "Read the contract file for the active intent.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        const content = loadIntentContent(cwd, active.id);
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
    },
    {
      name: "list_intents",
      label: "List Intents",
      description: "List intents and their metadata for this repository.",
      parameters: Type.Object({
        filter: Type.Optional(
          Type.Union([
            Type.Literal("all"),
            Type.Literal("active"),
            Type.Literal("done"),
            Type.Literal("children"),
          ]),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { filter?: "all" | "active" | "done" | "children" },
      ) => {
        const store = loadStore(cwd);
        const filter = params.filter ?? "all";
        let intents = store.intents;

        if (filter === "active" && store.activeIntentId) {
          intents = intents.filter(
            (intent) => intent.id === store.activeIntentId,
          );
        } else if (filter === "done") {
          intents = intents.filter((intent) => intent.phase === "done");
        } else if (filter === "children" && store.activeIntentId) {
          intents = getChildren(store, store.activeIntentId);
        }

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
          const active = intent.id === store.activeIntentId ? " [ACTIVE]" : "";
          const parent = intent.parentId
            ? ` (child of ${intent.parentId})`
            : "";
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
    },
    {
      name: "read_intent_log",
      label: "Read Intent Log",
      description: "Read the append-only log for the active intent.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        const content = readLog(cwd, active.id);
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
    },
    {
      name: "read_intent_understanding",
      label: "Read Intent Understanding",
      description: "Read the understanding file for the active intent.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        const content = readUnderstanding(cwd, active.id);
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
    },
    {
      name: "read_verification_results",
      label: "Read Verification Results",
      description:
        "Read the cached verification results for the active intent.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        const result = readVerification(cwd, active.id);
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
    },
    {
      name: "switch_intent",
      label: "Switch Intent",
      description: "Switch the active intent by ID.",
      parameters: Type.Object({
        intentId: Type.String({
          description: "The ID of the intent to switch to.",
        }),
      }),
      execute: async (_toolCallId: string, params: { intentId: string }) => {
        const store = loadStore(cwd);
        const intent = store.intents.find(
          (entry) => entry.id === params.intentId,
        );
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

        store.activeIntentId = intent.id;
        saveStore(cwd, store);
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
    },
    {
      name: "lock_intent",
      label: "Lock Intent",
      description:
        "Lock the active intent and move it from defining to implementing if validation passes.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = loadStore(cwd);
        const active = getActiveIntent(store);
        if (!active) return noActiveIntent;
        if (active.phase !== "defining") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Intent is already locked (${active.phase}).`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        const content = loadIntentContent(cwd, active.id);
        const validation = validateIntentForLock(content);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot lock intent — missing: ${validation.missing.join(", ")}`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        const from = active.phase;
        transitionPhase(store, active.id, "implementing");
        saveStore(cwd, store);
        pi.events.emit("intent:phase-changed", {
          id: active.id,
          from,
          to: "implementing",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Intent locked: ${active.title} (${active.id})`,
            },
          ],
          isError: false,
          details: undefined,
        };
      },
    },
    {
      name: "delete_intent",
      label: "Delete Intent",
      description:
        "Delete an intent by ID. Defaults to the active intent when no ID is provided.",
      parameters: Type.Object({
        intentId: Type.Optional(
          Type.String({
            description:
              "Optional intent ID to delete. Defaults to the active intent.",
          }),
        ),
      }),
      execute: async (_toolCallId: string, params: { intentId?: string }) => {
        const store = loadStore(cwd);
        const targetId = params.intentId ?? store.activeIntentId ?? undefined;
        if (!targetId) return noActiveIntent;
        const target = store.intents.find((intent) => intent.id === targetId);
        if (!target) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No intent found with ID: ${targetId}`,
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        try {
          deleteIntent(store, cwd, targetId);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
            details: undefined,
          };
        }

        saveStore(cwd, store);
        pi.events.emit("intent:deleted", { id: targetId });
        if (store.activeIntentId) {
          pi.events.emit("intent:active-changed", { id: store.activeIntentId });
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted intent: ${target.title} (${target.id})`,
            },
          ],
          isError: false,
          details: undefined,
        };
      },
    },
  ];
}

function notify(
  ctx: ExtensionContext | ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

export function registerQqExtension(
  pi: ExtensionAPI,
  dependencies: Partial<QqDependencies> = {},
): void {
  const deps: QqDependencies = {
    createAgentSession,
    createResourceLoader: createQqResourceLoader,
    ...dependencies,
  };

  let qqRuntime: QqRuntime | null = null;
  let overlayRuntime: OverlayRuntime | null = null;
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let transcriptState = createEmptyTranscriptState();
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;

  function syncOverlay(ctx?: ExtensionContext | ExtensionCommandContext): void {
    if (ctx) {
      lastUiContext = ctx;
    }
    overlayRuntime?.refresh?.();
  }

  function setOverlayStatus(
    status: string | null,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    overlayStatus = status;
    syncOverlay(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function focusOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) return;
    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }

  function hideOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) return;
    handle.setHidden(true);
    handle.unfocus();
    overlayRuntime?.refresh?.();
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  async function disposeQqSession(): Promise<void> {
    const current = qqRuntime;
    qqRuntime = null;
    if (!current) return;

    try {
      current.unsubscribe?.();
    } catch {
      // Ignore unsubscribe errors during teardown.
    }

    try {
      await current.session.abort();
    } catch {
      // Ignore abort errors during teardown.
    }

    current.session.dispose();
  }

  async function resetQqState(
    ctx?: ExtensionContext | ExtensionCommandContext,
    notice?: string,
  ): Promise<void> {
    await disposeQqSession();
    transcriptState = createEmptyTranscriptState();
    if (notice) {
      appendTranscriptEntry(transcriptState, { type: "system", text: notice });
    }
    overlayDraft = "";
    overlayStatus = QQ_READY_STATUS;
    syncOverlay(ctx);
  }

  function handleSessionEvent(
    session: AgentSession,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (qqRuntime?.session !== session) {
      return;
    }

    applySessionEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(
        `QQ is inspecting the repo with ${event.toolName}...`,
        ctx,
      );
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus("QQ is thinking...", ctx);
      return;
    }

    syncOverlay(ctx);
  }

  async function ensureQqSession(
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<QqRuntime | null> {
    if (qqRuntime) {
      return qqRuntime;
    }

    if (!ctx.model) {
      const message = "Select a model before starting QQ.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return null;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok
        ? `No credentials available for ${ctx.model.provider}/${ctx.model.id}.`
        : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return null;
    }

    const resourceLoader = await deps.createResourceLoader(ctx);
    const { session } = await deps.createAgentSession({
      cwd: ctx.cwd,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
      resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      tools: buildQqTools(ctx.cwd),
      customTools: buildQqIntentTools(pi, ctx.cwd),
    });

    const runtime: QqRuntime = { session };
    runtime.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      handleSessionEvent(session, event, lastUiContext ?? ctx);
    });
    qqRuntime = runtime;
    return runtime;
  }

  async function ensureOverlay(
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    lastUiContext = ctx;

    if (overlayRuntime?.handle) {
      focusOverlay();
      return;
    }

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          runtime.finish = () => {
            done();
          };

          const overlay = new QqOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => overlayStatus,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              overlayDraft = overlay.getDraft();
              hideOverlay();
            },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            closeRuntime();
          };

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "72%",
            minWidth: 68,
            maxHeight: "100%",
            anchor: "top-center",
            margin: { top: 1, bottom: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(
          ctx,
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
  }

  async function openQq(
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> {
    if (!ctx.hasUI) {
      notify(ctx, "QQ requires interactive mode.", "error");
      return;
    }

    if (!overlayStatus) {
      setOverlayStatus(QQ_READY_STATUS, ctx);
    }
    await ensureOverlay(ctx);
  }

  async function runQq(
    ctx: ExtensionContext | ExtensionCommandContext,
    prompt: string,
  ): Promise<void> {
    const question = prompt.trim();
    if (!question) {
      setOverlayStatus("Enter a question before submitting.", ctx);
      return;
    }

    await ensureOverlay(ctx);
    const runtime = await ensureQqSession(ctx);
    if (!runtime) {
      return;
    }

    const session = runtime.session;
    if (session.isStreaming) {
      const message =
        "QQ is still responding. Wait for the current reply to finish.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "warning");
      return;
    }

    setOverlayDraft("");
    setOverlayStatus("QQ is thinking...", ctx);

    try {
      await session.prompt(question);
      if (qqRuntime?.session !== session) {
        return;
      }

      const response = getLastAssistantMessage(session);
      if (!response) {
        setOverlayStatus(QQ_READY_STATUS, ctx);
        return;
      }

      if (response.stopReason === "aborted") {
        setOverlayStatus("QQ request aborted.", ctx);
        return;
      }

      if (response.stopReason === "error") {
        const message = response.errorMessage || "QQ request failed.";
        appendAssistantFailure(transcriptState, message);
        setOverlayStatus("QQ request failed. Try again or /qq:clear.", ctx);
        notify(ctx, message, "error");
        syncOverlay(ctx);
        return;
      }

      setOverlayStatus(
        "Ready for the next question. Esc dismisses; /qq:clear resets.",
        ctx,
      );
    } catch (error) {
      if (qqRuntime?.session !== session) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      appendAssistantFailure(transcriptState, message);
      setOverlayStatus("QQ request failed. Try again or /qq:clear.", ctx);
      notify(ctx, message, "error");
    } finally {
      if (qqRuntime?.session === session) {
        syncOverlay(ctx);
      }
    }
  }

  async function submitFromOverlay(
    ctx: ExtensionContext | ExtensionCommandContext,
    value: string,
  ): Promise<void> {
    await runQq(ctx, value);
  }

  pi.on("session_start", async (_event, ctx) => {
    const wasOpen = !!overlayRuntime?.handle;
    await resetQqState(
      ctx,
      wasOpen ? "New session started — context cleared" : undefined,
    );
    if (!wasOpen) {
      dismissOverlay();
    }
  });

  pi.on("session_shutdown", async () => {
    await disposeQqSession();
    dismissOverlay();
  });

  pi.registerShortcut("ctrl+q", {
    description: "Open quick-question side chat",
    handler: async (ctx) => {
      await openQq(ctx);
    },
  });

  pi.registerCommand("qq", {
    description:
      "Open the quick-question side chat, optionally asking a question immediately.",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        await openQq(ctx);
        return;
      }
      await runQq(ctx, prompt);
    },
  });

  pi.registerCommand("qq:clear", {
    description: "Clear the quick-question chat and dispose its side session.",
    handler: async (_args, ctx) => {
      await resetQqState(ctx, "Session cleared — ask a new question");
      if (overlayRuntime?.handle) {
        focusOverlay();
      }
      notify(ctx, "Cleared quick-question chat.", "info");
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerQqExtension(pi);
}
