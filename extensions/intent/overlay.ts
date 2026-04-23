/**
 * Intent management overlay UI - centered modal dialog.
 *
 * Provides a popup dialog for creating and switching intents.
 */
import { matchesKey, visibleWidth, type Focusable } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { IntentStore, Intent, IntentPhase } from "./store.ts";
import {
  loadIntentContent,
  readUnderstanding,
  canTransition,
} from "./store.ts";
import { generateTitle, generateFallbackTitle } from "./title-generator.ts";

export type OverlayAction =
  | { type: "create"; description: string; title?: string }
  | { type: "switch"; intentId: string }
  | { type: "edit"; intentId: string }
  | { type: "lock"; intentId: string }
  | { type: "transition"; intentId: string; toPhase: IntentPhase }
  | { type: "review"; intentId: string }
  | { type: "delete"; intentId: string }
  | { type: "cancel" };

type OverlayMode = "menu" | "create" | "list" | "generating";

interface CreateState {
  mode: "create";
  text: string;
  cursor: number;
  scroll: number; // Horizontal scroll for long text
}

interface ListState {
  mode: "list";
  selected: number;
}

interface DetailState {
  mode: "detail";
  intentId: string;
  scroll: number; // For scrolling through long content
  showActions: boolean; // Whether to show action menu
  selectedAction: number; // Selected action in menu
}

interface GeneratingState {
  mode: "generating";
  description: string;
  status: string;
}

interface MenuState {
  mode: "menu";
  selected: number;
}

type OverlayState =
  | MenuState
  | CreateState
  | ListState
  | DetailState
  | GeneratingState;

export class IntentOverlayComponent implements Focusable {
  readonly width = 70;
  focused = false;

  private state: OverlayState;
  private menuItems: string[] = [];
  private abortController: AbortController | null = null;
  private cwd: string;
  private store: IntentStore;
  private theme: Theme;
  private done: (result: OverlayAction) => void;

