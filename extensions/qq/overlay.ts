import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type DefaultTextStyle,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@mariozechner/pi-tui";
import { renderMarkdownLines } from "../shared/markdown.ts";

export type QqTranscriptEntry =
  | { id: number; type: "user"; text: string }
  | { id: number; type: "assistant"; text: string; streaming: boolean }
  | {
      id: number;
      type: "tool";
      toolCallId: string;
      toolName: string;
      args: string;
      status: "running" | "success" | "error";
      content?: string;
      truncated?: boolean;
    };

function buildBadge(
  theme: Theme,
  label: string,
  background: "userMessageBg" | "customMessageBg" | "toolPendingBg",
  foreground: "accent" | "success" | "warning" | "error",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

export function buildTranscriptLines(
  entries: QqTranscriptEntry[],
  theme: Theme,
  width: number,
): string[] {
  if (entries.length === 0) {
    return [
      theme.fg(
        "dim",
        "No QQ chat yet. Ask a quick question about the current repository.",
      ),
    ];
  }

  const lines: string[] = [];
  const userBadge = buildBadge(theme, "You", "userMessageBg", "accent");
  const toolBadge = buildBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildBadge(theme, "QQ", "customMessageBg", "success");
  const separator = theme.fg(
    "borderMuted",
    "────────────────────────────────────────",
  );
  const blockIndent = "    ";
  const resultIndent = blockIndent;
  const bodyWidth = Math.max(1, width - visibleWidth(blockIndent));

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: {
      blankBefore?: boolean;
      indent?: string;
      style?: (value: string) => string;
    } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  const pushMarkdownBlock = (
    header: string,
    markdown: string,
    options: {
      blankBefore?: boolean;
      defaultTextStyle?: DefaultTextStyle;
    } = {},
  ) => {
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of renderMarkdownLines(
      markdown,
      bodyWidth,
      theme,
      options.defaultTextStyle,
    )) {
      lines.push(`${blockIndent}${line}`);
    }
  };

  for (const entry of entries) {
    if (lines.length > 0 && entry.type === "user") {
      pushBlankLine();
      lines.push(separator);
    }

    if (entry.type === "user") {
      pushMarkdownBlock(userBadge, entry.text, {
        blankBefore: false,
        defaultTextStyle: {
          color: (value: string) => theme.fg("userMessageText", value),
        },
      });
      continue;
    }

    if (entry.type === "tool") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);

      if (entry.content) {
        const resultHeaderLabel =
          entry.status === "error"
            ? theme.fg("error", "↳ error")
            : entry.status === "running"
              ? theme.fg("warning", "↳ running")
              : theme.fg("dim", "↳ result");
        const truncationLabel = entry.truncated
          ? theme.fg("dim", " (truncated)")
          : "";
        pushStackedBlock(
          `${resultHeaderLabel}${truncationLabel}`,
          entry.content,
          {
            blankBefore: false,
            indent: resultIndent,
            style: (line) =>
              entry.status === "error"
                ? theme.fg("error", line)
                : theme.fg("dim", line),
          },
        );
      }
      continue;
    }

    const assistantHeader = entry.streaming
      ? `${assistantBadge} ${theme.fg("warning", "▍")}`
      : assistantBadge;
    pushMarkdownBlock(assistantHeader, entry.text || "(no text response)", {
      defaultTextStyle: {
        color: (value: string) => theme.fg("customMessageText", value),
      },
    });
  }

  return lines;
}

export class QqOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly readTranscriptEntries: () => QqTranscriptEntry[];
  private readonly getStatus: () => string | null;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private titleTextValue = "Quick Question";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintTextValue = "";
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    readTranscriptEntries: () => QqTranscriptEntry[],
    getStatus: () => string | null,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.refresh();
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg(
      "borderMuted",
      `${left}${"─".repeat(innerWidth)}${right}`,
    );
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
  }

  private wrapTranscript(lines: string[], innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of lines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const rows = this.tui.terminal.rows ?? 30;
    return Math.max(16, rows - 2);
  }

  private inputFrameLine(dialogWidth: number): string {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const previousFocused = this.input.focused;
    this.input.focused = false;
    try {
      const inputLine = this.input.render(targetWidth)[0] ?? "";
      return `${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.followTranscript = false;
      this.transcriptScrollOffset = Math.max(
        0,
        this.transcriptScrollOffset -
          Math.max(1, this.transcriptViewportHeight - 1),
      );
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.transcriptScrollOffset += Math.max(
        1,
        this.transcriptViewportHeight - 1,
      );
      this.tui.requestRender();
      return;
    }

    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(30, width);
    const innerWidth = Math.max(28, dialogWidth - 2);
    const transcriptSourceLines = buildTranscriptLines(
      this.readTranscriptEntries(),
      this.theme,
      innerWidth,
    );
    const transcriptLines = this.wrapTranscript(
      transcriptSourceLines,
      innerWidth,
    );
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = 7;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(
        0,
        Math.min(this.transcriptScrollOffset, maxScroll),
      );
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(
      0,
      transcriptHeight - visibleTranscript.length,
    );
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];
    lines.push(
      this.frameLine(
        this.theme.fg("accent", this.theme.bold(this.titleTextValue.trim())),
        innerWidth,
      ),
    );
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(
      this.frameLine(
        this.theme.fg("warning", this.statusTextValue.trim()),
        innerWidth,
      ),
    );
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(
      this.frameLine(
        this.theme.fg("dim", this.hintTextValue.trim()),
        innerWidth,
      ),
    );
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): QqTranscriptEntry[] {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    this.titleTextValue = "Quick Question · repo-aware side chat";
    const entries = this.readTranscriptEntries();
    const exchanges = entries.filter(
      (entry) => entry.type === "assistant" && !entry.streaming,
    ).length;
    const streaming = entries.some(
      (entry) => entry.type === "assistant" && entry.streaming,
    )
      ? " · streaming"
      : " · idle";
    this.summaryTextValue = `${exchanges} response${exchanges === 1 ? "" : "s"}${streaming}`;
    this.statusTextValue =
      this.getStatus() ??
      "Ask about the repo. Enter submits; Esc dismisses; /qq:clear resets.";
    this.hintTextValue = "Enter submit · Esc dismiss · PgUp/PgDn scroll";
    this.tui.requestRender();
  }
}
