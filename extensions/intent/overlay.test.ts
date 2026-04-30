import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IntentOverlayComponent } from "./overlay.ts";
import type { Intent, IntentStore } from "./store.ts";

function mockTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
    dim: (t: string) => t,
  } as any;
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: "id1",
    title: "Test intent",
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    phase: "defining",
    reworkCount: 0,
    ...overrides,
  };
}

const emptyStore: IntentStore = { intents: [] };
const storeWithIntent: IntentStore = {
  intents: [makeIntent()],
};

describe("IntentOverlayComponent", () => {
  test("renders menu with 'Create new intent' option", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(
      content.includes("Create new intent"),
      "Should show 'Create new intent' option",
    );
  });

  test("renders menu with 'List intents' when intents exist", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      storeWithIntent,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(
      content.includes("List intents"),
      "Should show 'List intents' option when intents exist",
    );
  });

  test("escape key in menu calls done with cancel", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    overlay.handleInput("\x1b"); // ESC

    assert.equal(result?.type, "cancel");
  });

  test("entering create mode shows text input area", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to "Create new intent" and press Enter
    overlay.handleInput("\r");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(
      content.includes("Describe your intent"),
      "Should show description prompt",
    );
    assert.equal(result, null, "Should not call done yet");
  });

  test("typing text in create mode updates cursor and content", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Enter create mode
    overlay.handleInput("\r");

    // Type some text
    overlay.handleInput("T");
    overlay.handleInput("e");
    overlay.handleInput("s");
    overlay.handleInput("t");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(content.includes("Test"), "Should show typed text");
  });

  test("backspace in create mode removes character", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Enter create mode
    overlay.handleInput("\r");

    // Type and delete
    overlay.handleInput("A");
    overlay.handleInput("B");
    overlay.handleInput("\x7f"); // Backspace

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(content.includes("A"), "Should show 'A'");
    assert.ok(!content.includes("B"), "Should not show deleted 'B'");
  });

  test("enter key with non-empty description switches to generating mode", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Enter create mode
    overlay.handleInput("\r");

    // Type description
    overlay.handleInput("T");
    overlay.handleInput("e");
    overlay.handleInput("s");
    overlay.handleInput("t");

    // Press enter to submit
    overlay.handleInput("\r");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(content.includes("Generating"), "Should show generating state");
  });

  test("list mode shows all intents with their phases", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "First intent", phase: "defining" }),
        makeIntent({
          id: "id2",
          title: "Second intent",
          phase: "implementing",
        }),
        makeIntent({ id: "id3", title: "Third intent", phase: "done" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // With emptystore, menu is: [Create new intent] [List intents] [Cancel]
    // Navigate down once to get to "List intents"
    overlay.handleInput("\x1b[B"); // Down arrow
    overlay.handleInput("\r"); // Enter

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(
      content.includes("First intent") || content.includes("Second intent"),
      "Should show intents in list",
    );
  });

  test("escape in create mode returns to menu", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Enter create mode
    overlay.handleInput("\r");

    let lines = overlay.render(80);
    let content = lines.join("\n");
    assert.ok(
      content.includes("Describe your intent"),
      "Should be in create mode",
    );

    // Press escape
    overlay.handleInput("\x1b");

    lines = overlay.render(80);
    content = lines.join("\n");
    assert.ok(content.includes("Create new intent"), "Should be back in menu");
    assert.equal(result, null, "Should not call done");
  });

  test("escape in list mode returns to menu", () => {
    // Use store with no active intent to make menu predictable
    const store: IntentStore = {
      intents: [makeIntent()],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to "List intents" (down once from "Create new intent")
    overlay.handleInput("\x1b[B"); // Down arrow
    overlay.handleInput("\r");

    let lines = overlay.render(80);
    let content = lines.join("\n");
    // In list mode, menu items shouldn't be shown
    assert.ok(
      !content.includes("Cancel"),
      "Should be in list mode (no Cancel button)",
    );

    // Press escape
    overlay.handleInput("\x1b");

    lines = overlay.render(80);
    content = lines.join("\n");
    assert.ok(
      content.includes("Cancel"),
      "Should be back in menu (Cancel visible)",
    );
  });

  test("selecting an intent from list shows detail view", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "First intent", phase: "defining" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to "List intents" and enter (down once from "Create new intent")
    overlay.handleInput("\x1b[B"); // Down arrow
    overlay.handleInput("\r");

    // Select the first intent from the list
    overlay.handleInput("\r");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    // In detail view, should show intent information
    assert.ok(
      content.includes("First intent") || content.includes("defining"),
      "Should show intent details",
    );
  });

  test("keyboard navigation in menu", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      storeWithIntent,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Down arrow should move selection
    overlay.handleInput("\x1b[B");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    // Menu should still be rendered (we just changed selection)
    assert.ok(
      content.includes("Create new intent") || content.includes("List intents"),
    );
  });

  test("overlay renders with dynamic width based on terminal columns", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Test min clamp (70)
    let lines = overlay.render(50);
    let firstLine = lines[0];
    assert.equal(
      firstLine.length,
      70,
      "Width should clamp to min 70 when terminal is 50",
    );

    // Test max clamp (120)
    lines = overlay.render(150);
    firstLine = lines[0];
    assert.equal(
      firstLine.length,
      120,
      "Width should clamp to max 120 when terminal is 150",
    );

    // Test normal range (90)
    lines = overlay.render(90);
    firstLine = lines[0];
    assert.equal(
      firstLine.length,
      90,
      "Width should be 90 when terminal is 90",
    );
  });

  test("overlay is focusable", () => {
    let result: any = null;
    const overlay = new IntentOverlayComponent(
      emptyStore,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    assert.equal(
      typeof overlay.focused,
      "boolean",
      "Should have focused property",
    );
    assert.equal(
      typeof overlay.handleInput,
      "function",
      "Should have handleInput method",
    );
  });
});

