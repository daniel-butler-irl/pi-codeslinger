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
