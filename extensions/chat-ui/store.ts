// extensions/chat-ui/store.ts

// ── Entry types ───────────────────────────────────────────────────────────────

export interface UserEntry {
  type: "user";
  id: string;
  text: string;
}

export interface AssistantEntry {
  type: "assistant";
  id: string;
  text: string;
  isStreaming: boolean;
}

export interface ToolCallEntry {
  type: "tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  args: string;
  isRunning: boolean;
  isError: boolean;
}

export interface ToolResultEntry {
  type: "tool_result";
  id: string;
  toolCallId: string;
  result: string;
  isError: boolean;
}

export interface ThinkingEntry {
  type: "thinking";
  id: string;
  text: string;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
}

export interface ImageEntry {
  type: "image";
  id: string;
  filename: string;
}

export type ChatEntry =
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | ToolResultEntry
  | ThinkingEntry
  | CompactionEntry
  | ImageEntry;

// ── ChatStore ─────────────────────────────────────────────────────────────────

export class ChatStore {
  entries: ChatEntry[] = [];
  scrollOffset = 0;
  inputText = "";
  inputCursor = 0;
  expandedThinking = new Set<string>();
  expandedToolResults = new Set<string>();
  newLinesWhileScrolled = 0;

  private nextId = 0;
  private id(): string {
    return `entry-${this.nextId++}`;
  }

  seedFromEntries(sessionEntries: any[]): void {
    for (const entry of sessionEntries) {
      if (entry.type === "message") {
        this.seedMessage(entry.id, entry.message);
      } else if (entry.type === "compaction") {
        this.entries.push({ type: "compaction", id: entry.id });
      }
      // other entry types (label, custom, branch_summary, etc.) are skipped
    }
  }

  onMessageStart(id: string, message: any): void {
    if (message.role !== "assistant") return;
    this.entries.push({ type: "assistant", id, text: "", isStreaming: true });
    if (this.scrollOffset > 0) this.newLinesWhileScrolled++;
  }

  onMessageUpdate(message: any): void {
    const last = this.entries.findLast((e) => e.type === "assistant") as
      | AssistantEntry
      | undefined;
    if (!last) return;
    last.text = this.extractText(message.content ?? []);
  }

  onMessageEnd(message: any): void {
    const last = this.entries.findLast((e) => e.type === "assistant") as
      | AssistantEntry
      | undefined;
    if (!last) return;
    last.isStreaming = false;
    last.text = this.extractText(message.content ?? []);
  }

  onInput(text: string): void {
    this.entries.push({ type: "user", id: this.id(), text });
    if (this.scrollOffset > 0) this.newLinesWhileScrolled++;
  }

  onToolStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    this.entries.push({
      type: "tool_call",
      id: this.id(),
      toolCallId,
      toolName,
      args: JSON.stringify(args),
      isRunning: true,
      isError: false,
    });
  }

  resetNewLines(): void {
    this.newLinesWhileScrolled = 0;
  }

  onToolEnd(toolCallId: string, result: any, isError: boolean): void {
    const call = this.entries.find(
      (e) =>
        e.type === "tool_call" &&
        (e as ToolCallEntry).toolCallId === toolCallId,
    ) as ToolCallEntry | undefined;
    if (call) {
      call.isRunning = false;
      call.isError = isError;
    }
    const resultText =
      typeof result === "string" ? result : JSON.stringify(result);
    this.entries.push({
      type: "tool_result",
      id: this.id(),
      toolCallId,
      result: resultText,
      isError,
    });
  }

  private seedMessage(id: string, message: any): void {
    if (message.role === "user") {
      const text = this.extractText(message.content);
      if (text) this.entries.push({ type: "user", id, text });
    } else if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "thinking") {
          this.entries.push({
            type: "thinking",
            id: this.id(),
            text: block.thinking as string,
          });
        } else if (block.type === "toolCall") {
          this.entries.push({
            type: "tool_call",
            id: this.id(),
            toolCallId: block.id as string,
            toolName: block.name as string,
            args: JSON.stringify(block.arguments ?? {}),
            isRunning: false,
            isError: false,
          });
        }
      }
      const text = this.extractText(message.content);
      if (text)
        this.entries.push({ type: "assistant", id, text, isStreaming: false });
    } else if (message.role === "toolResult") {
      const result = this.extractText(message.content);
      this.entries.push({
        type: "tool_result",
        id,
        toolCallId: message.toolCallId as string,
        result: result || "",
        isError: message.isError as boolean,
      });
    }
  }

  private extractText(content: any[]): string {
    if (!Array.isArray(content)) return "";
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text as string)
      .join("");
  }
}
