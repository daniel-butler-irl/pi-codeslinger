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
