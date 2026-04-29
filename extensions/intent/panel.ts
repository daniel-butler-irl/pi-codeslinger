/**
 * Intent sidebar panel component.
 *
 * Renders a full-height bordered box on the right of the terminal showing
 * the active intent's title, current phase, a breadcrumb to its root if it
 * has ancestors, and a short description excerpt. Mounted as a non-capturing
 * overlay so the rest of Pi's UI still receives input.
 */
import {
  type DefaultTextStyle,
  visibleWidth,
  type TUI,
} from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { AgentRole } from "../orchestrator/state.ts";
import { renderMarkdownLines } from "../shared/markdown.ts";
import type {
  IntentStore,
  IntentPhase,
  Intent,
  ReviewResult,
} from "./store.ts";
import { getActiveIntent, getRoot } from "./store.ts";
import { readActiveIntent } from "./active-local.ts";

function wordWrap(text: string, maxWidth: number): string[] {
  if (!text || maxWidth <= 0) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const w = word.slice(0, maxWidth);
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxWidth) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Human-facing label and theme color for each phase. Keeping the map in one
 * place so the panel is the only thing that decides what a phase looks like.
 */
const PHASE_DISPLAY: Record<IntentPhase, { label: string; color: ThemeColor }> =
  {
    defining: { label: "DEFINING", color: "warning" },
    implementing: { label: "IMPLEMENTING", color: "accent" },
    reviewing: { label: "REVIEWING", color: "accent" },
    "proposed-ready": { label: "SIGN-OFF NEEDED", color: "success" },
    done: { label: "DONE", color: "success" },
    "blocked-on-child": { label: "BLOCKED", color: "muted" },
  };

/**
 * Main workflow phases in linear order (excludes blocked-on-child and done).
 */
const WORKFLOW_PHASES: ReadonlyArray<IntentPhase> = [
  "defining",
  "implementing",
  "reviewing",
  "proposed-ready",
] as const;

/**
 * Calculate workflow completion percentage based on current phase.
 */
function getWorkflowProgress(phase: IntentPhase): number {
  if (phase === "done") return 100;
  const index = WORKFLOW_PHASES.indexOf(phase);
  if (index === -1) return 0; // blocked-on-child or unknown
  return Math.round(((index + 1) / (WORKFLOW_PHASES.length + 1)) * 100);
}

/**
 * Get next available actions based on current phase.
 */
function getNextActions(phase: IntentPhase): string[] {
  switch (phase) {
    case "defining":
      return ["Lock intent to start"];
    case "implementing":
      return ["Submit for review"];
    case "reviewing":
      return ["Reviewer running…"];
    case "proposed-ready":
      return ["Sign off (Ctrl+I) to complete"];
    case "done":
      return ["Complete"];
    case "blocked-on-child":
      return ["Complete child intent"];
    default:
      return [];
  }
}

export interface RunningAgent {
  intentId: string;
  intentTitle: string;
  role: AgentRole;
  status: string;
}

