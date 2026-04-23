/**
 * Orchestrator driver — turns intent phase events into subagent actions.
 *
 * Flow:
 *   1. intent:phase-changed fires (from the intent extension's events bus)
 *   2. Driver reads the new phase and decides what to dispatch
 *   3. Spawns/reuses the right subagent and prompts it with phase-appropriate
 *      instructions
 *   4. After the agent's turn finishes, reads flight.pendingSignal
 *   5. Routes the signal: proposal → transition phase / spawn reviewer /
 *      mark done; review → transition / rework; question → bubble to human
 *
 * Divergence guards live here: rework cap, question loop detection,
 * depth cap when child intents are spawned (once we add prereq cascade).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  loadStore,
  saveStore,
  transitionPhase,
  appendLogEntry,
  createIntent,
  getParent,
  intentContractPath,
  intentLogPath,
  intentVerificationPath,
  writeReviewResult,
  readReviewResult,
  type IntentStore,
  type Intent,
  type IntentPhase,
} from "../intent/store.ts";
import { FlightTable, type AgentRole, type IntentFlight } from "./state.ts";
import { dispatchAgent, type DispatchOptions } from "./dispatcher.ts";
import type { AgentDefinition } from "./agent-defs.ts";
import { runVerification } from "./verification.ts";

/** Dispatch function type. Pluggable so tests can substitute a mock. */
export type DispatchFn = (
  opts: DispatchOptions,
) => Promise<import("./state.ts").DispatchedAgentHandle>;

export interface DriverConfig {
  /** Limits on loops. Beyond these, escalate instead of continuing. */
  maxReworkPerIntent: number;
  /** Max depth of child-intent nesting. Beyond this, spawn_child fails. */
  maxChildIntentDepth: number;
}

export const DEFAULT_DRIVER_CONFIG: DriverConfig = {
  maxReworkPerIntent: 5,
  maxChildIntentDepth: 3,
};

/**
 * Map phase → role → agent-definition-name. The orchestrator uses this
 * lookup to pick which definition to dispatch for a given phase. Keeping
 * it as a plain object so the loadout can re-bind phase→agent without
 * touching the driver code (e.g. swap in a different reviewer definition).
 */
export interface AgentBinding {
  /** Definition name to dispatch when a phase needs an implementer. */
  implementer: string;
  /** Definition name to dispatch when a phase needs a reviewer. */
  reviewer: string;
}

export const DEFAULT_AGENT_BINDING: AgentBinding = {
  implementer: "intent-implementer",
  reviewer: "intent-reviewer",
};

export class OrchestratorDriver {
  private readonly flights = new FlightTable();
  private readonly pi: ExtensionAPI;
  private readonly cwd: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly agentDefs: Map<string, AgentDefinition>;
  private readonly config: DriverConfig;
  private readonly binding: AgentBinding;
  private readonly dispatch: DispatchFn;
  private unsubscribePhaseChange: (() => void) | null = null;
  private unsubscribeReviewSignal: (() => void) | null = null;
  private unsubscribeProposalSignal: (() => void) | null = null;
  private unsubscribeSpawnSignal: (() => void) | null = null;

  constructor(
    pi: ExtensionAPI,
    cwd: string,
    authStorage: AuthStorage,
    modelRegistry: ModelRegistry,
    agentDefs: Map<string, AgentDefinition>,
    config: DriverConfig = DEFAULT_DRIVER_CONFIG,
    binding: AgentBinding = DEFAULT_AGENT_BINDING,
    dispatch?: DispatchFn,
  ) {
    this.pi = pi;
    this.cwd = cwd;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.agentDefs = agentDefs;
    this.config = config;
    this.binding = binding;
    this.dispatch = dispatch ?? dispatchAgent;
  }

  /**
   * Wire up event subscriptions. Call once at session_start.
   */
  start(): void {
    this.unsubscribePhaseChange = this.pi.events.on(
      "intent:phase-changed",
      (payload: unknown) => {
        this.onPhaseChanged(payload as PhaseChangedPayload).catch((err) =>
          this.logDriverError(err),
        );
      },
    );
    this.unsubscribeReviewSignal = this.pi.events.on(
      "orchestrator:review-signal",
      (payload: unknown) => {
        this.onReviewSignal(payload as ReviewSignalPayload).catch((err) =>
          this.logDriverError(err),
        );
      },
    );
    this.unsubscribeProposalSignal = this.pi.events.on(
      "orchestrator:proposal-signal",
      (payload: unknown) => {
        this.onProposalSignal(payload as ProposalSignalPayload).catch((err) =>
          this.logDriverError(err),
        );
      },
    );
    this.unsubscribeSpawnSignal = this.pi.events.on(
      "orchestrator:spawn-signal",
      (payload: unknown) => {
        this.onSpawnSignal(payload as SpawnSignalPayload).catch((err) =>
          this.logDriverError(err),
        );
      },
    );
  }

