import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createIntentSidebar } from "./panel.ts";
import type { IntentStore } from "./store.ts";

function mockTui(rows = 24, columns = 80) {
  return {
    terminal: { rows, columns },
    invalidate: () => {},
    requestRender: () => {},
  } as any;
}

function mockTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as any;
}

const emptyStore: IntentStore = { activeIntentId: null, intents: [] };
const storeWithIntent: IntentStore = {
  activeIntentId: "id1",
  intents: [{ id: "id1", title: "Fix the auth bug", createdAt: "" }],
};

describe("createIntentSidebar", () => {
  test("renders top and bottom borders", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    const lines = panel.render(30);
    assert.ok(lines[0].includes("╭"));
    assert.ok(lines[lines.length - 1].includes("╰"));
  });

  test("renders 'no intent set' when no active intent", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("no intent set")));
  });

  test("renders active intent title", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("Fix the auth bug")));
  });

  test("height fills terminal rows (rows - 1 content + bottom border)", () => {
    const rows = 20;
    const panel = createIntentSidebar(emptyStore, mockTui(rows), mockTheme());
    const lines = panel.render(30);
    assert.equal(lines.length, rows);
  });

  test("update() changes the store", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    const lines1 = panel.render(30);
    assert.ok(lines1.some((l) => l.includes("no intent set")));

    panel.update(storeWithIntent, null);
    const lines2 = panel.render(30);
    assert.ok(lines2.some((l) => l.includes("Fix the auth bug")));
  });
});
