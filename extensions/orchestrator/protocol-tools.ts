/**
 * Protocol tools — the vocabulary subagents use to talk back to the
 * orchestrator. Each tool's execute body mutates flight.pendingSignal so
 * when control returns to the orchestrator's driver loop (after the
 * agent's prompt finishes), the driver can pop the signal and route it.
 *
 * These are NOT Pi's built-in tools. They're injected per-flight as
 * customTools into the subagent's session.
 *
 * Discipline: each tool sets pendingSignal to exactly one value. If the
 * agent calls two protocol tools in one turn, the second wins — the
 * driver sees only the last signal. That's acceptable because agents are
 * instructed (via their system prompt) to stop producing work after any
 * protocol call.
 */
// TODO: Migrate to 'typebox' once TypeScript types are fully compatible
// Currently using @sinclair/typebox with Pi 0.69.0's compatibility shims
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentRole, IntentFlight } from "./state.ts";

function ack(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Structured error returned by protocol tools when no active flight is
 * present. Protocol tools mutate flight state; without a flight there is
 * no state to mutate, so they refuse instead of silently no-op-ing.
 */
const NO_FLIGHT_MESSAGE =
  "No active flight: this tool only works inside an orchestrator-managed " +
  "subagent session. Did you mean to call something else?";

function noFlightError() {
  return {
    content: [{ type: "text" as const, text: NO_FLIGHT_MESSAGE }],
    isError: true,
    details: undefined,
  };
}

/**
 * `propose_done` — the agent believes its work is complete.
 * The orchestrator will decide whether to accept (advancing the phase)
 * or reject (coming back through the agent's next prompt).
 */
export function makeProposeDoneTool(
  flight: IntentFlight | null,
  role: AgentRole,
): ToolDefinition {
  return {
    name: "propose_done",
    label: "Propose done",
    description:
      `Propose that your work on intent ${flight?.intentId ?? "(no active flight)"} is complete. ` +
      `The orchestrator will review your proposal and either accept it or ` +
      `send you back for more work. Do not call this until you have made ` +
      `concrete evidence available (edits applied, log entries appended, ` +
      `verification evidence collected).`,
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Short summary of what you did and why you believe it is complete.",
      }),
      artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of paths, test names, or other artefacts the " +
            "orchestrator should inspect.",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!flight) return noFlightError();
      const params = rawParams as { summary: string; artifacts?: string[] };
      flight.pendingSignal = {
        kind: "proposal",
        agentRole: role,
        intentId: flight.intentId,
        summary: params.summary,
        artifacts: params.artifacts ?? [],
        proposedAt: new Date().toISOString(),
      };
      return ack(
        "Proposal recorded. The orchestrator will review it and respond " +
          "via your next instruction. Stop producing new work until you hear back.",
      );
    },
  };
}

/**
 * `report_status` — the reviewer pushes a one-line live status update.
 * Does NOT set pendingSignal; the reviewer session keeps running after
 * calling this. The driver wires flight.onStatus to emit an event to the UI.
 */
export function makeReportStatusTool(
  flight: IntentFlight | null,
): ToolDefinition {
  return {
    name: "report_status",
    label: "Report status",
    description:
      `Push a brief live status update while reviewing intent ${flight?.intentId ?? "(no active flight)"}. ` +
      `Use short phrases ("Checking test coverage", "Reading contract", ` +
      `"Inspecting changed files"). Do not use this to report findings — ` +
      `use report_review for that. Call this freely as you work.`,
    parameters: Type.Object({
      message: Type.String({
        description:
          "One short phrase describing what you are currently doing.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      if (!flight) return noFlightError();
      const params = rawParams as { message: string };
      flight.onStatus?.(params.message);
      return ack("Status noted.");
    },
  };
}

/**
 * `report_review` — the reviewer's structured verdict.
 */
export function makeReportReviewTool(
  flight: IntentFlight | null,
): ToolDefinition {
  return {
    name: "report_review",
    label: "Report review",
    description:
      `Submit your adversarial review verdict for intent ${flight?.intentId ?? "(no active flight)"}. ` +
      `Use "pass" only if you have actively tried to find problems and ` +
      `could not. Use "rework" if anything is unclear, shallow, or ` +
      `unverified — include concrete findings.`,
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("rework")], {
        description: "Your verdict.",
      }),
      summary: Type.String({
        description:
          "2-3 sentence prose summary of what you found (or confirmed was " +
          "clean). This appears in the sidebar so keep it concise and human-readable.",
      }),
      findings: Type.Array(Type.String(), {
        description:
          "Concrete findings. Empty list allowed only for verdict=pass.",
      }),
      nextActions: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "If verdict=rework, the specific actions the implementer " +
            "should take next.",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!flight) return noFlightError();
      const params = rawParams as {
        verdict: "pass" | "rework";
        summary: string;
        findings: string[];
        nextActions?: string[];
      };
      if (params.verdict === "rework" && params.findings.length === 0) {
        return ack(
          "Rejected: verdict=rework requires at least one concrete finding. " +
            "Try again with specifics.",
        );
      }
      flight.pendingSignal = {
        kind: "review",
        intentId: flight.intentId,
        verdict: params.verdict,
        summary: params.summary,
        findings: params.findings,
        nextActions: params.nextActions ?? [],
        reportedAt: new Date().toISOString(),
      };
      return ack(
        `Review recorded (verdict=${params.verdict}). Stop producing new ` +
          "findings. The orchestrator will route your verdict.",
      );
    },
  };
}

