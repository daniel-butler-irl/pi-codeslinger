import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentOverlayComponent } from "./agent-overlay.ts";
import type { AgentTranscriptEntry, DispatchedAgentHandle } from "./state.ts";

function mockTui(rows = 24) {
  return {
    terminal: { rows, columns: 80 },
    invalidate: () => {},
    requestRender: () => {},
  } as any;
}

function mockTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
  } as any;
}

function mockHandle(overrides: Partial<DispatchedAgentHandle> = {}): DispatchedAgentHandle {
  return {
    role: "implementer",
    prompt: async () => {},
    dispose: async () => {},
    getTranscript: () => [],
    sendUserMessage: async () => {},
    ...overrides,
  };
}

describe("AgentOverlayComponent — render", () => {
  test("renders top and bottom borders", () => {
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      mockHandle(),
      "Fix auth bug",
      () => {},
    );
    const lines = overlay.render(60);
    assert.ok(lines[0].includes("┌"));
    assert.ok(lines[lines.length - 1].includes("└"));
  });

  test("renders intent title and role in header", () => {
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      mockHandle({ role: "reviewer" }),
      "Ship feature",
      () => {},
    );
    const lines = overlay.render(60);
    const header = lines.join("\n");
    assert.ok(header.includes("Ship feature"));
    assert.ok(header.includes("reviewer"));
  });

  test("renders empty transcript placeholder when no messages", () => {
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      mockHandle({ getTranscript: () => [] }),
      "Test intent",
      () => {},
    );
    const lines = overlay.render(60);
    assert.ok(lines.some((l) => l.includes("No transcript yet")));
  });

  test("renders transcript entries when messages exist", () => {
    const transcript: AgentTranscriptEntry[] = [
      { role: "user", content: "Start work on this." },
      { role: "assistant", content: "I will begin now." },
    ];
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      mockHandle({ getTranscript: () => transcript }),
      "My intent",
      () => {},
    );
    const lines = overlay.render(60);
    const all = lines.join("\n");
    assert.ok(all.includes("Start work on this."));
    assert.ok(all.includes("I will begin now."));
  });

  test("renders hint line at bottom", () => {
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      mockHandle(),
      "My intent",
      () => {},
    );
    const lines = overlay.render(60);
    const bottom = lines[lines.length - 2];
    assert.ok(bottom.includes("Esc close"));
  });
});

describe("AgentOverlayComponent — input routing", () => {
  test("Escape calls onDismiss without disposing handle", () => {
    let dismissed = false;
    let disposed = false;
    const handle = mockHandle({
      dispose: async () => { disposed = true; },
    });
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      handle,
      "My intent",
      () => { dismissed = true; },
    );
    overlay.focused = true;
    overlay.handleInput("\x1b");
    assert.ok(dismissed, "dismiss should be called");
    assert.ok(!disposed, "dispose should NOT be called on close");
  });

  test("Enter routes input to handle.sendUserMessage", async () => {
    const sent: string[] = [];
    const handle = mockHandle({
      sendUserMessage: async (text) => { sent.push(text); },
    });
    const overlay = new AgentOverlayComponent(
      mockTui(),
      mockTheme(),
      handle,
      "My intent",
      () => {},
    );
    overlay.focused = true;
    // Type some text
    "hello".split("").forEach((ch) => overlay.handleInput(ch));
    // Submit
    overlay.handleInput("\r");
    // Allow async to settle
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ["hello"]);
  });
});