  constructor(
    store: IntentStore,
    theme: Theme,
    done: (result: OverlayAction) => void,
    cwd: string,
  ) {
    this.store = store;
    this.theme = theme;
    this.done = done;
    this.cwd = cwd;
    // Build menu items - include actions for active intent directly in menu
    this.menuItems = [];

    const active = store.intents.find((i) => i.id === store.activeIntentId);
    if (active) {
      // Add phase-specific actions for active intent
      const actions = this.getAvailableActions(active);
      this.menuItems.push(...actions);

      // Add separator
      if (actions.length > 0) {
        this.menuItems.push("───────────────────");
      }
    }

    this.menuItems.push("Create new intent");
    if (this.store.intents.length > 0) {
      this.menuItems.push("List intents");
    }
    this.menuItems.push("Cancel");

    this.state = { mode: "menu", selected: 0 };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.state.mode === "menu") {
        this.done({ type: "cancel" });
      } else if (this.state.mode === "generating") {
        // Can't cancel while generating
        return;
      } else if (this.state.mode === "detail") {
        // Go back to list
        this.state = { mode: "list", selected: 0 };
      } else {
        // Go back to menu
        this.state = { mode: "menu", selected: 0 };
      }
      return;
    }

    if (this.state.mode === "menu") {
      this.handleMenuInput(data);
    } else if (this.state.mode === "create") {
      this.handleCreateInput(data);
    } else if (this.state.mode === "list") {
      this.handleListInput(data);
    } else if (this.state.mode === "detail") {
      this.handleDetailInput(data);
    }
  }

  private handleMenuInput(data: string): void {
    if (this.state.mode !== "menu") return;

    if (matchesKey(data, "up")) {
      this.state.selected = Math.max(0, this.state.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.state.selected = Math.min(
        this.menuItems.length - 1,
        this.state.selected + 1,
      );
    } else if (matchesKey(data, "return")) {
      const selected = this.menuItems[this.state.selected];

      // Skip separator lines
      if (selected.startsWith("─")) {
        return;
      }

      // Handle general actions
      if (selected === "Create new intent") {
        this.state = { mode: "create", text: "", cursor: 0, scroll: 0 };
      } else if (selected === "List intents") {
        this.state = { mode: "list", selected: 0 };
      } else if (selected === "Cancel") {
        this.done({ type: "cancel" });
      } else {
        // Must be an action for the active intent
        const active = this.store.intents.find(
          (i) => i.id === this.store.activeIntentId,
        );
        if (active) {
          this.executeAction(selected, active);
        }
      }
    }
  }

  private handleCreateInput(data: string): void {
    if (this.state.mode !== "create") return;

    if (matchesKey(data, "return")) {
      const text = this.state.text.trim();
      if (!text) {
        this.done({ type: "cancel" });
        return;
      }

      // Switch to generating mode
      this.state = {
        mode: "generating",
        description: text,
        status: "Generating title...",
      };

      // Generate title asynchronously
      this.generateTitleAsync(text);
      return;
    }

    // Shift+Enter inserts a newline
    if (matchesKey(data, "shift+return")) {
      this.state.text =
        this.state.text.slice(0, this.state.cursor) +
        "\n" +
        this.state.text.slice(this.state.cursor);
      this.state.cursor++;
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.state.cursor > 0) {
        this.state.text =
          this.state.text.slice(0, this.state.cursor - 1) +
          this.state.text.slice(this.state.cursor);
        this.state.cursor--;
      }
    } else if (matchesKey(data, "left")) {
      this.state.cursor = Math.max(0, this.state.cursor - 1);
    } else if (matchesKey(data, "right")) {
      this.state.cursor = Math.min(
        this.state.text.length,
        this.state.cursor + 1,
      );
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.state.text =
        this.state.text.slice(0, this.state.cursor) +
        data +
        this.state.text.slice(this.state.cursor);
      this.state.cursor++;
    }
  }

  private handleListInput(data: string): void {
    if (this.state.mode !== "list") return;

    const intents = this.store.intents;
    if (intents.length === 0) {
      this.state = { mode: "menu", selected: 0 };
      return;
    }

    if (matchesKey(data, "up")) {
      this.state.selected = Math.max(0, this.state.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.state.selected = Math.min(
        intents.length - 1,
        this.state.selected + 1,
      );
    } else if (matchesKey(data, "return")) {
      const intent = intents[this.state.selected];
      if (intent) {
        this.done({ type: "switch", intentId: intent.id });
      }
    } else if (data === "d" || data === " ") {
      // Show detail view
      const intent = intents[this.state.selected];
      if (intent) {
        this.state = {
          mode: "detail",
          intentId: intent.id,
          scroll: 0,
          showActions: false,
          selectedAction: 0,
        };
      }
    }
  }

  private async generateTitleAsync(description: string): Promise<void> {
    this.abortController = new AbortController();

    try {
      const result = await generateTitle(
        description,
        this.abortController.signal,
      );
      const title = result.title || generateFallbackTitle(description);

      // Complete the creation with the generated title
      this.done({ type: "create", description, title });
    } catch (error) {
      // If title generation fails, fall back to no title (will be generated later)
      this.done({ type: "create", description });
    }
  }

  private handleDetailInput(data: string): void {
    // In detail view, allow scrolling with up/down and page up/down, or 'a' for actions
    if (this.state.mode !== "detail") return;

    const intent = this.store.intents.find(
      (i) => i.id === (this.state as DetailState).intentId,
    );
    if (!intent) return;

    // 'a' key toggles action menu
    if (data === "a") {
      this.state.showActions = !this.state.showActions;
      if (this.state.showActions) {
        this.state.selectedAction = 0;
      }
      return;
    }

    if (this.state.showActions) {
      // Action menu is open - navigate and select
      const actions = this.getAvailableActions(intent);

      if (matchesKey(data, "up")) {
        this.state.selectedAction = Math.max(0, this.state.selectedAction - 1);
      } else if (matchesKey(data, "down")) {
        this.state.selectedAction = Math.min(
          actions.length - 1,
          this.state.selectedAction + 1,
        );
      } else if (matchesKey(data, "return")) {
        const action = actions[this.state.selectedAction];
        this.executeAction(action, intent);
      }
    } else {
      // Normal scrolling
      if (matchesKey(data, "up") || data === "k") {
        this.state.scroll = Math.max(0, this.state.scroll - 1);
      } else if (matchesKey(data, "down") || data === "j") {
        this.state.scroll = this.state.scroll + 1; // Will be clamped in render
      } else if (matchesKey(data, "pageUp")) {
        this.state.scroll = Math.max(0, this.state.scroll - 10);
      } else if (matchesKey(data, "pageDown")) {
        this.state.scroll = this.state.scroll + 10;
      }
    }
  }

  private getAvailableActions(intent: Intent): string[] {
    const actions: string[] = [];

    // Always allow switching if not active
    if (intent.id !== this.store.activeIntentId) {
      actions.push("Switch to this intent");
    }

    // Phase-specific actions
    if (intent.phase === "defining") {
      actions.push("Edit intent");
      actions.push("Lock (start implementing)");
    } else if (intent.phase === "implementing") {
      actions.push("Submit for review");
      actions.push("Mark as complete (skip review)");
    } else if (intent.phase === "reviewing") {
      actions.push("Review");
      actions.push("Send back for rework");
    } else if (intent.phase === "proposed-ready") {
      actions.push("Sign off (mark done)");
      actions.push("Send back for rework");
    }

    // Always allow delete
    actions.push("Delete intent");

    return actions;
  }

  private executeAction(action: string, intent: Intent): void {
    if (action === "Switch to this intent") {
      this.done({ type: "switch", intentId: intent.id });
    } else if (action === "Edit intent") {
      this.done({ type: "edit", intentId: intent.id });
    } else if (action === "Lock (start implementing)") {
      this.done({ type: "lock", intentId: intent.id });
    } else if (action === "Submit for review") {
      this.done({
        type: "transition",
        intentId: intent.id,
        toPhase: "reviewing",
      });
    } else if (action === "Review") {
      this.done({ type: "review", intentId: intent.id });
    } else if (action === "Mark as complete (skip review)") {
      this.done({ type: "transition", intentId: intent.id, toPhase: "done" });
    } else if (action === "Sign off (mark done)") {
      this.done({ type: "transition", intentId: intent.id, toPhase: "done" });
    } else if (action === "Send back for rework") {
      this.done({
        type: "transition",
        intentId: intent.id,
        toPhase: "implementing",
      });
    } else if (action === "Delete intent") {
      this.done({ type: "delete", intentId: intent.id });
    }
  }

  render(_width: number): string[] {
    const w = this.width;
    const th = this.theme;
    const innerW = w - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) =>
      th.fg("borderAccent", "│") +
      pad(content, innerW) +
      th.fg("borderAccent", "│");

    // Title based on mode
    let title = "Intent Manager";
    if (this.state.mode === "create") title = "Create Intent";
    else if (this.state.mode === "list") title = "Switch Intent";
    else if (this.state.mode === "detail") title = "Intent Details";
    else if (this.state.mode === "generating") title = "Generating...";

    lines.push(th.fg("borderAccent", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", th.bold(title))}`));
    lines.push(row(""));

    if (this.state.mode === "menu") {
      this.renderMenu(lines, row);
    } else if (this.state.mode === "create") {
      this.renderCreate(lines, row);
    } else if (this.state.mode === "list") {
      this.renderList(lines, row);
    } else if (this.state.mode === "detail") {
      this.renderDetail(lines, row);
    } else if (this.state.mode === "generating") {
      this.renderGenerating(lines, row);
    }

    lines.push(th.fg("borderAccent", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private renderMenu(lines: string[], row: (s: string) => string): void {
    if (this.state.mode !== "menu") return;

    for (let i = 0; i < this.menuItems.length; i++) {
      const item = this.menuItems[i];
      const isSelected = i === this.state.selected;

      // Render separator lines differently
      if (item.startsWith("─")) {
        lines.push(row(` ${this.theme.fg("dim", item)}`));
      } else {
        const prefix = isSelected ? " ▶ " : "   ";
        const text = isSelected
          ? this.theme.fg("accent", item)
          : this.theme.fg("text", item);
        lines.push(row(prefix + text));
      }
    }

    lines.push(row(""));
    lines.push(
      row(
        ` ${this.theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel")}`,
      ),
    );
  }

  private renderCreate(lines: string[], row: (s: string) => string): void {
    if (this.state.mode !== "create") return;

    lines.push(row(` ${this.theme.fg("muted", "Describe your intent:")}`));
    lines.push(row(""));

    // Calculate visible window for text (width - padding - borders)
    const maxWidth = this.width - 6;
    const text = this.state.text;

    if (text) {
      // First split by explicit newlines, then wrap each line
      const explicitLines = text.split("\n");
      const wrappedLines: string[] = [];
      const lineBreaks: number[] = []; // Track where explicit line breaks are

      for (const explicitLine of explicitLines) {
        if (explicitLine.length === 0) {
          wrappedLines.push("");
          lineBreaks.push(wrappedLines.length - 1);
        } else {
          // Wrap this line at maxWidth
          for (let i = 0; i < explicitLine.length; i += maxWidth) {
            wrappedLines.push(explicitLine.slice(i, i + maxWidth));
          }
          lineBreaks.push(wrappedLines.length - 1);
        }
      }

      // Determine which line contains the cursor
      let cursorLine = 0;
      let charsSoFar = 0;

      for (let i = 0; i < wrappedLines.length; i++) {
        const lineLen = wrappedLines[i].length;
        const isLineBreak = lineBreaks.includes(i);

        if (charsSoFar + lineLen >= this.state.cursor) {
          cursorLine = i;
          break;
        }
        charsSoFar += lineLen;
        if (isLineBreak) charsSoFar++; // Account for the \n character
      }

      const cursorPosInLine = this.state.cursor - charsSoFar;

      // Show lines around the cursor (up to 5 lines visible)
      const startLine = Math.max(0, cursorLine - 2);
      const endLine = Math.min(wrappedLines.length, startLine + 5);

      for (let i = startLine; i < endLine; i++) {
        const line = wrappedLines[i];

        if (i === cursorLine) {
          // This line has the cursor
          const before = line.slice(0, cursorPosInLine);
          const cursorChar =
            cursorPosInLine < line.length ? line[cursorPosInLine] : " ";
          const after = line.slice(cursorPosInLine + 1);
          const withCursor = `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
          lines.push(row(` ${withCursor}`));
        } else {
          lines.push(row(` ${line || " "}`)); // Show space for empty lines
        }
      }

      if (endLine < wrappedLines.length) {
        const hiddenLines = wrappedLines.length - endLine;
        lines.push(
          row(
            ` ${this.theme.fg("dim", `... +${hiddenLines} more line${hiddenLines > 1 ? "s" : ""}`)}`,
          ),
        );
      }
      if (startLine > 0) {
        lines.push(
          row(
            ` ${this.theme.fg("dim", `(${startLine} line${startLine > 1 ? "s" : ""} above)`)}`,
          ),
        );
      }
    } else {
      lines.push(
        row(
          ` ${this.theme.fg("dim", "e.g., Fix the auth bug in the login flow")}`,
        ),
      );
    }

    lines.push(row(""));
    const charCount = text.length;
    const lineInfo = charCount > 0 ? ` (${charCount} chars)` : "";
    lines.push(
      row(
        ` ${this.theme.fg("dim", `Enter submit • Shift+Enter new line • Esc cancel${lineInfo}`)}`,
      ),
    );
  }

  private renderList(lines: string[], row: (s: string) => string): void {
    if (this.state.mode !== "list") return;

    const intents = this.store.intents;

    if (intents.length === 0) {
      lines.push(row(` ${this.theme.fg("dim", "No intents yet")}`));
      lines.push(row(""));
      lines.push(row(` ${this.theme.fg("dim", "Esc to go back")}`));
      return;
    }

    // Show each intent with phase and active marker
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      const isSelected = i === this.state.selected;
      const isActive = intent.id === this.store.activeIntentId;
      const prefix = isSelected ? " ▶ " : "   ";

      // Format: Title [PHASE] [ACTIVE]
      const phaseLabel = `[${intent.phase.toUpperCase()}]`;
      const activeLabel = isActive ? " [ACTIVE]" : "";
      const fullText = `${intent.title} ${this.theme.fg("dim", phaseLabel)}${activeLabel}`;

      const text = isSelected
        ? this.theme.fg("accent", fullText)
        : this.theme.fg("text", fullText);
      lines.push(row(prefix + text));
    }

    lines.push(row(""));
    lines.push(
      row(
        ` ${this.theme.fg("dim", "↑↓ navigate • d/Space details • Enter switch • Esc back")}`,
      ),
    );
  }

  private renderGenerating(lines: string[], row: (s: string) => string): void {
    if (this.state.mode !== "generating") return;

    lines.push(row(` ${this.theme.fg("accent", this.state.status)}`));
    lines.push(row(""));
    lines.push(row(` ${this.theme.fg("dim", "Please wait...")}`));
    lines.push(row(""));
  }

  private renderDetail(lines: string[], row: (s: string) => string): void {
    if (this.state.mode !== "detail") return;

    const detailState = this.state as DetailState;
    const intent = this.store.intents.find(
      (i) => i.id === detailState.intentId,
    );
    if (!intent) {
      lines.push(row(` ${this.theme.fg("error", "Intent not found")}`));
      lines.push(row(""));
      return;
    }

    // Build all content lines first, then window them for scrolling
    const allLines: string[] = [];
    const isActive = intent.id === this.store.activeIntentId;
    const activeLabel = isActive ? " [ACTIVE]" : "";

    // Header: Title and status
    allLines.push(
      ` ${this.theme.fg("accent", this.theme.bold(intent.title + activeLabel))}`,
    );
    allLines.push(
      ` ${this.theme.fg("dim", `Phase: ${intent.phase.toUpperCase()}`)}`,
    );
    allLines.push(
      ` ${this.theme.fg("dim", `Rework count: ${intent.reworkCount}`)}`,
    );

    // Dates
    const created = new Date(intent.createdAt).toLocaleDateString();
    const updated = new Date(intent.updatedAt).toLocaleDateString();
    allLines.push(` ${this.theme.fg("dim", `Created: ${created}`)}`);
    if (created !== updated) {
      allLines.push(` ${this.theme.fg("dim", `Updated: ${updated}`)}`);
    }

    allLines.push("");

    // Load and show description from intent.md
    try {
      const content = loadIntentContent(this.cwd, intent.id);
      if (content) {
        allLines.push(` ${this.theme.fg("accent", "─── Description ───")}`);

        // Extract first section (Description) - up to first ## heading
        const lines = content.split("\n");
        let inDescription = false;
        let descLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("## Description")) {
            inDescription = true;
            continue;
          }
          if (inDescription && line.startsWith("##")) {
            break;
          }
          if (inDescription && line.trim()) {
            descLines.push(line);
          }
        }

        // Word wrap and add description lines
        for (const line of descLines.slice(0, 5)) {
          // Limit to first 5 lines
          const wrapped = this.wordWrap(line.trim(), this.width - 6);
          for (const wl of wrapped) {
            allLines.push(` ${this.theme.fg("text", wl)}`);
          }
        }

        if (descLines.length > 5) {
          allLines.push(` ${this.theme.fg("dim", "...")}`);
        }
        allLines.push("");
      }
    } catch {
      // Ignore if can't load
    }

    // Load and show understanding
    try {
      const understanding = readUnderstanding(this.cwd, intent.id);
      if (understanding) {
        allLines.push(` ${this.theme.fg("accent", "─── Understanding ───")}`);

        // Show first few lines of understanding
        const lines = understanding.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(0, 8)) {
          const wrapped = this.wordWrap(line.trim(), this.width - 6);
          for (const wl of wrapped) {
            allLines.push(` ${this.theme.fg("text", wl)}`);
          }
        }

        if (lines.length > 8) {
          allLines.push(` ${this.theme.fg("dim", "...")}`);
        }
        allLines.push("");
      }
    } catch {
      // Ignore if can't load
    }

    // Calculate visible window (leave room for borders and hint)
    const maxVisibleLines = 15;
    const startIdx = Math.max(
      0,
      Math.min(this.state.scroll, allLines.length - maxVisibleLines),
    );
    const endIdx = Math.min(allLines.length, startIdx + maxVisibleLines);
    const visibleLines = allLines.slice(startIdx, endIdx);

    // Clamp scroll to valid range
    if (this.state.scroll > Math.max(0, allLines.length - maxVisibleLines)) {
      this.state.scroll = Math.max(0, allLines.length - maxVisibleLines);
    }

    // Render visible lines
    for (const line of visibleLines) {
      lines.push(row(line));
    }

    // Show scroll indicator if there's more content
    const hasMore = endIdx < allLines.length;
    const hasPrev = startIdx > 0;

    if (hasMore || hasPrev) {
      const scrollInfo = `[${startIdx + 1}-${endIdx}/${allLines.length}]`;
      lines.push(row(` ${this.theme.fg("dim", scrollInfo)}`));
    }

    lines.push(row(""));

    // Show action menu if toggled
    if (this.state.showActions) {
      const actions = this.getAvailableActions(intent);
      lines.push(row(` ${this.theme.fg("accent", "─── Actions ───")}`));
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const prefix = i === this.state.selectedAction ? " ▶ " : "   ";
        const text =
          i === this.state.selectedAction
            ? this.theme.fg("accent", action)
            : this.theme.fg("text", action);
        lines.push(row(prefix + text));
      }
      lines.push(row(""));
      lines.push(
        row(
          ` ${this.theme.fg("dim", "↑↓ navigate • Enter select • a close menu • Esc back")}`,
        ),
      );
    } else {
      lines.push(
        row(
          ` ${this.theme.fg("dim", "↑↓/j/k scroll • PgUp/PgDn page • a actions • Esc back")}`,
        ),
      );
    }
  }

  private wordWrap(text: string, maxWidth: number): string[] {
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

  invalidate(): void {}

  dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
