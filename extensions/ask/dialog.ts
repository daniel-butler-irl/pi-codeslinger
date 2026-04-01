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

  function render(width: number): string[] {
    // stub — implemented in Task 2
    return [`ask dialog (${questions.length} questions)`];
  }

  function handleInput(data: string): void {
    // stub — implemented in Task 3
    if (matchesKey(data, Key.escape) && !state.inputMode) {
      done({ cancelled: true, reason: "User dismissed the question dialog" });
    }
  }

  return {
    render,
    handleInput,
    invalidate: () => { cachedLines = undefined; },
  };
}
