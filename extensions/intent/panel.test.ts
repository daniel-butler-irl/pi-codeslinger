import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createIntentSidebar } from "./panel.ts";
import type { Intent, IntentStore } from "./store.ts";

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

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: "id1",
    title: "Fix the auth bug",
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    phase: "defining",
    reworkCount: 0,
    ...overrides,
  };
}

const emptyStore: IntentStore = { activeIntentId: null, intents: [] };
const storeWithIntent: IntentStore = {
  activeIntentId: "id1",
  intents: [makeIntent()],
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

  test("shows DEFINING badge when phase is defining", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, "defining");
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("[DEFINING]")));
  });

  test("shows IMPLEMENTING badge when phase is implementing", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, "implementing");
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("[IMPLEMENTING]")));
  });

  test("shows REVIEWING badge when phase is reviewing", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, "reviewing");
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("[REVIEWING]")));
  });

  test("shows DONE badge when phase is done", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, "done");
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("[DONE]")));
  });

  test("shows BLOCKED badge when phase is blocked-on-child", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, "blocked-on-child");
    const lines = panel.render(30);
    assert.ok(lines.some((l) => l.includes("[BLOCKED]")));
  });

  test("no badge when no active intent", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.update(emptyStore, null, "defining");
    const lines = panel.render(30);
    assert.ok(!lines.some((l) => l.includes("[DEFINING]")));
  });

  test("no badge when phase is null", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    panel.update(storeWithIntent, null, null);
    const lines = panel.render(30);
    assert.ok(!lines.some((l) => l.includes("[DEFINING]")));
  });

  test("shows breadcrumb to root when intent has a parent", () => {
    const root: Intent = makeIntent({
      id: "root",
      title: "Ship the auth refactor",
      parentId: null,
    });
    const child: Intent = makeIntent({
      id: "child",
      title: "Add auth tests",
      parentId: "root",
    });
    const store: IntentStore = {
      activeIntentId: "child",
      intents: [root, child],
    };
    const panel = createIntentSidebar(store, mockTui(), mockTheme());
    const lines = panel.render(40);
    assert.ok(
      lines.some((l) => l.includes("Ship the auth refactor")),
      "root title should appear as breadcrumb",
    );
    assert.ok(
      lines.some((l) => l.includes("Add auth tests")),
      "active child title should appear",
    );
  });

  test("no breadcrumb for top-level intents", () => {
    const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme());
    const lines = panel.render(30);
    assert.ok(!lines.some((l) => l.includes("↱")));
  });
});
