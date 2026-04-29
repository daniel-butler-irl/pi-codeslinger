/**
 * Subagent dispatcher — creates in-process agent sessions using Pi's SDK,
 * wraps them in a DispatchedAgentHandle, and exposes a single
 * fire-and-await prompt interface.
 *
 * Principle: one AgentSession per role per intent, persistent across the
 * intent's lifetime. Disposed only when the orchestrator tears the
 * flight down — survives rework loops.
 */
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
  createAgentSession,
  createReadTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  getAgentDir,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-defs.ts";
import type {
  AgentRole,
  AgentTranscriptEntry,
  DispatchedAgentHandle,
  IntentFlight,
} from "./state.ts";
import { protocolToolsForRole } from "./protocol-tools.ts";

/**
 * Build the tool list for a subagent by mapping tool names from the
 * agent definition onto factory-created tools scoped to the right cwd.
 * Unknown tool names throw — agents must declare their toolbox explicitly.
 *
 * Returns `any[]` because the factory functions produce tools of
 * different generic parameters (AgentTool<BashSchema>, AgentTool<ReadSchema>,
 * etc.). Pi's own SDK accepts this shape; typing the array narrowly isn't
 * worth the complexity.
 */
function buildBuiltinTools(cwd: string, names: string[]): any[] {
  // Empty list → sensible default: read-only tools.
  if (names.length === 0) {
    return [
      createReadTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
    ];
  }

  const factories: Record<string, () => any> = {
    read: () => createReadTool(cwd),
    grep: () => createGrepTool(cwd),
    find: () => createFindTool(cwd),
    ls: () => createLsTool(cwd),
    bash: () => createBashTool(cwd),
    edit: () => createEditTool(cwd),
    write: () => createWriteTool(cwd),
  };

  return names.map((name) => {
    const f = factories[name];
    if (!f) {
      throw new Error(
        `Unknown built-in tool "${name}" in agent definition. Valid: ${Object.keys(factories).join(", ")}`,
      );
    }
    return f();
  });
}

export interface DispatchOptions {
  cwd: string;
  /** Shared across all subagents so they use the same auth/model config. */
  authStorage: AuthStorage;
  /** Shared so model lookup is consistent. */
  modelRegistry: ModelRegistry;
  /** Active flight the agent belongs to. Protocol tools mutate it. */
  flight: IntentFlight;
  /** The role this agent plays in the flight. */
  role: AgentRole;
  /** The definition (system prompt, model, tools) for this agent. */
  definition: AgentDefinition;
}

/**
 * Spawn a subagent from a definition and return a handle. The handle
 * exposes prompt() and dispose() — that's the entire orchestrator-facing
 * surface. Internals (session, subscriptions) are hidden.
 */
export async function dispatchAgent(
  opts: DispatchOptions,
): Promise<DispatchedAgentHandle> {
  // Defensive check for cwd
  if (!opts.cwd) {
    throw new Error(
      `dispatchAgent called with undefined cwd. ` +
        `Agent: ${opts.definition.name}, Role: ${opts.role}. ` +
        `This likely means the orchestrator driver was not properly initialized.`,
    );
  }

  if (!opts.definition.provider || !opts.definition.model) {
    throw new Error(
      `Agent "${opts.definition.name}" has no provider/model configured. ` +
        `Agents without provider/model run in the main chat session and ` +
        `cannot be dispatched as subagents.`,
    );
  }
  const model = opts.modelRegistry.find(
    opts.definition.provider,
    opts.definition.model,
  );
  if (!model) {
    throw new Error(
      `Agent "${opts.definition.name}" requested model ` +
        `${opts.definition.provider}/${opts.definition.model} which was not ` +
        `found in the model registry. Install the provider or adjust the ` +
        `agent definition.`,
    );
  }

  // Skip auto-discovery of extensions/skills/etc. The subagent is narrow —
  // it should only see what we explicitly hand it. The system prompt is
  // the agent definition's body.
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => opts.definition.systemPrompt,
  });
  await loader.reload();

  const builtinTools = buildBuiltinTools(opts.cwd, opts.definition.tools);
  const protocolTools: ToolDefinition[] = protocolToolsForRole(
    opts.flight,
    opts.role,
    opts.cwd,
  );

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    authStorage: opts.authStorage,
    modelRegistry: opts.modelRegistry,
    resourceLoader: loader,
    // In-memory session: subagents are ephemeral; we don't want them
    // polluting the user's saved session history.
    sessionManager: SessionManager.inMemory(opts.cwd),
    tools: builtinTools,
    customTools: protocolTools,
  });

  let promptInFlight = false;
  const messageQueue: string[] = [];

  const flushQueue = async () => {
    while (messageQueue.length > 0 && !promptInFlight) {
      const next = messageQueue.shift()!;
      promptInFlight = true;
      try {
        await session.prompt(next);
      } finally {
        promptInFlight = false;
      }
    }
  };

  const getTranscript = (): AgentTranscriptEntry[] => {
    const entries: AgentTranscriptEntry[] = [];
    for (const msg of session.state.messages) {
      if (msg.role === "user") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text as string)
                  .join("")
              : "";
        if (text) entries.push({ role: "user", content: text });
      } else if (msg.role === "assistant") {
        const text = Array.isArray(msg.content)
          ? msg.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text as string)
              .join("")
          : typeof msg.content === "string"
            ? msg.content
            : "";
        if (text) entries.push({ role: "assistant", content: text });
      }
    }
    return entries;
  };

  const sendUserMessage = async (text: string): Promise<void> => {
    if (promptInFlight) {
      messageQueue.push(text);
      return;
    }
    promptInFlight = true;
    try {
      await session.prompt(text);
    } finally {
      promptInFlight = false;
      await flushQueue();
    }
  };

  return {
    role: opts.role,
    prompt: async (text: string) => {
      promptInFlight = true;
      try {
        await session.prompt(text);
      } finally {
        promptInFlight = false;
        await flushQueue();
      }
    },
    dispose: async () => {
      session.dispose();
    },
    getTranscript,
    sendUserMessage,
  };
}
