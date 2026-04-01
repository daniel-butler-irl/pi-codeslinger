import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

export type QuestionType = "single" | "multi" | "text";

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
}

export type AnswerValue = string | string[];

export interface DialogResult {
  cancelled: false;
  answers: Record<string, AnswerValue>;
}

export interface DialogCancelled {
  cancelled: true;
  reason: string;
}

export type DialogOutcome = DialogResult | DialogCancelled;

interface DialogState {
  currentQuestion: number;
  answers: Record<string, AnswerValue>;
  cursor: number;
  inputMode: boolean;
  inputBuffer: string;
}

export function createAskDialog(
  questions: Question[],
  tui: { requestRender(): void },
  theme: Theme,
  done: (result: DialogOutcome) => void,
): Component {
  const state: DialogState = {
    currentQuestion: 0,
    answers: Object.fromEntries(
      questions.map((q) => [q.id, q.type === "multi" ? [] : ""])
    ),
    cursor: 0,
    inputMode: false,
    inputBuffer: "",
  };

  let cachedLines: string[] | undefined;

  function refresh() {
    cachedLines = undefined;
    tui.requestRender();
  }

  function answeredCount(): number {
    return questions.filter((q) => {
      const a = state.answers[q.id];
      if (q.type === "multi") return (a as string[]).length > 0;
      return (a as string) !== "";
    }).length;
  }

  function renderTitleBar(width: number): string {
    const title = " Agent Questions";
    const counter = ` [${answeredCount()} of ${questions.length}]  ↔ `;
    const gap = width - 2 - visibleWidth(title) - visibleWidth(counter);
    const spacer = gap > 0 ? " ".repeat(gap) : "";
    return (
      theme.fg("borderAccent", "║") +
      theme.bold(theme.fg("text", title)) +
      spacer +
      theme.fg("muted", counter) +
      theme.fg("borderAccent", "║")
    );
  }

  function renderDivider(width: number): string {
    return (
      theme.fg("borderAccent", "╠") +
      theme.fg("border", "═".repeat(width - 2)) +
      theme.fg("borderAccent", "╣")
    );
  }

  function renderStatusBar(width: number): string {
    const q = questions[state.currentQuestion];
    let hints: string;
    if (state.inputMode) {
      hints = " type answer · esc cancel · enter confirm";
    } else if (q.type === "multi") {
      hints = " ↑↓ navigate · space toggle · enter custom · ← → cycle · enter to submit";
    } else {
      hints = " ↑↓ select · enter custom answer · ← → cycle questions · enter to confirm";
    }
    const inner = truncateToWidth(hints, width - 2);
    const pad = " ".repeat(Math.max(0, width - 2 - visibleWidth(inner)));
    return (
      theme.fg("borderAccent", "║") +
      theme.fg("dim", inner + pad) +
      theme.fg("borderAccent", "║")
    );
  }

  function renderOptions(q: Question, innerWidth: number): string[] {
    const lines: string[] = [];
    const opts = q.options ?? [];

    for (let i = 0; i < opts.length; i++) {
      const isSelected = (() => {
        if (q.type === "multi") return (state.answers[q.id] as string[]).includes(opts[i]);
        return state.answers[q.id] === opts[i];
      })();
      const isCursor = state.cursor === i;

      let indicator: string;
      if (q.type === "multi") {
        indicator = isSelected ? theme.fg("accent", "  ☑  ") : theme.fg("muted", "  ☐  ");
      } else {
        indicator = isSelected ? theme.fg("accent", "  ●  ") : theme.fg("muted", "  ○  ");
      }

      const label = truncateToWidth(opts[i], innerWidth - 6);
      const row = indicator + (isCursor ? theme.bold(theme.fg("text", label)) : theme.fg("text", label));
      const bg = isCursor && !state.inputMode ? theme.bg("selectedBg", row) : row;
      const padded = bg + " ".repeat(Math.max(0, innerWidth - 2 - visibleWidth(indicator) - visibleWidth(label)));
      lines.push(theme.fg("borderAccent", "║") + "  " + padded + theme.fg("borderAccent", "║"));
    }

    return lines;
  }

  function renderTextBox(innerWidth: number): string[] {
    const boxWidth = innerWidth - 4;
    const buf = state.inputMode
      ? truncateToWidth(state.inputBuffer + "█", boxWidth)
      : " ".repeat(boxWidth);
    const pad = " ".repeat(Math.max(0, boxWidth - visibleWidth(buf)));
    return [
      theme.fg("borderAccent", "║") + "  " + theme.fg("border", "┌" + "─".repeat(boxWidth) + "┐") + theme.fg("borderAccent", "║"),
      theme.fg("borderAccent", "║") + "  " + theme.fg("border", "│") + theme.fg("text", buf + pad) + theme.fg("border", "│") + theme.fg("borderAccent", "║"),
      theme.fg("borderAccent", "║") + "  " + theme.fg("border", "└" + "─".repeat(boxWidth) + "┘") + theme.fg("borderAccent", "║"),
    ];
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const q = questions[state.currentQuestion];
    const innerWidth = width - 2;
    const lines: string[] = [];

    // Top border
    lines.push(theme.fg("borderAccent", "╔" + "═".repeat(innerWidth) + "╗"));
    // Title bar
    lines.push(renderTitleBar(width));
    // Divider
    lines.push(renderDivider(width));
    // Empty line
    lines.push(theme.fg("borderAccent", "║") + " ".repeat(innerWidth) + theme.fg("borderAccent", "║"));
    // Question text
    const questionText = truncateToWidth("  " + q.text, innerWidth);
    const qPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(questionText)));
    lines.push(theme.fg("borderAccent", "║") + theme.bold(theme.fg("text", questionText + qPad)) + theme.fg("borderAccent", "║"));
    // Empty line
    lines.push(theme.fg("borderAccent", "║") + " ".repeat(innerWidth) + theme.fg("borderAccent", "║"));
    // Options
    lines.push(...renderOptions(q, innerWidth));
    // Empty line
    lines.push(theme.fg("borderAccent", "║") + " ".repeat(innerWidth) + theme.fg("borderAccent", "║"));
    // Text box
    lines.push(...renderTextBox(innerWidth));
    // Empty line
    lines.push(theme.fg("borderAccent", "║") + " ".repeat(innerWidth) + theme.fg("borderAccent", "║"));
    // Status bar divider
    lines.push(renderDivider(width));
    // Status bar
    lines.push(renderStatusBar(width));
    // Bottom border
    lines.push(theme.fg("borderAccent", "╚" + "═".repeat(innerWidth) + "╝"));

    cachedLines = lines;
    return lines;
  }

  function allAnswered(): boolean {
    return questions.every((q) => {
      const a = state.answers[q.id];
      if (q.type === "multi") return (a as string[]).length > 0;
      return (a as string) !== "";
    });
  }

  function handleInput(data: string): void {
    const q = questions[state.currentQuestion];

    // --- Text input mode ---
    if (state.inputMode) {
      if (matchesKey(data, Key.escape)) {
        state.inputMode = false;
        state.inputBuffer = "";
        refresh();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (state.inputBuffer.trim() !== "") {
          state.answers[q.id] = state.inputBuffer.trim();
          state.inputMode = false;
          state.inputBuffer = "";
          refresh();
        }
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        state.inputBuffer = state.inputBuffer.slice(0, -1);
        refresh();
        return;
      }
      // Printable character
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.inputBuffer += data;
        refresh();
      }
      return;
    }

    // --- Normal mode ---

    // Dismiss
    if (matchesKey(data, Key.escape)) {
      done({ cancelled: true, reason: "User dismissed the question dialog" });
      return;
    }

    // Cycle questions
    if (questions.length > 1) {
      if (matchesKey(data, Key.left)) {
        state.currentQuestion = (state.currentQuestion - 1 + questions.length) % questions.length;
        state.cursor = 0;
        refresh();
        return;
      }
      if (matchesKey(data, Key.right)) {
        state.currentQuestion = (state.currentQuestion + 1) % questions.length;
        state.cursor = 0;
        refresh();
        return;
      }
    }

    const opts = q.options ?? [];

    // Navigate options
    if (matchesKey(data, Key.up)) {
      if (opts.length > 0) {
        state.cursor = Math.max(0, state.cursor - 1);
        refresh();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (opts.length > 0) {
        state.cursor = Math.min(opts.length - 1, state.cursor + 1);
        refresh();
      }
      return;
    }

    // Toggle multi
    if (matchesKey(data, Key.space) && q.type === "multi" && opts.length > 0) {
      const current = state.answers[q.id] as string[];
      const opt = opts[state.cursor];
      if (current.includes(opt)) {
        state.answers[q.id] = current.filter((v) => v !== opt);
      } else {
        state.answers[q.id] = [...current, opt];
      }
      refresh();
      return;
    }

    // Enter — select (single), activate text input, or submit if all answered
    if (matchesKey(data, Key.enter)) {
      if (q.type === "single" && opts.length > 0 && state.cursor < opts.length) {
        state.answers[q.id] = opts[state.cursor];
        // Auto-advance to next unanswered question
        const nextUnanswered = questions.findIndex((qq, i) => {
          if (i <= state.currentQuestion) return false;
          const a = state.answers[qq.id];
          return qq.type === "multi" ? (a as string[]).length === 0 : (a as string) === "";
        });
        if (nextUnanswered !== -1) {
          state.currentQuestion = nextUnanswered;
          state.cursor = 0;
        }
        refresh();
        // Submit if all questions are now answered
        if (allAnswered()) {
          done({ cancelled: false, answers: state.answers });
        }
        return;
      }
      if (q.type === "text" || opts.length === 0) {
        state.inputMode = true;
        state.inputBuffer = typeof state.answers[q.id] === "string" ? (state.answers[q.id] as string) : "";
        refresh();
        return;
      }
      // All answered → submit
      if (allAnswered()) {
        done({ cancelled: false, answers: state.answers });
      }
      return;
    }
  }

  return {
    render,
    handleInput,
    invalidate: () => { cachedLines = undefined; },
  };
}