  /**
   * Tear everything down (called on session shutdown or test cleanup).
   */
  async shutdown(): Promise<void> {
    if (this.unsubscribePhaseChange) {
      this.unsubscribePhaseChange();
      this.unsubscribePhaseChange = null;
    }
    if (this.unsubscribeReviewSignal) {
      this.unsubscribeReviewSignal();
      this.unsubscribeReviewSignal = null;
    }
    if (this.unsubscribeProposalSignal) {
      this.unsubscribeProposalSignal();
      this.unsubscribeProposalSignal = null;
    }
    if (this.unsubscribeSpawnSignal) {
      this.unsubscribeSpawnSignal();
      this.unsubscribeSpawnSignal = null;
    }

    // Dispose all active agents
    for (const flight of this.flights.all()) {
      await this.flights.remove(flight.intentId);
    }
  }

  // ── Phase-change handling ────────────────────────────────────────────

  private async onPhaseChanged(payload: PhaseChangedPayload): Promise<void> {
    const { id: intentId, to, from } = payload;
    // from === to means session_start re-emitted the same phase to resume
    // an in-progress intent. Use sendUserMessage (already in a session).
    // from !== to is a real phase transition — start a clean session.
    const isResume = from === to;
    const store = loadStore(this.cwd);
    const intent = store.intents.find((i) => i.id === intentId);
    if (!intent) return;

    if (to === "implementing") {
      await this.runImplementerLoop(store, intent, from, isResume);
    } else if (to === "reviewing") {
      await this.runReviewerLoop(store, intent, from, isResume);
    } else if (to === "done") {
      await this.flights.remove(intentId);
      await this.resumeParentIfBlocked(intent);
    }
  }

  /**
   * If a child intent just reached done, check whether its parent is
   * blocked-on-child and resume the parent. The parent returns to the
   * phase it was in when it blocked; for simplicity we always resume
   * to implementing (the only phase from which spawn_child is useful
   * today; if that changes, remember the resume phase explicitly).
   */
  private async resumeParentIfBlocked(child: Intent): Promise<void> {
    const store = loadStore(this.cwd);
    const parent = getParent(store, child.id);
    if (!parent) return;
    if (parent.phase !== "blocked-on-child") return;

    appendLogEntry(this.cwd, parent.id, {
      kind: "child-done",
      body: `Child intent "${child.title}" (${child.id}) reached done. Resuming implementation.`,
    });
    store.activeIntentId = parent.id;
    transitionPhase(store, parent.id, "implementing");
    saveStore(this.cwd, store);
    this.pi.events.emit("intent:phase-changed", {
      id: parent.id,
      from: "blocked-on-child",
      to: "implementing",
    } satisfies PhaseChangedPayload);
  }

  /**
   * Walk the parent chain to compute how many ancestors a given intent
   * has. Top-level intent returns 0.
   */
  private depthOf(store: IntentStore, intentId: string): number {
    let depth = 0;
    let cursor = store.intents.find((i) => i.id === intentId);
    while (cursor && cursor.parentId !== null) {
      depth += 1;
      cursor = store.intents.find((i) => i.id === cursor!.parentId);
    }
    return depth;
  }

  // ── Implementer loop ─────────────────────────────────────────────────

  private async runImplementerLoop(
    store: IntentStore,
    intent: Intent,
    from: IntentPhase,
    isResume = false,
  ): Promise<void> {
    const flight = this.flights.getOrCreate(intent.id);

    const defName = this.definitionNameFor("implementer");
    const def = this.agentDefs.get(defName);

    if (def?.provider && def?.model) {
      // Subagent path: dispatch a dedicated implementer agent.
      const impl = await this.ensureAgent(flight, "implementer");
      await impl.prompt(this.buildImplementerPrompt(intent, flight));
      await this.handleSignal(store, intent, flight);
    } else if (isResume || from === "reviewing") {
      // Two cases share this path:
      // 1. isResume=true: session_start re-dispatched after intent extension
      //    called ctx.newSession(); we're already in a fresh session.
      // 2. from="reviewing": rework after review — no new session is started
      //    (newSession is only available on ExtensionCommandContext, not on
      //    ExtensionAPI); implementing continues in the reviewing session with
      //    rework findings injected via buildImplementerPrompt.
      await this.pi.sendUserMessage(
        this.buildImplementerPrompt(intent, flight),
        { deliverAs: "followUp" },
      );
    }
    // else: initial lock/transition from user command — intent extension's
    // handleLock/handleTransition will call ctx.newSession(), which triggers
    // session_start, which re-emits { from: implementing, to: implementing }
    // and hits the isResume branch above. Nothing to do here.
  }

