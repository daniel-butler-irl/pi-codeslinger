/**
 * Orchestrator state — tracks the in-flight subagent work per intent.
 *
 * Separate from the intent store. The intent store persists the contract
 * and phase; this state is ephemeral and lives only in the running process.
 * If the host Pi session dies, this is rebuilt on next load (fresh, not
 * resumed) — that's fine because agents themselves are ephemeral and
 * everything durable (intent, log, verification.json) is on disk.
 */

export type AgentRole = "researcher" | "planner" | "implementer" | "reviewer";

/**
 * Everything an agent can signal back to the orchestrator during a turn
 * is a kind of PendingSignal. The driver pops it after the agent's
 * prompt() returns and routes based on discriminant.
 */
export type PendingSignal =
  | {
      kind: "proposal";
      agentRole: AgentRole;
      intentId: string;
      summary: string;
      artifacts: string[];
      proposedAt: string;
    }
  | {
      kind: "review";
      intentId: string;
      verdict: "pass" | "rework";
      summary: string;
      findings: string[];
      nextActions: string[];
      reportedAt: string;
    }
  | {
      kind: "question";
      agentRole: AgentRole;
      intentId: string;
      question: string;
      context: string | null;
      askedAt: string;
    }
  | {
      kind: "spawn-child";
      agentRole: AgentRole;
      parentIntentId: string;
      description: string;
      reason: string;
      requestedAt: string;
    };

/**
 * Per-intent orchestration record. One per active intent, created when an
 * intent transitions from defining → implementing and torn down when the
 * intent reaches done.
 */
export interface IntentFlight {
  intentId: string;
  /** Live agent sessions by role. Only set while the role is active. */
  agents: Partial<Record<AgentRole, DispatchedAgentHandle>>;
  /** A signal raised during the last agent turn, awaiting the driver. */
  pendingSignal: PendingSignal | null;
  /** Wired by the driver during reviewer turns to push live status to the UI. */
  onStatus?: (message: string) => void;
  /**
   * Set by resumeParentIfBlocked. Consumed once by the next
   * runImplementerLoop's prompt build, then cleared. Carries the just-
   * completed child's title + understanding.md digest so the parent
   * picks up where the child left off without re-reading from disk.
   */
  pendingChildSummary?: { childTitle: string; understanding: string } | null;
}

/** A single message from an agent's conversation transcript. */
export interface AgentTranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * Opaque handle the orchestrator uses to interact with a live agent.
 * The concrete shape is filled in by the dispatcher — state.ts only cares
 * that the handle exists.
 */
export interface DispatchedAgentHandle {
  role: AgentRole;
  /** Send a prompt to the agent and wait for it to finish its turn. */
  prompt: (text: string) => Promise<void>;
  /** Dispose the underlying session; must be called to release resources. */
  dispose: () => Promise<void>;
  /** Read the agent's conversation transcript as flat text entries. */
  getTranscript: () => AgentTranscriptEntry[];
  /**
   * Send a steering message to the agent. If the agent is mid-turn the
   * message is queued and flushed after the in-flight prompt resolves.
   */
  sendUserMessage: (text: string) => Promise<void>;
}

export function newFlight(intentId: string): IntentFlight {
  return {
    intentId,
    agents: {},
    pendingSignal: null,
  };
}

/** Attach a dispatched agent to a flight. */
export function registerAgent(
  flight: IntentFlight,
  handle: DispatchedAgentHandle,
): void {
  flight.agents[handle.role] = handle;
}

/** Remove an agent from a flight (caller disposes). */
export function unregisterAgent(
  flight: IntentFlight,
  role: AgentRole,
): DispatchedAgentHandle | undefined {
  const h = flight.agents[role];
  delete flight.agents[role];
  return h;
}

/**
 * Dispose every live agent in a flight, swallowing per-agent errors so a
 * broken session doesn't block cleanup of the others.
 */
export async function disposeFlight(flight: IntentFlight): Promise<void> {
  const handles = Object.values(flight.agents) as DispatchedAgentHandle[];
  await Promise.all(
    handles.map(async (h) => {
      try {
        await h.dispose();
      } catch {
        /* intentional: per-agent errors don't block flight cleanup */
      }
    }),
  );
  flight.agents = {};
}

/**
 * Top-level orchestrator state — one FlightTable keyed by intentId.
 * All mutations go through the helpers so it's easy to reason about
 * invariants (only one flight per intent, cleaned up on intent done).
 */
export class FlightTable {
  private readonly flights = new Map<string, IntentFlight>();

  get(intentId: string): IntentFlight | undefined {
    return this.flights.get(intentId);
  }

  getOrCreate(intentId: string): IntentFlight {
    let f = this.flights.get(intentId);
    if (!f) {
      f = newFlight(intentId);
      this.flights.set(intentId, f);
    }
    return f;
  }

  async remove(intentId: string): Promise<void> {
    const f = this.flights.get(intentId);
    if (!f) return;
    await disposeFlight(f);
    this.flights.delete(intentId);
  }

  all(): IntentFlight[] {
    return [...this.flights.values()];
  }
}