/**
 * `ask_orchestrator` — the agent escalates a question it cannot answer
 * from its own context. The orchestrator responds via the agent's next
 * prompt().
 */
export function makeAskOrchestratorTool(
  flight: IntentFlight | null,
  role: AgentRole,
): ToolDefinition {
  return {
    name: "ask_orchestrator",
    label: "Ask orchestrator",
    description:
      "Escalate a question to the orchestrator. Use only when you cannot " +
      "proceed without input from a higher-level decision-maker (e.g. the " +
      "human, or a different subagent). Not for rhetorical questions.",
    parameters: Type.Object({
      question: Type.String({ description: "Clear, answerable question." }),
      context: Type.Optional(
        Type.String({
          description: "Background the orchestrator needs to answer.",
        }),
      ),
    }),
    async execute(_toolCallId, rawParams) {
      if (!flight) return noFlightError();
      const params = rawParams as { question: string; context?: string };
      flight.pendingSignal = {
        kind: "question",
        agentRole: role,
        intentId: flight.intentId,
        question: params.question,
        context: params.context ?? null,
        askedAt: new Date().toISOString(),
      };
      return ack(
        "Question recorded. Stop work until the orchestrator responds in " +
          "your next instruction.",
      );
    },
  };
}

/**
 * `read_intent` — read the current intent's contract file.
 * Provides convenient access to the locked contract without needing
 * to construct the path manually.
 */
export function makeReadIntentTool(
  flight: IntentFlight,
  cwd: string,
): ToolDefinition {
  return {
    name: "read_intent",
    label: "Read intent",
    description:
      `Read the contract for intent ${flight.intentId}. Returns the ` +
      `full content of the intent.md file (Description, Success Criteria, ` +
      `and Verification sections).`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams) {
      // Import here to avoid circular dependency issues
      const { loadIntentContent } = await import("../intent/store.ts");
      const content = loadIntentContent(cwd, flight.intentId);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Intent contract file is empty)",
          },
        ],
        details: {},
      };
    },
  };
}

/**
 * `list_intents` — list all intents with their metadata.
 * Useful for understanding the intent tree, finding related intents,
 * or checking what work has been done.
 */
