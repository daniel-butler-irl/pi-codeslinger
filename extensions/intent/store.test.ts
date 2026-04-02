/**
 * Tests for the intent store.
 *
 * Runs with Node's built-in test runner via --experimental-strip-types,
 * which lets Node execute TypeScript directly without a build step.
 * No test framework needed — just: node --experimental-strip-types store.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadStore,
  saveStore,
  createIntent,
  deleteIntent,
  getActiveIntent,
  deriveTitle,
  loadIntentContent,
  intentFilePath,
} from "./store.ts";

function withTempDir(fn: (cwd: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-intent-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("deriveTitle", () => {
  test("capitalises first word", () => {
    assert.equal(deriveTitle("fix the auth bug"), "Fix the auth bug");
  });

  test("truncates to 7 words", () => {
    const result = deriveTitle("one two three four five six seven eight nine");
    assert.equal(result, "One two three four five six seven");
  });

  test("handles single word", () => {
    assert.equal(deriveTitle("refactoring"), "Refactoring");
  });

  test("handles empty string", () => {
    assert.equal(deriveTitle(""), "");
  });
});

describe("loadStore", () => {
  test("returns empty store when file does not exist", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      assert.equal(store.activeIntentId, null);
      assert.deepEqual(store.intents, []);
    });
  });

  test("returns empty store when file is corrupt", () => {
    withTempDir((cwd) => {
      import("fs").then(({ mkdirSync, writeFileSync }) => {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "intents.json"), "not json");
      });
      const store = loadStore(cwd);
      assert.equal(store.activeIntentId, null);
    });
  });
});

describe("saveStore / loadStore round-trip", () => {
  test("persists and restores store", () => {
    withTempDir((cwd) => {
      const original = {
        activeIntentId: "abc",
        intents: [{ id: "abc", title: "Test", createdAt: 1 }],
      };
      saveStore(cwd, original);
      const loaded = loadStore(cwd);
      assert.deepEqual(loaded, original);
    });
  });
});

describe("createIntent", () => {
  test("adds intent and sets it as active", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "fix the login bug");
      assert.equal(store.activeIntentId, intent.id);
      assert.equal(store.intents.length, 1);
      assert.equal(store.intents[0].title, "Fix the login bug");
    });
  });

  test("writes description to .md file", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "my description");
      const content = loadIntentContent(cwd, intent.id);
      assert.equal(content, "my description");
    });
  });

  test("switches active intent when second one is created", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      const second = createIntent(store, cwd, "second intent");
      assert.equal(store.activeIntentId, second.id);
      assert.equal(store.intents.length, 2);
    });
  });
});

describe("deleteIntent", () => {
  test("removes intent from store", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      deleteIntent(store, cwd, intent.id);
      assert.equal(store.intents.length, 0);
    });
  });

  test("clears activeIntentId when active intent is deleted", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      deleteIntent(store, cwd, intent.id);
      assert.equal(store.activeIntentId, null);
    });
  });

  test("falls back to most recent remaining intent", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const first = createIntent(store, cwd, "first");
      const second = createIntent(store, cwd, "second");
      deleteIntent(store, cwd, second.id);
      assert.equal(store.activeIntentId, first.id);
    });
  });

  test("removes the .md file", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      const path = intentFilePath(cwd, intent.id);
      deleteIntent(store, cwd, intent.id);
      assert.throws(() => readFileSync(path), /ENOENT/);
    });
  });
});

describe("getActiveIntent", () => {
  test("returns undefined when no active intent", () => {
    const store = { activeIntentId: null, intents: [] };
    assert.equal(getActiveIntent(store), undefined);
  });

  test("returns the active intent", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "active one");
      assert.equal(getActiveIntent(store)?.id, intent.id);
    });
  });
});