  private async onProposalSignal(
    payload: ProposalSignalPayload,
  ): Promise<void> {
    const store = loadStore(this.cwd);
    const intent = store.intents.find((i) => i.id === payload.intentId);
    if (!intent) return;

    const flight = this.flights.getOrCreate(payload.intentId);
    flight.pendingSignal = {
      kind: "proposal",
      agentRole: "implementer",
      intentId: payload.intentId,
      summary: payload.summary,
      artifacts: payload.artifacts,
      proposedAt: payload.proposedAt,
    };
    await this.handleSignal(store, intent, flight);
  }

  private async onSpawnSignal(payload: SpawnSignalPayload): Promise<void> {
    const store = loadStore(this.cwd);
    const intent = store.intents.find((i) => i.id === payload.intentId);
    if (!intent) return;

    const flight = this.flights.getOrCreate(payload.intentId);
    flight.pendingSignal = {
      kind: "spawn-child",
      agentRole: "implementer",
      parentIntentId: payload.intentId,
      description: payload.description,
      reason: payload.reason,
      requestedAt: payload.requestedAt,
    };
    await this.handleSignal(store, intent, flight);
  }

  private buildImplementerPrompt(intent: Intent, flight: IntentFlight): string {
    const contractPath = intentContractPath(this.cwd, intent.id);
    const logPath = intentLogPath(this.cwd, intent.id);

    // In-memory signal wins (subagent path or same-session rework loop).
    // On a fresh session restart (signal is null), fall back to the persisted
    // review result so rework findings survive the session boundary.
    const pendingReview =
      flight.pendingSignal?.kind === "review" ? flight.pendingSignal : null;
    const diskReview = !pendingReview
      ? readReviewResult(this.cwd, intent.id)
      : null;

    let reworkBlock = "";
    if (pendingReview?.verdict === "rework") {
      reworkBlock =
        `\n\nReview findings from the adversarial reviewer (address each):\n` +
        pendingReview.findings.map((f) => `- ${f}`).join("\n") +
        (pendingReview.nextActions.length
          ? `\n\nSuggested next actions:\n` +
            pendingReview.nextActions.map((a) => `- ${a}`).join("\n")
          : "");
    } else if (diskReview?.verdict === "rework") {
      reworkBlock =
        `\n\nThis is a rework. The previous review found:\n${diskReview.summary}` +
        (diskReview.findings?.length
          ? `\n\nSpecific findings to address:\n` +
            diskReview.findings.map((f) => `- ${f}`).join("\n")
          : "") +
        (diskReview.nextActions?.length
          ? `\n\nSuggested next actions:\n` +
            diskReview.nextActions.map((a) => `- ${a}`).join("\n")
          : "");
    }

    return [
      `You are the implementer for intent ${intent.id}.`,
      `The contract is at: ${contractPath}`,
      `The log is at: ${logPath}`,
      ``,
      `First, read the contract. Every change you make must serve the ` +
        `declared success criteria. Do not modify the contract — it is ` +
        `locked at the filesystem level; an attempt will fail with a clear ` +
        `error.`,
      ``,
      `Append discoveries and decisions to the log as you work. When you ` +
        `believe all success criteria are satisfied, call propose_done with ` +
        `a summary. Do not continue producing work after calling propose_done.`,
      reworkBlock,
    ].join("\n");
  }

  // ── Reviewer loop ────────────────────────────────────────────────────

  private async runReviewerLoop(
    store: IntentStore,
    intent: Intent,
    _from: IntentPhase,
    isResume = false,
  ): Promise<void> {
    const flight = this.flights.getOrCreate(intent.id);

    const intentId = intent.id;
    flight.onStatus = (message: string) => {
      this.pi.events.emit("orchestrator:reviewer-status", {
        intentId,
        message,
      });
    };

    const verif = runVerification(this.cwd, intent.id);
    appendLogEntry(this.cwd, intent.id, {
      kind: "verification",
      body: verif.passed
        ? "All verification commands passed."
        : "Verification failed. See verification.json.",
    });

    const defName = this.definitionNameFor("reviewer");
    const def = this.agentDefs.get(defName);

    if (def?.provider && def?.model) {
      // Subagent path: dispatch a dedicated reviewer agent.
      const reviewer = await this.ensureAgent(flight, "reviewer");
      await reviewer.prompt(this.buildReviewerPrompt(intent));
      await this.handleSignal(store, intent, flight);
    } else {
      // Main-chat path: reviewing always runs in the current session.
      // newSession is only available on ExtensionCommandContext (user-initiated
      // commands), not on ExtensionAPI, so the driver cannot start a new session.
      await this.pi.sendUserMessage(this.buildReviewerPrompt(intent), {
        deliverAs: isResume ? "followUp" : "followUp",
      });
    }
  }

