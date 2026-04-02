// extensions/chat-ui/component.ts
import { homedir } from "os";
import { execSync } from "child_process";
import {
  visibleWidth,
  truncateToWidth,
  CURSOR_MARKER,
  matchesKey,
  Key,
  type Component,
  type TUI,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ChatStore, ChatEntry } from "./store.js";
import { renderEntry } from "./messages.js";
import {
  loadStore,
  loadIntentContent,
  getActiveIntent,
} from "../intent/store.js";

function gitBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function wordWrap(text: string, maxWidth: number): string[] {
  if (!text || maxWidth <= 0) return [""];
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
  return lines.length ? lines : [""];
}

export class ChatUIComponent implements Component {
  private cachedLines: string[] | null = null;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(
    private readonly store: ChatStore,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly pi: any,
    private readonly cwd: string,
  ) {}

  // ── Dimensions ──────────────────────────────────────────────────────────────

  private sidebarWidth(totalWidth: number): number {
    return Math.min(40, Math.max(24, Math.floor(totalWidth * 0.25)));
  }

  private contentWidth(totalWidth: number): number {
    return totalWidth - this.sidebarWidth(totalWidth);
  }

  private viewportHeight(totalHeight: number): number {
    return Math.max(1, totalHeight - 4); // header + separator + input + status
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const height = this.tui.terminal.rows;

    if (
      this.cachedLines &&
      width === this.lastWidth &&
      height === this.lastHeight
    ) {
      return this.cachedLines;
    }

    this.lastWidth = width;
    this.lastHeight = height;

    const S = this.sidebarWidth(width);
    const C = this.contentWidth(width);
    const VH = this.viewportHeight(height);

    const leftLines = this.renderLeft(C, height, VH);
    const rightLines = this.renderSidebar(S, height);

    this.cachedLines = leftLines.map((line, i) => {
      const pad = Math.max(0, C - visibleWidth(line));
      return line + " ".repeat(pad) + (rightLines[i] ?? "");
    });

    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  handleInput(data: string): void {
    this.onKey(data);
  }

  // ── Left column ───────────────────────────────────────────────────────────────

  private renderLeft(C: number, H: number, VH: number): string[] {
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);
    const bold = (s: string) => this.theme.bold(s);

    const lines: string[] = [];

    // Row 0: header
    const branch = gitBranch(this.cwd);
    const path = shortenPath(this.cwd);
    const branchPart = branch ? dim("  (" + branch + ")") : "";
    lines.push(" " + bold(accent("pi")) + "  " + dim(path) + branchPart);

    // Rows 1..VH: chat viewport
    const msgBuffer = this.buildMessageBuffer(C);
    const total = msgBuffer.length;
    const viewEnd = Math.max(total, VH) - this.store.scrollOffset;
    const viewStart = Math.max(0, viewEnd - VH);
    const visible = msgBuffer.slice(viewStart, viewEnd);

    while (visible.length < VH) visible.push("");

    // New-lines indicator
    if (this.store.scrollOffset > 0 && this.store.newLinesWhileScrolled > 0) {
      visible[visible.length - 1] = dim(
        `  ↓ ${this.store.newLinesWhileScrolled} new line${this.store.newLinesWhileScrolled > 1 ? "s" : ""} — esc to jump to bottom`,
      );
    }

    lines.push(...visible);

    // Row H-3: separator
    lines.push(dim("  " + "─".repeat(Math.max(0, C - 2))));

    // Row H-2: input
    const prompt = accent("› ");
    const before = this.store.inputText.slice(0, this.store.inputCursor);
    const after = this.store.inputText.slice(this.store.inputCursor);
    lines.push("  " + prompt + before + CURSOR_MARKER + after);

    // Row H-1: status
    const contextUsage = (this.pi as any).getContextUsage?.() ?? null;
    const tokenStr = contextUsage?.tokens
      ? contextUsage.tokens.toLocaleString() + " tok"
      : "";
    lines.push("  " + dim(tokenStr));

    return lines;
  }