describe("IntentOverlayComponent - Search", () => {
  test("search field appears at top of list view", () => {
    const store: IntentStore = {
      intents: [makeIntent({ title: "Test intent" })],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to list
    overlay.handleInput("\x1b[B"); // Down to "List intents"
    overlay.handleInput("\r"); // Enter

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(content.includes("Search:"), "Should show search field");
  });

  test("typing in search field filters intents by title", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "Auth bug fix", phase: "done" }),
        makeIntent({
          id: "id2",
          title: "Database migration",
          phase: "implementing",
        }),
        makeIntent({ id: "id3", title: "Auth tests", phase: "defining" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to list
    overlay.handleInput("\x1b[B"); // Down to "List intents"
    overlay.handleInput("\r"); // Enter

    // Type "auth" in search
    overlay.handleInput("a");
    overlay.handleInput("u");
    overlay.handleInput("t");
    overlay.handleInput("h");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(
      content.includes("Auth bug fix"),
      "Should show first auth intent",
    );
    assert.ok(content.includes("Auth tests"), "Should show second auth intent");
    assert.ok(
      !content.includes("Database migration"),
      "Should not show database intent",
    );
    assert.ok(content.includes("(2 results)"), "Should show result count");
  });

  test("search filters by phase name", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "First", phase: "done" }),
        makeIntent({ id: "id2", title: "Second", phase: "implementing" }),
        makeIntent({ id: "id3", title: "Third", phase: "defining" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to list
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");

    // Type "done"
    overlay.handleInput("d");
    overlay.handleInput("o");
    overlay.handleInput("n");
    overlay.handleInput("e");

    const lines = overlay.render(80);
    const content = lines.join("\n");

    assert.ok(content.includes("First"), "Should show done intent");
    assert.ok(
      !content.includes("Second"),
      "Should not show implementing intent",
    );
    assert.ok(!content.includes("Third"), "Should not show defining intent");
    assert.ok(
      content.includes("(1 result)"),
      "Should show singular result count",
    );
  });

  test("escape clears search and shows all intents", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "Auth bug fix" }),
        makeIntent({ id: "id2", title: "Database migration" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to list and search
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    overlay.handleInput("a");
    overlay.handleInput("u");
    overlay.handleInput("t");
    overlay.handleInput("h");

    let lines = overlay.render(80);
    let content = lines.join("\n");
    assert.ok(
      !content.includes("Database migration"),
      "Database should be filtered",
    );

    // Press escape to clear
    overlay.handleInput("\x1b");

    lines = overlay.render(80);
    content = lines.join("\n");
    assert.ok(content.includes("Auth bug fix"), "Should show auth intent");
    assert.ok(
      content.includes("Database migration"),
      "Should show database intent",
    );
    assert.ok(!content.includes("results"), "Should not show result count");
  });

  test("navigation works after search", () => {
    const store: IntentStore = {
      intents: [
        makeIntent({ id: "id1", title: "First" }),
        makeIntent({ id: "id2", title: "Second" }),
      ],
    };

    let result: any = null;
    const overlay = new IntentOverlayComponent(
      store,
      mockTheme(),
      (r) => {
        result = r;
      },
      "/tmp/test",
    );

    // Navigate to list, clear search, move to list items
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    overlay.handleInput("\x1b"); // Escape to clear search
    overlay.handleInput("\x1b[B"); // Down to first item

    const lines = overlay.render(80);
    const content = lines.join("\n");

    // Selection indicator should be on one of the items
    assert.ok(content.includes("▶"), "Should show selection indicator");
  });
});
