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
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentRole, IntentFlight } from "./state.ts";

function ack(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * `propose_done` — the agent believes its work is complete.
 * The orchestrator will decide whether to accept (advancing the phase)
 * or reject (coming back through the agent's next prompt).
 */
export function makeProposeDoneTool(
  flight: IntentFlight,
  role: AgentRole,
): ToolDefinition {
  return {
    name: "propose_done",
    label: "Propose done",
    description:
      `Propose that your work on intent ${flight.intentId} is complete. ` +
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
 * `report_review` — the reviewer's structured verdict.
 */
export function makeReportReviewTool(flight: IntentFlight): ToolDefinition {
  return {
    name: "report_review",
    label: "Report review",
    description:
      `Submit your adversarial review verdict for intent ${flight.intentId}. ` +
      `Use "pass" only if you have actively tried to find problems and ` +
      `could not. Use "rework" if anything is unclear, shallow, or ` +
      `unverified — include concrete findings.`,
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("rework")], {
        description: "Your verdict.",
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
      const params = rawParams as {
        verdict: "pass" | "rework";
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
  flight: IntentFlight,
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
 * `spawn_child_intent` — the agent has detected a prerequisite that
 * blocks current progress and wants a child intent created for it.
 * The orchestrator creates the child, sets it active, and pauses the
 * parent (blocked-on-child) until the child reaches done.
 */
export function makeSpawnChildIntentTool(
  flight: IntentFlight,
  role: AgentRole,
): ToolDefinition {
  return {
    name: "spawn_child_intent",
    label: "Spawn child intent",
    description:
      `Propose a child intent for a prerequisite that blocks progress ` +
      `on intent ${flight.intentId}. Example: a verification command ` +
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
): ToolDefinition[] {
  switch (role) {
    case "reviewer":
      return [
        makeReportReviewTool(flight),
        makeAskOrchestratorTool(flight, role),
        makeSpawnChildIntentTool(flight, role),
      ];
    case "implementer":
    case "planner":
    case "researcher":
      return [
        makeProposeDoneTool(flight, role),
        makeAskOrchestratorTool(flight, role),
        makeSpawnChildIntentTool(flight, role),
      ];
  }
}
