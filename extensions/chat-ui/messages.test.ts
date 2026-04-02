// extensions/chat-ui/messages.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderEntry } from "./messages.ts";
import type { ChatEntry, ToolCallEntry, ToolResultEntry } from "./store.ts";

function mockTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as any;
}

const noEntries: ChatEntry[] = [];

describe("renderEntry — user", () => {
  test("renders user message with You label", () => {
    const entry: ChatEntry = { type: "user", id: "1", text: "hello" };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.ok(lines.some((l) => l.includes("You") && l.includes("hello")));
  });

  test("word-wraps long user messages", () => {
    const entry: ChatEntry = {
      type: "user",
      id: "1",
      text: "a b c d e f g h i j k l m n o p",
    };
    const lines = renderEntry(entry, noEntries, 15, mockTheme());
    assert.ok(lines.length > 1);
  });
});

describe("renderEntry — assistant", () => {
  test("renders assistant text", () => {
    const entry: ChatEntry = {
      type: "assistant",
      id: "1",
      text: "response text",
      isStreaming: false,
    };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.ok(lines.join("").includes("response text"));
  });

  test("appends streaming cursor when isStreaming", () => {
    const entry: ChatEntry = {
      type: "assistant",
      id: "1",
      text: "partial",
      isStreaming: true,
    };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.ok(lines.join("").includes("▊"));
  });

  test("no streaming cursor when done", () => {
    const entry: ChatEntry = {
      type: "assistant",
      id: "1",
      text: "done",
      isStreaming: false,
    };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.ok(!lines.join("").includes("▊"));
  });
});

describe("renderEntry — thinking", () => {
  test("renders collapsed by default", () => {
    const entry: ChatEntry = {
      type: "thinking",
      id: "1",
      text: "some thoughts",
    };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("▶") && lines[0].includes("Thinking"));
  });
});

describe("renderEntry — compaction", () => {
  test("renders as single separator line", () => {
    const entry: ChatEntry = { type: "compaction", id: "1" };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("compacted"));
  });
});

describe("renderEntry — image", () => {
  test("renders placeholder", () => {
    const entry: ChatEntry = {
      type: "image",
      id: "1",
      filename: "screenshot.png",
    };
    const lines = renderEntry(entry, noEntries, 40, mockTheme());
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("screenshot.png"));
  });
});

describe("renderEntry — tool_call with result", () => {
  function makeToolCall(toolCallId: string): ToolCallEntry {
    return {
      type: "tool_call",
      id: "tc1",
      toolCallId,
      toolName: "read_file",
      args: '{"path":"foo.ts"}',
      isRunning: false,
      isError: false,
    };
  }
  function makeToolResult(
    toolCallId: string,
    result: string,
    isError = false,
  ): ToolResultEntry {
    return { type: "tool_result", id: "tr1", toolCallId, result, isError };
  }

  test("shows line count when result present", () => {
    const call = makeToolCall("c1");
    const result = makeToolResult("c1", "line1\nline2\nline3");
    const lines = renderEntry(call, [call, result], 60, mockTheme());
    assert.ok(lines[0].includes("3 lines"));
  });

  test("shows checkmark when not error", () => {
    const call = makeToolCall("c1");
    const result = makeToolResult("c1", "ok");
    const lines = renderEntry(call, [call, result], 60, mockTheme());
    assert.ok(lines[0].includes("✓"));
  });

  test("shows ✗ on error", () => {
    const call = makeToolCall("c1");
    const result = makeToolResult("c1", "failed", true);
    const lines = renderEntry(call, [call, result], 60, mockTheme());
    assert.ok(lines[0].includes("✗"));
  });

  test("tool_result entry renders as empty array (co-rendered by tool_call)", () => {
    const result = makeToolResult("c1", "content");
    const lines = renderEntry(result, [], 60, mockTheme());
    assert.equal(lines.length, 0);
  });
});