  private buildMessageBuffer(contentWidth: number): string[] {
    const buffer: string[] = [];
    for (const entry of this.store.entries) {
      const rendered = renderEntry(
        entry,
        this.store.entries,
        contentWidth,
        this.theme,
      );
      buffer.push(...rendered);
      if (rendered.length > 0) buffer.push(""); // spacer between messages
    }
    return buffer;
  }

  // ── Right column (sidebar) ───────────────────────────────────────────────────

  private renderSidebar(S: number, H: number): string[] {
    const border = (s: string) => this.theme.fg("borderAccent", s);
    const titleFn = (s: string) => this.theme.bold(this.theme.fg("accent", s));
    const dim = (s: string) => this.theme.fg("dim", s);
    const inner = Math.max(4, S - 4);

    function contentLine(
      text: string,
      styleFn: (s: string) => string = (s) => s,
    ): string {
      const truncated = truncateToWidth(text, inner);
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
      return border("│") + " " + styleFn(truncated) + pad + " " + border("│");
    }

    const intentStore = loadStore(this.cwd);
    const active = getActiveIntent(intentStore);
    const description = active
      ? (() => {
          const content = loadIntentContent(this.cwd, active.id);
          const line = content
            .split("\n")
            .find((l) => l.trim() && !l.startsWith("#"));
          return line?.trim() ?? null;
        })()
      : null;

    const label = " Intent ";
    const fill = Math.max(0, S - 3 - visibleWidth(label));
    const lines: string[] = [
      border("╭") +
        border("─") +
        dim(label) +
        border("─".repeat(fill)) +
        border("╮"),
    ];

    if (!active) {
      lines.push(contentLine("no intent set", dim));
    } else {
      lines.push(contentLine(active.title, titleFn));
      if (description) {
        lines.push(border("│") + " ".repeat(S - 2) + border("│"));
        for (const wl of wordWrap(description, inner).slice(0, 5)) {
          lines.push(contentLine(wl, dim));
        }
      }
    }

    const targetHeight = Math.max(lines.length + 1, H - 1);
    while (lines.length < targetHeight) {
      lines.push(border("│") + " ".repeat(S - 2) + border("│"));
    }
    lines.push(border("╰") + border("─".repeat(S - 2)) + border("╯"));

    return lines;
  }

  // ── Input handling ────────────────────────────────────────────────────────────

  private onKey(data: string): void {
    const store = this.store;

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const text = store.inputText.trim();
      if (text) {
        this.pi.sendUserMessage(text);
        store.inputText = "";
        store.inputCursor = 0;
        store.scrollOffset = 0;
        store.resetNewLines();
      }
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (store.inputCursor > 0) {
        store.inputText =
          store.inputText.slice(0, store.inputCursor - 1) +
          store.inputText.slice(store.inputCursor);
        store.inputCursor--;
        this.cachedLines = null;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.left)) {
      if (store.inputCursor > 0) store.inputCursor--;
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.right)) {
      if (store.inputCursor < store.inputText.length) store.inputCursor++;
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      store.scrollOffset += this.viewportHeight(this.tui.terminal.rows);
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      store.scrollOffset = Math.max(
        0,
        store.scrollOffset - this.viewportHeight(this.tui.terminal.rows),
      );
      if (store.scrollOffset === 0) store.resetNewLines();
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      store.scrollOffset++;
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      store.scrollOffset = Math.max(0, store.scrollOffset - 1);
      if (store.scrollOffset === 0) store.resetNewLines();
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      store.scrollOffset = 0;
      store.resetNewLines();
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    // Printable characters
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      store.inputText =
        store.inputText.slice(0, store.inputCursor) +
        data +
        store.inputText.slice(store.inputCursor);
      store.inputCursor++;
      this.cachedLines = null;
      this.tui.requestRender();
      return;
    }

    // ctrl+c and all other keys: do NOT consume — let Pi handle interrupt etc.
  }
}