export function makeListIntentsTool(cwd: string): ToolDefinition {
  return {
    name: "list_intents",
    label: "List intents",
    description:
      "List all intents in the project with their metadata (id, title, " +
      "phase, parent relationship). Useful for understanding the intent " +
      "tree structure, finding related work, or checking status.",
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
    async execute(_toolCallId, rawParams) {
      const params = rawParams as {
        filter?: "all" | "active" | "done" | "children";
      };
      const { loadStore, filterIntents } = await import("../intent/store.ts");
      const { readActiveIntent } = await import("../intent/active-local.ts");
      const store = loadStore(cwd);
      const activeIntentId = readActiveIntent(cwd);
      const filter = params.filter ?? "all";
      const intents = filterIntents(store, filter, cwd);

      if (intents.length === 0) {
        return ack("No intents found matching the filter.");
      }

      const lines = intents.map((intent) => {
        const active = intent.id === activeIntentId ? " [ACTIVE]" : "";
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
        details: {},
      };
    },
  };
}

/**
 * `read_intent_log` — read the append-only log for an intent.
 * The log contains discoveries, decisions, review findings, and other
 * timestamped events from the intent's lifecycle.
 */
export function makeReadIntentLogTool(
  flight: IntentFlight,
  cwd: string,
): ToolDefinition {
  return {
    name: "read_intent_log",
    label: "Read intent log",
    description:
      `Read the append-only log for intent ${flight.intentId}. The log ` +
      `contains discoveries, decisions, verification results, review ` +
      `findings, and other timestamped events from the intent's lifecycle.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams) {
      const { readLog } = await import("../intent/store.ts");
      const content = readLog(cwd, flight.intentId);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Log is empty)",
          },
        ],
        details: {},
      };
    },
  };
}

/**
 * `read_intent_understanding` — read the current understanding file.
 * This contains the session's evolving understanding of the problem,
 * key discoveries, next steps, and open questions.
 */
export function makeReadIntentUnderstandingTool(
  flight: IntentFlight,
  cwd: string,
): ToolDefinition {
  return {
    name: "read_intent_understanding",
    label: "Read intent understanding",
    description:
      `Read the understanding file for intent ${flight.intentId}. This ` +
      `contains the session's current problem understanding, key ` +
      `discoveries, next steps needed, and open questions.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams) {
      const { readUnderstanding } = await import("../intent/store.ts");
      const content = readUnderstanding(cwd, flight.intentId);
      return {
        content: [
          {
            type: "text" as const,
            text: content || "(Understanding file is empty)",
          },
        ],
        details: {},
      };
    },
  };
}

/**
 * `read_verification_results` — read the cached verification results.
 * Shows which commands passed/failed in the last verification run.
 */
export function makeReadVerificationResultsTool(
  flight: IntentFlight,
  cwd: string,
): ToolDefinition {
  return {
    name: "read_verification_results",
    label: "Read verification results",
    description:
      `Read the cached verification results for intent ${flight.intentId}. ` +
      `Shows which commands passed or failed in the most recent ` +
      `verification run, with exit codes and output.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _rawParams) {
      const { readVerification } = await import("../intent/store.ts");
      const result = readVerification(cwd, flight.intentId);
      if (!result) {
        return ack("No verification results available yet.");
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
        details: {},
      };
    },
  };
}

/**
 * `spawn_child_intent` — the agent has detected a prerequisite that
 * blocks current progress and wants a child intent created for it.
 * The orchestrator creates the child, sets it active, and pauses the
 * parent (blocked-on-child) until the child reaches done.
 */
export function makeSpawnChildIntentTool(
  flight: IntentFlight | null,
  role: AgentRole,
): ToolDefinition {
  return {
    name: "spawn_child_intent",
    label: "Spawn child intent",
    description:
      `Propose a child intent for a prerequisite that blocks progress ` +
      `on intent ${flight?.intentId ?? "(no active flight)"}. Example: a verification command ` +
      `references tests that do not yet exist — the child intent is ` +
      `"create those tests". The orchestrator will pause this intent ` +
      `until the child is done. Use sparingly; prefer completing the ` +
      `current intent's scope.`,
    parameters: Type.Object({
      description: Type.String({
        description:
          "Plain-language description of the prerequisite work (will " +
          "become the child intent's Description).",
      }),
      reason: Type.String({
        description:
          "Why this is a prerequisite — what part of the current intent " +
          "cannot progress without it.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      if (!flight) return noFlightError();
      const params = rawParams as { description: string; reason: string };
      flight.pendingSignal = {
        kind: "spawn-child",
        agentRole: role,
        parentIntentId: flight.intentId,
        description: params.description,
        reason: params.reason,
        requestedAt: new Date().toISOString(),
      };
      return ack(
        "Child intent requested. The orchestrator will pause this intent " +
          "and run the child through defining. You will be resumed when " +
          "the child reaches done. Stop work until then.",
      );
    },
  };
}

/**
 * Build the full protocol tool set for a given agent role.
 * Different roles get different subsets; keeping this centralized so
 * adding a new role in one place gets it the right tools everywhere.
 */
export function protocolToolsForRole(
  flight: IntentFlight,
  role: AgentRole,
  cwd: string,
): ToolDefinition[] {
  // Tools available to all roles
  const commonTools = [
    makeReadIntentTool(flight, cwd),
    makeListIntentsTool(cwd),
    makeReadIntentLogTool(flight, cwd),
    makeReadIntentUnderstandingTool(flight, cwd),
    makeReadVerificationResultsTool(flight, cwd),
    makeAskOrchestratorTool(flight, role),
    makeSpawnChildIntentTool(flight, role),
  ];

  switch (role) {
    case "reviewer":
      return [
        ...commonTools,
        makeReportStatusTool(flight),
        makeReportReviewTool(flight),
      ];
    case "implementer":
    case "planner":
    case "researcher":
      return [...commonTools, makeProposeDoneTool(flight, role)];
  }
}
