// extensions/chat-ui/messages.ts
import { visibleWidth, Markdown } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ChatEntry, ToolResultEntry } from "./store.js";

function wordWrap(text: string, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const w = word.slice(0, maxWidth);
    if (current.length === 0) {
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

export function renderEntry(
  entry: ChatEntry,
  allEntries: ChatEntry[],
  width: number,
  theme: Theme,
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const accent = (s: string) => theme.fg("accent", s);
  const bold = (s: string) => theme.bold(s);
  const error = (s: string) => theme.fg("error", s);

  switch (entry.type) {
    case "user": {
      const label = dim("  You ›  ");
      const textWidth = Math.max(4, width - visibleWidth(label));
      const wrapped = wordWrap(entry.text, textWidth);
      return wrapped.map((line, i) =>
        i === 0 ? label + line : " ".repeat(visibleWidth(label)) + line,
      );
    }

    case "assistant": {
      const text = entry.isStreaming ? entry.text + " ▊" : entry.text;
      if (!text.trim()) return [];
      const md = new Markdown(text, 2, 0, theme as any);
      return md.render(width);
    }

    case "thinking": {
      return [dim("  ▶ Thinking")];
    }

    case "tool_call": {
      const result = allEntries.find(
        (e) =>
          e.type === "tool_result" &&
          (e as ToolResultEntry).toolCallId === entry.toolCallId,
      ) as ToolResultEntry | undefined;

      const spinner = entry.isRunning ? dim("⠋ ") : "";
      const status = entry.isRunning
        ? ""
        : result
          ? entry.isError
            ? " " + error("✗")
            : " " + accent("✓")
          : "";

      const argStr = (() => {
        try {
          const parsed = JSON.parse(entry.args);
          const vals = Object.values(parsed);
          return vals.length ? "  " + String(vals[0]).slice(0, 40) : "";
        } catch {
          return "";
        }
      })();

      const resultSuffix =
        result && !entry.isRunning
          ? dim("  [" + result.result.split("\n").length + " lines]")
          : "";

      return [
        `  ${spinner}${dim("▶")} ${bold(entry.toolName)}${dim(argStr)}${status}${resultSuffix}`,
      ];
    }

    case "tool_result": {
      return [];
    }

    case "compaction": {
      const prefix = "── context compacted ";
      const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix)));
      return [dim(`${prefix}${fill}`)];
    }

    case "image": {
      return [dim(`  [image: ${entry.filename}]`)];
    }
  }
}