export function createIntentSidebar(
  store: IntentStore,
  tui: TUI,
  theme: Theme,
  cwd: string = process.cwd(),
) {
  let currentStore = store;
  let currentCwd = cwd;
  let shortDesc: string | null = null;
  let activePhase: IntentPhase | null = null;
  let understanding: string | null = null;
  let reviewResult: ReviewResult | null = null;
  let statusMessages: string[] = [];
  let runningAgents: RunningAgent[] = [];
  let selectedAgentIndex = -1;
  let onSelectAgent: ((intentId: string, role: AgentRole) => void) | null = null;

  const border = (s: string) => theme.fg("borderAccent", s);
  const dim = (s: string) => theme.fg("muted", s);
  const sectionTitle = (s: string) => theme.fg("accent", s);

  /**
   * Render a single line with borders and padding.
   * Text must already fit within the width - no truncation.
   */
  function contentLine(
    width: number,
    text: string,
    styleFn: (s: string) => string = (s) => s,
  ): string {
    const inner = width - 4; // 2 border chars + 2 padding
    const vw = visibleWidth(text);
    const pad = " ".repeat(Math.max(0, inner - vw));
    return border("│") + " " + styleFn(text) + pad + " " + border("│");
  }

  /**
   * Render text with word wrapping, returning multiple content lines.
   */
  function contentLines(
    width: number,
    text: string,
    styleFn: (s: string) => string = (s) => s,
  ): string[] {
    const inner = width - 4;
    const wrapped = wordWrap(text, inner);
    return wrapped.map((line) => contentLine(width, line, styleFn));
  }

  function contentMarkdownLines(
    width: number,
    text: string,
    defaultTextStyle?: DefaultTextStyle,
  ): string[] {
    const inner = width - 4;
    const rendered = renderMarkdownLines(text, inner, theme, defaultTextStyle);
    return rendered.map((line) => contentLine(width, line));
  }

  function emptyLine(width: number): string {
    return border("│") + " ".repeat(width - 2) + border("│");
  }

  function renderBadge(width: number, phase: IntentPhase): string {
    const { label, color } = PHASE_DISPLAY[phase];
    return contentLine(width, `[${label}]`, (s) => theme.fg(color, s));
  }

  function renderWorkflowIndicator(
    width: number,
    currentPhase: IntentPhase,
  ): string[] {
    const lines: string[] = [];

    // Build the visual flow: defining → implementing → reviewing
    const inner = width - 4;
    let flowLine = "";
    for (let i = 0; i < WORKFLOW_PHASES.length; i++) {
      const phase = WORKFLOW_PHASES[i];
      const isCurrent = phase === currentPhase;

      if (isCurrent) {
        flowLine += `[${phase.toUpperCase()}]`;
      } else {
        flowLine += phase;
      }

      if (i < WORKFLOW_PHASES.length - 1) {
        flowLine += " → ";
      }
    }

    // Word-wrap the flow line if it's too long
    const wrapped = wordWrap(flowLine, inner);
    for (const line of wrapped) {
      lines.push(contentLine(width, line, dim));
    }

    // Progress percentage
    const progress = getWorkflowProgress(currentPhase);
    lines.push(contentLine(width, `Progress: ${progress}%`, dim));

    // Next actions
    const actions = getNextActions(currentPhase);
    if (actions.length > 0) {
      lines.push(...contentLines(width, `Next: ${actions[0]}`, dim));
    }

    return lines;
  }

  return {
    render(width: number): string[] {
      const active = getActiveIntent(currentStore, currentCwd);
      const height = tui.terminal.rows;

      // Top border with embedded label: ╭─ Intent ──────╮
      const label = " Intent ";
      const fill = Math.max(0, width - 3 - visibleWidth(label));
      const lines: string[] = [
        border("╭") +
          border("─") +
          dim(label) +
          border("─".repeat(fill)) +
          border("╮"),
      ];

      if (!active) {
        lines.push(contentLine(width, "no intent set", dim));
      } else {
        // Breadcrumb if this intent is not top-level. Show the root title
        // dimmed so the user can tell they're deep in a tree of intents
        // without it visually competing with the active intent's title.
        if (active.parentId !== null) {
          const root = getRoot(currentStore, active.id);
          if (root && root.id !== active.id) {
            lines.push(
              ...contentMarkdownLines(width, "↱ " + root.title, {
                color: (value: string) => theme.fg("muted", value),
              }),
            );
          }
        }

        lines.push(
          ...contentMarkdownLines(width, active.title, {
            color: (value: string) => theme.fg("accent", value),
            bold: true,
          }),
        );

        if (activePhase) {
          lines.push(renderBadge(width, activePhase));
          lines.push(emptyLine(width));
          // Add workflow indicator
          if (activePhase !== "blocked-on-child" && activePhase !== "done") {
            lines.push(...renderWorkflowIndicator(width, activePhase));
          } else if (activePhase === "done") {
            lines.push(
              ...contentLines(width, "✓ Complete", (s) =>
                theme.fg("success", s),
              ),
            );
          }
        }

        if (shortDesc) {
          lines.push(emptyLine(width));
          lines.push(...contentMarkdownLines(width, shortDesc).slice(0, 5));
        }

        // Display understanding/next steps section
        if (understanding) {
          lines.push(emptyLine(width));
          lines.push(contentLine(width, "─ Understanding ─", sectionTitle));
          lines.push(...contentMarkdownLines(width, understanding).slice(0, 8));
        }

        // Live reviewer status (only while reviewing and no result yet).
        if (
          activePhase === "reviewing" &&
          !reviewResult &&
          statusMessages.length > 0
        ) {
          lines.push(emptyLine(width));
          lines.push(contentLine(width, "─ Reviewer ─", sectionTitle));
          for (const msg of statusMessages.slice(-3)) {
            lines.push(...contentLines(width, msg, dim));
          }
        }

        // Review result summary (replaces status once review is complete).
        if (reviewResult) {
          lines.push(emptyLine(width));
          const resultLabel =
            reviewResult.verdict === "pass"
              ? "─ Review: passed ─"
              : "─ Review: rework ─";
          const resultColor =
            reviewResult.verdict === "pass" ? "success" : "warning";
          lines.push(
            contentLine(width, resultLabel, (s) => theme.fg(resultColor, s)),
          );
          lines.push(
            ...contentMarkdownLines(width, reviewResult.summary).slice(0, 5),
          );
        }
      }

      // Running agents section (always visible if any agents active).
      if (runningAgents.length > 0) {
        lines.push(emptyLine(width));
        lines.push(contentLine(width, "─ Running Agents ─", sectionTitle));
        for (let i = 0; i < runningAgents.length; i++) {
          const agent = runningAgents[i];
          const label = `${agent.intentTitle} · ${agent.role}`;
          const isSelected = i === selectedAgentIndex;
          lines.push(
            ...contentLines(width, label, isSelected
              ? (s) => theme.fg("accent", s)
              : undefined),
          );
          lines.push(...contentLines(width, agent.status, dim));
        }
      }

      // Pad to terminal height, leaving room for hint and border.
      const targetHeight = Math.max(lines.length + 2, height - 2);
      while (lines.length < targetHeight) {
        lines.push(emptyLine(width));
      }

      // Hotkey hint at bottom
      lines.push(contentLine(width, "Ctrl+I to manage intents", dim));

      // Bottom border.
      lines.push(border("╰") + border("─".repeat(width - 2)) + border("╯"));

      return lines;
    },

    handleInput(data: string): void {
      if (runningAgents.length === 0) return;
      if (data === "\x1b[A") {
        // up arrow
        selectedAgentIndex =
          selectedAgentIndex <= 0
            ? runningAgents.length - 1
            : selectedAgentIndex - 1;
        tui.requestRender();
      } else if (data === "\x1b[B") {
        // down arrow
        selectedAgentIndex =
          selectedAgentIndex >= runningAgents.length - 1
            ? 0
            : selectedAgentIndex + 1;
        tui.requestRender();
      } else if (data === "\r" || data === "\n") {
        const agent = runningAgents[selectedAgentIndex];
        if (agent && onSelectAgent) {
          onSelectAgent(agent.intentId, agent.role);
        }
      }
    },

    invalidate(): void {},

    update(
      newStore: IntentStore,
      desc: string | null,
      phase?: IntentPhase | null,
      currentUnderstanding?: string | null,
      currentReviewResult?: ReviewResult | null,
      newCwd?: string,
    ): void {
      currentStore = newStore;
      if (newCwd) currentCwd = newCwd;
      shortDesc = desc;
      activePhase = phase ?? null;
      understanding = currentUnderstanding ?? null;
      reviewResult = currentReviewResult ?? null;
      // Clear live status messages when we leave the reviewing phase.
      if (phase !== "reviewing") {
        statusMessages = [];
      }
      tui.invalidate();
      tui.requestRender();
    },

    updateStatus(message: string): void {
      statusMessages = [...statusMessages, message].slice(-10);
      tui.invalidate();
      tui.requestRender();
    },

    updateAgents(agents: RunningAgent[]): void {
      runningAgents = agents;
      if (selectedAgentIndex >= agents.length) {
        selectedAgentIndex = agents.length > 0 ? 0 : -1;
      }
      tui.invalidate();
      tui.requestRender();
    },

    setOnSelectAgent(cb: ((intentId: string, role: AgentRole) => void) | null): void {
      onSelectAgent = cb;
    },
  };
}

// Re-export for test convenience.
export type { Intent };