  private async onReviewSignal(payload: ReviewSignalPayload): Promise<void> {
    const store = loadStore(this.cwd);
    const intent = store.intents.find((i) => i.id === payload.intentId);
    if (!intent) return;

    const flight = this.flights.getOrCreate(payload.intentId);
    flight.pendingSignal = {
      kind: "review",
      intentId: payload.intentId,
      verdict: payload.verdict,
      summary: payload.summary,
      findings: payload.findings,
      nextActions: payload.nextActions,
      reportedAt: payload.reportedAt,
    };
    await this.handleSignal(store, intent, flight);
  }

  private buildReviewerPrompt(intent: Intent): string {
    return [
      `You are the adversarial reviewer for intent ${intent.id}.`,
      `Contract: ${intentContractPath(this.cwd, intent.id)}`,
      `Log: ${intentLogPath(this.cwd, intent.id)}`,
      `Verification results: ${intentVerificationPath(this.cwd, intent.id)}`,
      ``,
      `Your job is to find what's broken, not to confirm it works. The ` +
        `implementer believes their work is complete. Assume they took ` +
        `shortcuts. Prove they didn't.`,
      ``,
      `Specifically watch for:`,
      `  - Deleted, skipped, or weakened tests`,
      `  - Shallow logic that satisfies tests without implementing intent`,
      `  - Hard-coded values where logic should exist`,
      `  - Residue: dead code, commented-out blocks, leftover TODOs`,
      `  - Success criteria silently dropped from the contract's expectations`,
      ``,
      `Read the contract, log, and verification results. Inspect the code ` +
        `that changed. When done, call report_review with verdict "pass" ` +
        `(only if you actively looked and found nothing) or "rework" ` +
        `(with concrete findings).`,
    ].join("\n");
  }

  // ── Signal routing ───────────────────────────────────────────────────

