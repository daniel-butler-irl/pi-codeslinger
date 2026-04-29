/**
 * Live subagent transcript overlay.
 *
 * Renders the transcript of a running subagent and provides a steering
 * input box. Modeled after extensions/qq/overlay.ts. Closing hides the
 * overlay without disposing the underlying agent.
 */
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@mariozechner/pi-tui";
import type { AgentRole, AgentTranscriptEntry, DispatchedAgentHandle } from "./state.ts";

export class AgentOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly handle: DispatchedAgentHandle;
  private readonly onDismissCallback: () => void;
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private titleText = "";
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
    handle: DispatchedAgentHandle,
    intentTitle: string,
    onDismiss: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.handle = handle;
    this.onDismissCallback = onDismiss;
    this.titleText = `${intentTitle} · ${handle.role}`;

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      void this.handle.sendUserMessage(value);
      this.tui.requestRender();
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };
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

  private buildTranscriptLines(entries: AgentTranscriptEntry[], innerWidth: number): string[] {
    if (entries.length === 0) {
      return [this.theme.fg("dim", "No transcript yet — agent has not started.")];
    }
    const lines: string[] = [];
    for (const entry of entries) {
      if (lines.length > 0) lines.push("");
      const badge =
        entry.role === "user"
          ? this.theme.fg("accent", "[You]")
          : this.theme.fg("success", "[Agent]");
      lines.push(badge);
      for (const line of entry.content.split("\n")) {
        lines.push(`    ${line}`);
      }
    }
    return lines;
  }

  private wrapLines(lines: string[], innerWidth: number): string[] {
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
    return Math.max(16, (this.tui.terminal.rows ?? 30) - 2);
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
        this.transcriptScrollOffset - Math.max(1, this.transcriptViewportHeight - 1),
      );
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.transcriptScrollOffset += Math.max(1, this.transcriptViewportHeight - 1);
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(30, width);
    const innerWidth = Math.max(28, dialogWidth - 2);
    const entries = this.handle.getTranscript();
    const sourceLines = this.buildTranscriptLines(entries, innerWidth);
    const transcriptLines = this.wrapLines(sourceLines, innerWidth);

    const dialogHeight = this.getDialogHeight();
    const chromeHeight = 6;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visible = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const padCount = Math.max(0, transcriptHeight - visible.length);

    const lines = [this.borderLine(innerWidth, "top")];
    lines.push(
      this.frameLine(
        this.theme.fg("accent", this.theme.bold(this.titleText)),
        innerWidth,
      ),
    );
    lines.push(this.ruleLine(innerWidth));

    for (const line of visible) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < padCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(
      this.frameLine(
        this.theme.fg("dim", "Enter steer · Esc close · PgUp/PgDn scroll"),
        innerWidth,
      ),
    );
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }

  refresh(): void {
    this.tui.requestRender();
  }
}
