import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntentSidebar } from "./panel.ts";
import type { Intent, IntentStore } from "./store.ts";
import { writeActiveIntent } from "./active-local.ts";

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
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
  } as any;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
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

/** Create a temp dir with a git repo so writeActiveIntent works. */
function withGitTempDir(fn: (cwd: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-panel-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const emptyStore: IntentStore = { intents: [] };
const storeWithIntent: IntentStore = {
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

  test("renders active intent title when active intent is set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("Fix the auth bug")));
    });
  });

  test("height fills terminal rows (rows - 1 content + bottom border)", () => {
    const rows = 20;
    const panel = createIntentSidebar(emptyStore, mockTui(rows), mockTheme());
    const lines = panel.render(30);
    assert.equal(lines.length, rows);
  });

  test("update() shows active intent title when active is set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme(), cwd);
      const lines1 = panel.render(30);
      assert.ok(lines1.some((l) => l.includes("no intent set")));

      panel.update(storeWithIntent, null, null, null, null, cwd);
      const lines2 = panel.render(30);
      assert.ok(lines2.some((l) => l.includes("Fix the auth bug")));
    });
  });

  test("shows DEFINING badge when phase is defining and active intent set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, "defining", null, null, cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("[DEFINING]")));
    });
  });

  test("shows IMPLEMENTING badge when phase is implementing and active intent set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, "implementing", null, null, cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("[IMPLEMENTING]")));
    });
  });

  test("renders markdown in intent titles", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const storeWithMarkdownTitle: IntentStore = {
        intents: [makeIntent({ title: "**Critical** auth fix" })],
      };
      const panel = createIntentSidebar(
        storeWithMarkdownTitle,
        mockTui(),
        mockTheme(),
        cwd,
      );
      const rendered = stripAnsi(panel.render(40).join("\n"));
      assert.match(rendered, /Critical auth fix/);
      assert.doesNotMatch(rendered, /\*\*Critical\*\*/);
    });
  });

  test("renders markdown in description excerpts", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(
        storeWithIntent,
        "**Critical** auth fix\n\n- update login flow",
        "implementing",
        null,
        null,
        cwd,
      );
      const rendered = stripAnsi(panel.render(40).join("\n"));
      assert.match(rendered, /Critical/);
      assert.match(rendered, /update login flow/);
      assert.doesNotMatch(rendered, /\*\*Critical\*\*/);
    });
  });

  test("renders markdown in understanding section", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(
        storeWithIntent,
        null,
        "implementing",
        "# Findings\n\n**Next step**\n- add coverage",
        null,
        cwd,
      );
      const rendered = stripAnsi(panel.render(40).join("\n"));
      assert.match(rendered, /Findings/);
      assert.match(rendered, /Next step/);
      assert.match(rendered, /add coverage/);
      assert.doesNotMatch(rendered, /# Findings/);
      assert.doesNotMatch(rendered, /\*\*Next step\*\*/);
    });
  });

  test("shows REVIEWING badge when phase is reviewing and active intent set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, "reviewing", null, null, cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("[REVIEWING]")));
    });
  });

  test("shows DONE badge when phase is done and active intent set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, "done", null, null, cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("[DONE]")));
    });
  });

  test("shows BLOCKED badge when phase is blocked-on-child and active intent set", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, "blocked-on-child", null, null, cwd);
      const lines = panel.render(30);
      assert.ok(lines.some((l) => l.includes("[BLOCKED]")));
    });
  });

  test("no badge when no active intent", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.update(emptyStore, null, "defining");
    const lines = panel.render(30);
    assert.ok(!lines.some((l) => l.includes("[DEFINING]")));
  });

  test("no badge when phase is null", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      panel.update(storeWithIntent, null, null, null, null, cwd);
      const lines = panel.render(30);
      assert.ok(!lines.some((l) => l.includes("[DEFINING]")));
    });
  });

  test("shows breadcrumb to root when intent has a parent", () => {
    withGitTempDir((cwd) => {
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
        intents: [root, child],
      };
      writeActiveIntent(cwd, "child");
      const panel = createIntentSidebar(store, mockTui(), mockTheme(), cwd);
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
  });

  test("no breadcrumb for top-level intents", () => {
    withGitTempDir((cwd) => {
      writeActiveIntent(cwd, "id1");
      const panel = createIntentSidebar(storeWithIntent, mockTui(), mockTheme(), cwd);
      const lines = panel.render(30);
      assert.ok(!lines.some((l) => l.includes("↱")));
    });
  });
});

describe("createIntentSidebar — running agents section", () => {
  test("renders Running Agents section when agents are present", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.updateAgents([
      { intentId: "i1", intentTitle: "Fix auth", role: "implementer", status: "running" },
    ]);
    const lines = panel.render(40);
    assert.ok(lines.some((l) => l.includes("Running Agents")));
    assert.ok(lines.some((l) => l.includes("Fix auth")));
    assert.ok(lines.some((l) => l.includes("implementer")));
  });

  test("does not render Running Agents section when no agents", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    const lines = panel.render(40);
    assert.ok(!lines.some((l) => l.includes("Running Agents")));
  });

  test("shows status text for running agent", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.updateAgents([
      { intentId: "i1", intentTitle: "Ship feature", role: "reviewer", status: "checking tests" },
    ]);
    const lines = panel.render(40);
    assert.ok(lines.some((l) => l.includes("checking tests")));
  });

  test("selection callback fires on Enter when agent is selected", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.updateAgents([
      { intentId: "i1", intentTitle: "Fix auth", role: "implementer", status: "running" },
    ]);
    const selected: Array<[string, string]> = [];
    panel.setOnSelectAgent((intentId, role) => {
      selected.push([intentId, role]);
    });
    // Simulate down-arrow to select first agent (index 0 — default is -1 so we go to 0)
    // Actually default selectedAgentIndex is -1 so we need an up/down first.
    // Down arrow moves from -1 to 0:
    panel.handleInput("\x1b[B");
    // Enter triggers selection
    panel.handleInput("\r");
    assert.equal(selected.length, 1);
    assert.equal(selected[0][0], "i1");
    assert.equal(selected[0][1], "implementer");
  });

  test("no selection callback when no agents", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    const selected: Array<[string, string]> = [];
    panel.setOnSelectAgent((intentId, role) => {
      selected.push([intentId, role]);
    });
    panel.handleInput("\r");
    assert.equal(selected.length, 0);
  });

  test("updateAgents clears selected index when agents list shrinks", () => {
    const panel = createIntentSidebar(emptyStore, mockTui(), mockTheme());
    panel.updateAgents([
      { intentId: "i1", intentTitle: "A", role: "implementer", status: "running" },
      { intentId: "i2", intentTitle: "B", role: "reviewer", status: "running" },
    ]);
    // Select index 1
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    // Now shrink to 1 agent — should not crash
    panel.updateAgents([
      { intentId: "i1", intentTitle: "A", role: "implementer", status: "running" },
    ]);
    const lines = panel.render(40);
    assert.ok(lines.some((l) => l.includes("Running Agents")));
  });
});
