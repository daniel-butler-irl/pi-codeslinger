/**
 * Intent sidebar panel component.
 *
 * Renders a full-height bordered box on the right of the terminal showing
 * the active intent's title, current phase, a breadcrumb to its root if it
 * has ancestors, and a short description excerpt. Mounted as a non-capturing
 * overlay so the rest of Pi's UI still receives input.
 */
import { visibleWidth, truncateToWidth, type TUI } from "@mariozechner/pi-tui";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { IntentStore, IntentPhase, Intent } from "./store.ts";
import { getActiveIntent, getRoot } from "./store.ts";

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
    done: { label: "DONE", color: "success" },
    "blocked-on-child": { label: "BLOCKED", color: "dim" },
  };

export function createIntentSidebar(
  store: IntentStore,
  tui: TUI,
  theme: Theme,
) {
  let currentStore = store;
  let shortDesc: string | null = null;
  let activePhase: IntentPhase | null = null;

  const border = (s: string) => theme.fg("borderAccent", s);
  const titleFn = (s: string) => theme.bold(theme.fg("accent", s));
  const dim = (s: string) => theme.fg("dim", s);

  function contentLine(
    width: number,
    text: string,
    styleFn: (s: string) => string = (s) => s,
  ): string {
    const inner = width - 4; // 2 border chars + 2 padding
    const truncated = truncateToWidth(text, inner);
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
    return border("│") + " " + styleFn(truncated) + pad + " " + border("│");
  }

  function emptyLine(width: number): string {
    return border("│") + " ".repeat(width - 2) + border("│");
  }

  function renderBadge(width: number, phase: IntentPhase): string {
    const { label, color } = PHASE_DISPLAY[phase];
    return contentLine(width, `[${label}]`, (s) => theme.fg(color, s));
  }

  return {
    render(width: number): string[] {
      const active = getActiveIntent(currentStore);
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
            lines.push(contentLine(width, "↱ " + root.title, dim));
          }
        }

        lines.push(contentLine(width, active.title, titleFn));

        if (activePhase) {
          lines.push(renderBadge(width, activePhase));
        }

        if (shortDesc) {
          lines.push(emptyLine(width));
          const inner = width - 4;
          for (const wl of wordWrap(shortDesc, inner).slice(0, 5)) {
            lines.push(contentLine(width, wl, dim));
          }
        }
      }

      // Pad to terminal height.
      const targetHeight = Math.max(lines.length + 1, height - 1);
      while (lines.length < targetHeight) {
        lines.push(emptyLine(width));
      }

      // Bottom border.
      lines.push(border("╰") + border("─".repeat(width - 2)) + border("╯"));

      return lines;
    },

    handleInput(_data: string): void {},

    invalidate(): void {},

    update(
      newStore: IntentStore,
      desc: string | null,
      phase?: IntentPhase | null,
    ): void {
      currentStore = newStore;
      shortDesc = desc;
      activePhase = phase ?? null;
      tui.invalidate();
      tui.requestRender();
    },
  };
}

// Re-export for test convenience.
export type { Intent };
