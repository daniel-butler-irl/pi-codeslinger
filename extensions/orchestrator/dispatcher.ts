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
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-defs.ts";
import type {
  AgentRole,
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
    systemPromptOverride: () => opts.definition.systemPrompt,
  });
  await loader.reload();

  const builtinTools = buildBuiltinTools(opts.cwd, opts.definition.tools);
  const protocolTools: ToolDefinition[] = protocolToolsForRole(
    opts.flight,
    opts.role,
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

  return {
    role: opts.role,
    prompt: async (text: string) => {
      await session.prompt(text);
    },
    dispose: async () => {
      session.dispose();
    },
  };
}
