/**
 * Intent sidebar panel component.
 *
 * Renders a full-height bordered box showing the active intent title and
 * a short description excerpt. Mounted as a non-capturing overlay on the
 * right side of the terminal.
 */
import { visibleWidth, truncateToWidth, type TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { IntentStore } from "./store.ts";
import { getActiveIntent, loadIntentContent } from "./store.ts";

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

export function createIntentSidebar(
  store: IntentStore,
  tui: TUI,
  theme: Theme,
) {
  let currentStore = store;
  let shortDesc: string | null = null;

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

  return {
    render(width: number): string[] {
      const active = getActiveIntent(currentStore);
      const height = tui.terminal.rows;

      // Top border: ╭─ Intent ──────────╮
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
        lines.push(contentLine(width, active.title, titleFn));

        if (shortDesc) {
          lines.push(emptyLine(width));
          const inner = width - 4;
          for (const wl of wordWrap(shortDesc, inner).slice(0, 5)) {
            lines.push(contentLine(width, wl, dim));
          }
        }
      }

      // Pad with empty border lines to fill terminal height (minus bottom border)
      const targetHeight = Math.max(lines.length + 1, height - 1);
      while (lines.length < targetHeight) {
        lines.push(emptyLine(width));
      }

      // Bottom border: ╰──────────────────╯
      lines.push(border("╰") + border("─".repeat(width - 2)) + border("╯"));

      return lines;
    },

    handleInput(_data: string): void {},

    invalidate(): void {},

    update(newStore: IntentStore, desc: string | null): void {
      currentStore = newStore;
      shortDesc = desc;
      tui.invalidate();
      tui.requestRender();
    },
  };
}
