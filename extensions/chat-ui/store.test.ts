// extensions/chat-ui/store.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "./store.ts";

function makeUserSessionEntry(id: string, text: string) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    },
  };
}

function makeAssistantSessionEntry(id: string, text: string) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "anthropic" as any,
      provider: "anthropic" as any,
      model: "claude-sonnet",
      usage: { inputTokens: 10, outputTokens: 20 } as any,
      stopReason: "stop" as any,
      timestamp: Date.now(),
    },
  };
}

function makeToolResultSessionEntry(
  id: string,
  toolCallId: string,
  result: string,
  isError = false,
) {
  return {
    type: "message" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read_file",
      content: [{ type: "text" as const, text: result }],
      isError,
      timestamp: Date.now(),
    },
  };
}

function makeCompactionSessionEntry(id: string) {
  return {
    type: "compaction" as const,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "Compacted context",
    firstKeptEntryId: "next",
    tokensBefore: 1000,
  };
}

describe("ChatStore seeding", () => {
  test("starts empty", () => {
    const store = new ChatStore();
    assert.equal(store.entries.length, 0);
    assert.equal(store.scrollOffset, 0);
    assert.equal(store.inputText, "");
    assert.equal(store.inputCursor, 0);
  });

  test("seeds user message from session entry", () => {
    const store = new ChatStore();
    store.seedFromEntries([makeUserSessionEntry("1", "hello world")]);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "user");
    assert.equal((store.entries[0] as any).text, "hello world");
  });

  test("seeds assistant message from session entry", () => {
    const store = new ChatStore();
    store.seedFromEntries([makeAssistantSessionEntry("1", "hi there")]);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "assistant");
    assert.equal((store.entries[0] as any).text, "hi there");
    assert.equal((store.entries[0] as any).isStreaming, false);
  });

  test("seeds tool result from session entry", () => {
    const store = new ChatStore();
    store.seedFromEntries([
      makeToolResultSessionEntry("1", "call-123", "file content"),
    ]);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "tool_result");
    assert.equal((store.entries[0] as any).toolCallId, "call-123");
    assert.equal((store.entries[0] as any).result, "file content");
    assert.equal((store.entries[0] as any).isError, false);
  });

  test("seeds compaction from session entry", () => {
    const store = new ChatStore();
    store.seedFromEntries([makeCompactionSessionEntry("1")]);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "compaction");
  });

  test("skips unknown session entry types", () => {
    const store = new ChatStore();
    store.seedFromEntries([
      { type: "label" as any, id: "1", parentId: null, timestamp: "" } as any,
    ]);
    assert.equal(store.entries.length, 0);
  });
});

describe("ChatStore message events", () => {
  test("onMessageStart pushes streaming assistant entry", () => {
    const store = new ChatStore();
    store.onMessageStart("msg-1", { role: "assistant", content: [] } as any);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "assistant");
    assert.equal((store.entries[0] as any).isStreaming, true);
    assert.equal((store.entries[0] as any).text, "");
  });

  test("onMessageStart ignores non-assistant messages", () => {
    const store = new ChatStore();
    store.onMessageStart("msg-1", { role: "user", content: [] } as any);
    assert.equal(store.entries.length, 0);
  });

  test("onMessageUpdate replaces last streaming entry text", () => {
    const store = new ChatStore();
    store.onMessageStart("msg-1", { role: "assistant", content: [] } as any);
    store.onMessageUpdate({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    } as any);
    assert.equal((store.entries[0] as any).text, "hello");
    assert.equal((store.entries[0] as any).isStreaming, true);
  });

  test("onMessageEnd marks last streaming entry as done", () => {
    const store = new ChatStore();
    store.onMessageStart("msg-1", { role: "assistant", content: [] } as any);
    store.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    } as any);
    assert.equal((store.entries[0] as any).isStreaming, false);
    assert.equal((store.entries[0] as any).text, "done");
  });

  test("onInput pushes user entry", () => {
    const store = new ChatStore();
    store.onInput("hello user");
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "user");
    assert.equal((store.entries[0] as any).text, "hello user");
  });
});

describe("ChatStore tool events", () => {
  test("onToolStart pushes running tool_call entry", () => {
    const store = new ChatStore();
    store.onToolStart("call-1", "read_file", { path: "foo.ts" });
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].type, "tool_call");
    assert.equal((store.entries[0] as any).toolCallId, "call-1");
    assert.equal((store.entries[0] as any).toolName, "read_file");
    assert.equal((store.entries[0] as any).isRunning, true);
  });

  test("onToolEnd marks tool call done and pushes tool_result", () => {
    const store = new ChatStore();
    store.onToolStart("call-1", "read_file", {});
    store.onToolEnd("call-1", "file contents here", false);
    assert.equal(store.entries.length, 2);
    assert.equal(store.entries[0].type, "tool_call");
    assert.equal((store.entries[0] as any).isRunning, false);
    assert.equal(store.entries[1].type, "tool_result");
    assert.equal((store.entries[1] as any).result, "file contents here");
    assert.equal((store.entries[1] as any).isError, false);
  });

  test("onToolEnd marks isError on error", () => {
    const store = new ChatStore();
    store.onToolStart("call-1", "bash", {});
    store.onToolEnd("call-1", "command not found", true);
    assert.equal((store.entries[0] as any).isError, true);
    assert.equal((store.entries[1] as any).isError, true);
  });
});