  private async handleSignal(
    store: IntentStore,
    intent: Intent,
    flight: IntentFlight,
  ): Promise<void> {
    const signal = flight.pendingSignal;
    flight.pendingSignal = null;
    if (!signal) return;

    if (signal.kind === "proposal") {
      // Implementer claims done → move to reviewing.
      appendLogEntry(this.cwd, intent.id, {
        kind: "proposal",
        body:
          `${signal.agentRole}: ${signal.summary}` +
          (signal.artifacts.length
            ? `\n\nArtefacts:\n` +
              signal.artifacts.map((a) => `- ${a}`).join("\n")
            : ""),
      });
      transitionPhase(store, intent.id, "reviewing");
      saveStore(this.cwd, store);
      this.pi.events.emit("intent:phase-changed", {
        id: intent.id,
        from: "implementing",
        to: "reviewing",
      } satisfies PhaseChangedPayload);
      return;
    }

    if (signal.kind === "review") {
      appendLogEntry(this.cwd, intent.id, {
        kind: "review",
        body:
          `verdict=${signal.verdict}\n\n` +
          signal.findings.map((f) => `- ${f}`).join("\n"),
      });
      if (signal.verdict === "pass") {
        writeReviewResult(this.cwd, intent.id, {
          verdict: "pass",
          summary: signal.summary,
          reviewedAt: signal.reportedAt,
        });
        transitionPhase(store, intent.id, "proposed-ready");
        saveStore(this.cwd, store);
        this.pi.events.emit("intent:phase-changed", {
          id: intent.id,
          from: "reviewing",
          to: "proposed-ready",
        } satisfies PhaseChangedPayload);
        return;
      }

      // Persist findings so they survive the session restart when the
      // implementer gets a fresh session for rework.
      writeReviewResult(this.cwd, intent.id, {
        verdict: "rework",
        summary: signal.summary,
        findings: signal.findings,
        nextActions: signal.nextActions,
        reviewedAt: signal.reportedAt,
      });

      // Rework: cap check, then send back to implementer.
      if (intent.reworkCount >= this.config.maxReworkPerIntent) {
        appendLogEntry(this.cwd, intent.id, {
          kind: "escalation",
          body:
            `Rework cap (${this.config.maxReworkPerIntent}) reached. ` +
            `Pausing for human decision. Most recent findings:\n` +
            signal.findings.map((f) => `- ${f}`).join("\n"),
        });
        // Move back to implementing so the sidebar reflects "stuck in
        // implementing" rather than "mid-review". No event is emitted so
        // the driver does not re-dispatch; the flight is idle until the
        // human intervenes via /intent.
        transitionPhase(store, intent.id, "implementing");
        saveStore(this.cwd, store);
        return;
      }
      intent.reworkCount += 1;
      intent.updatedAt = Date.now();
      // Save the incremented rework count and stash the findings on the
      // flight so the next implementer turn sees them in its prompt.
      flight.pendingSignal = signal;
      transitionPhase(store, intent.id, "implementing");
      saveStore(this.cwd, store);
      this.pi.events.emit("intent:phase-changed", {
        id: intent.id,
        from: "reviewing",
        to: "implementing",
      } satisfies PhaseChangedPayload);
      return;
    }

    if (signal.kind === "question") {
      // For now, questions bubble to the log and pause the flight. Wiring
      // them through the ask extension is a later refinement.
      appendLogEntry(this.cwd, intent.id, {
        kind: "question",
        body:
          `From ${signal.agentRole}: ${signal.question}` +
          (signal.context ? `\n\nContext:\n${signal.context}` : ""),
      });
      return;
    }

    if (signal.kind === "spawn-child") {
      const depth = this.depthOf(store, intent.id);
      if (depth >= this.config.maxChildIntentDepth) {
        appendLogEntry(this.cwd, intent.id, {
          kind: "escalation",
          body:
            `Child intent requested but depth cap (${this.config.maxChildIntentDepth}) ` +
            `would be exceeded. Prerequisite: ${signal.description}\n\n` +
            `Reason: ${signal.reason}`,
        });
        return;
      }

      // Pause this intent's current flight and create the child.
      appendLogEntry(this.cwd, intent.id, {
        kind: "spawn-child",
        body:
          `Pausing for prerequisite.\n\n` +
          `Description: ${signal.description}\n\n` +
          `Reason: ${signal.reason}`,
      });
      transitionPhase(store, intent.id, "blocked-on-child");
      const child = createIntent(store, this.cwd, signal.description, {
        parentId: intent.id,
      });
      // createIntent already sets activeIntentId to the child.
      saveStore(this.cwd, store);

      // Dispose the parent's agents so their sessions don't hold stale
      // state through the child's run. They'll be respawned fresh when
      // the parent resumes.
      await this.flights.remove(intent.id);

      this.pi.events.emit("intent:phase-changed", {
        id: intent.id,
        from: "implementing",
        to: "blocked-on-child",
      } satisfies PhaseChangedPayload);
      this.pi.events.emit("intent:created", { id: child.id });
      // Child starts in defining; nothing to auto-dispatch. The user
      // will collaborate on the child's contract, then lock it, at
      // which point the normal implementing/reviewing flow runs for
      // the child just like any top-level intent.
      return;
    }
  }

  // ── Agent lifecycle ──────────────────────────────────────────────────

  private async ensureAgent(flight: IntentFlight, role: AgentRole) {
    const existing = flight.agents[role];
    if (existing) return existing;

    const defName = this.definitionNameFor(role);
    const def = this.agentDefs.get(defName);
    if (!def) {
      throw new Error(
        `No agent definition named "${defName}" loaded. Expected it for role ${role}.`,
      );
    }

    const handle = await this.dispatch({
      cwd: this.cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      flight,
      role,
      definition: def,
    });
    flight.agents[role] = handle;
    return handle;
  }

  private definitionNameFor(role: AgentRole): string {
    switch (role) {
      case "implementer":
        return this.binding.implementer;
      case "reviewer":
        return this.binding.reviewer;
      default:
        throw new Error(`No binding configured for role ${role}.`);
    }
  }

  private logDriverError(err: unknown): void {
    // Driver errors should never kill the host session. Log and move on.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[orchestrator] ${msg}\n`);
  }
}

interface PhaseChangedPayload {
  id: string;
  from: IntentPhase;
  to: IntentPhase;
}

interface ReviewSignalPayload {
  intentId: string;
  verdict: "pass" | "rework";
  summary: string;
  findings: string[];
  nextActions: string[];
  reportedAt: string;
}

interface ProposalSignalPayload {
  intentId: string;
  summary: string;
  artifacts: string[];
  proposedAt: string;
}

interface SpawnSignalPayload {
  intentId: string;
  description: string;
  reason: string;
  requestedAt: string;
}
