/**
 * Tests for the intent store.
 *
 * Runs with Node's built-in test runner via --experimental-strip-types,
 * which lets Node execute TypeScript directly without a build step.
 * No test framework needed — just: node --experimental-strip-types store.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "fs";
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
  intentContractPath,
  intentDir,
  intentLogPath,
  intentVerificationPath,
  getChildren,
  getParent,
  getRoot,
  getActivePath,
  canTransition,
  transitionPhase,
  appendLogEntry,
  readLog,
  writeVerification,
  readVerification,
  type Intent,
  type IntentPhase,
} from "./store.ts";
import { existsSync } from "fs";

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
  test("persists and restores a modern intent", () => {
    withTempDir((cwd) => {
      const intent: Intent = {
        id: "abc",
        title: "Test",
        createdAt: 1,
        updatedAt: 2,
        parentId: null,
        phase: "implementing",
        reworkCount: 3,
      };
      const original = { activeIntentId: "abc", intents: [intent] };
      saveStore(cwd, original);
      const loaded = loadStore(cwd);
      assert.deepEqual(loaded, original);
    });
  });
});

describe("loadStore migration", () => {
  test("fills defaults for legacy intents missing new fields", () => {
    withTempDir((cwd) => {
      // Simulate an on-disk store written by an older version of the code.
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "intents.json"),
        JSON.stringify({
          activeIntentId: "legacy-1",
          intents: [{ id: "legacy-1", title: "Old intent", createdAt: 1000 }],
        }),
      );

      const store = loadStore(cwd);
      assert.equal(store.intents.length, 1);
      const loaded = store.intents[0];
      assert.equal(loaded.parentId, null);
      assert.equal(loaded.phase, "defining");
      assert.equal(loaded.reworkCount, 0);
      assert.equal(loaded.updatedAt, 1000); // falls back to createdAt
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

  test("writes structured template to .md file", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "my description");
      const content = loadIntentContent(cwd, intent.id);
      assert.ok(content.includes("## Description\nmy description"));
      assert.ok(content.includes("## Success Criteria"));
      assert.ok(content.includes("## Verification"));
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

  test("new intents start in the defining phase with no parent", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "top-level work");
      assert.equal(intent.phase, "defining");
      assert.equal(intent.parentId, null);
      assert.equal(intent.reworkCount, 0);
      assert.ok(intent.updatedAt >= intent.createdAt);
    });
  });

  test("accepts a parentId to create a child intent", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const parent = createIntent(store, cwd, "parent work");
      const child = createIntent(store, cwd, "prereq child", {
        parentId: parent.id,
      });
      assert.equal(child.parentId, parent.id);
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

  test("refuses to delete an intent that has children", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const parent = createIntent(store, cwd, "parent");
      createIntent(store, cwd, "child", { parentId: parent.id });
      assert.throws(() => deleteIntent(store, cwd, parent.id), /child intent/);
    });
  });
});

describe("tree traversal", () => {
  test("getChildren returns direct children only", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const childA = createIntent(store, cwd, "A", { parentId: root.id });
      const childB = createIntent(store, cwd, "B", { parentId: root.id });
      createIntent(store, cwd, "grandchild", { parentId: childA.id });

      const children = getChildren(store, root.id);
      const ids = children.map((c) => c.id).sort();
      assert.deepEqual(ids, [childA.id, childB.id].sort());
    });
  });

  test("getParent returns the parent intent", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const child = createIntent(store, cwd, "child", { parentId: root.id });
      assert.equal(getParent(store, child.id)?.id, root.id);
    });
  });

  test("getParent returns undefined for top-level intents", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      assert.equal(getParent(store, root.id), undefined);
    });
  });

  test("getRoot walks up to the top-level ancestor", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const mid = createIntent(store, cwd, "mid", { parentId: root.id });
      const leaf = createIntent(store, cwd, "leaf", { parentId: mid.id });
      assert.equal(getRoot(store, leaf.id)?.id, root.id);
    });
  });

  test("getRoot returns the intent itself if it is top-level", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      assert.equal(getRoot(store, root.id)?.id, root.id);
    });
  });

  test("getActivePath returns root→active order", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const mid = createIntent(store, cwd, "mid", { parentId: root.id });
      const leaf = createIntent(store, cwd, "leaf", { parentId: mid.id });
      // createIntent sets activeIntentId to the newest, so leaf is active.
      assert.equal(store.activeIntentId, leaf.id);

      const path = getActivePath(store);
      assert.deepEqual(
        path.map((i) => i.id),
        [root.id, mid.id, leaf.id],
      );
    });
  });

  test("getActivePath is empty when no intent is active", () => {
    const store = { activeIntentId: null, intents: [] };
    assert.deepEqual(getActivePath(store), []);
  });
});

describe("phase transitions", () => {
  const legal: Array<[IntentPhase, IntentPhase]> = [
    ["defining", "implementing"],
    ["defining", "blocked-on-child"],
    ["implementing", "reviewing"],
    ["implementing", "blocked-on-child"],
    ["reviewing", "implementing"],
    ["reviewing", "done"],
    ["blocked-on-child", "defining"],
    ["blocked-on-child", "implementing"],
  ];

  const illegal: Array<[IntentPhase, IntentPhase]> = [
    ["defining", "done"],
    ["defining", "reviewing"],
    ["implementing", "done"],
    ["implementing", "defining"],
    ["reviewing", "defining"],
    ["reviewing", "blocked-on-child"],
    ["done", "defining"],
    ["done", "implementing"],
  ];

  for (const [from, to] of legal) {
    test(`allows ${from} → ${to}`, () => {
      assert.equal(canTransition(from, to), true);
    });
  }

  for (const [from, to] of illegal) {
    test(`rejects ${from} → ${to}`, () => {
      assert.equal(canTransition(from, to), false);
    });
  }

  test("transitionPhase mutates phase and bumps updatedAt", async () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      const originalUpdated = intent.updatedAt;
      // Tiny pause so the timestamp can advance.
      const start = Date.now();
      while (Date.now() === start) {
        /* spin one ms */
      }
      transitionPhase(store, intent.id, "implementing");
      assert.equal(intent.phase, "implementing");
      assert.ok(intent.updatedAt > originalUpdated);
    });
  });

  test("transitionPhase throws on illegal transition", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      assert.throws(
        () => transitionPhase(store, intent.id, "done"),
        /Illegal phase transition/,
      );
    });
  });

  test("transitionPhase throws on unknown id", () => {
    const store: { activeIntentId: null; intents: Intent[] } = {
      activeIntentId: null,
      intents: [],
    };
    assert.throws(
      () => transitionPhase(store, "nope", "implementing"),
      /Intent not found/,
    );
  });
});

describe("file layout", () => {
  test("createIntent writes into a per-intent directory", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "layout test");
      assert.ok(existsSync(intentDir(cwd, intent.id)));
      assert.ok(existsSync(intentContractPath(cwd, intent.id)));
    });
  });

  test("intentFilePath aliases intentContractPath", () => {
    withTempDir((cwd) => {
      assert.equal(intentFilePath(cwd, "abc"), intentContractPath(cwd, "abc"));
    });
  });

  test("loadStore migrates legacy <id>.md files into <id>/intent.md", async () => {
    withTempDir(async (cwd) => {
      const { mkdirSync: mk, writeFileSync: wf } = await import("fs");
      const id = "legacy-id";
      // Write a legacy single-file intent.
      mk(join(cwd, ".pi", "intents"), { recursive: true });
      wf(join(cwd, ".pi", "intents", `${id}.md`), "# Legacy body\n", "utf-8");
      wf(
        join(cwd, ".pi", "intents.json"),
        JSON.stringify({
          activeIntentId: id,
          intents: [{ id, title: "Legacy", createdAt: 1 }],
        }),
        "utf-8",
      );

      // Loading triggers migration.
      loadStore(cwd);

      assert.ok(
        existsSync(intentContractPath(cwd, id)),
        "new contract file should exist",
      );
      assert.equal(
        existsSync(join(cwd, ".pi", "intents", `${id}.md`)),
        false,
        "legacy file should be gone",
      );
      assert.equal(loadIntentContent(cwd, id), "# Legacy body\n");
    });
  });

  test("deleteIntent removes the whole intent directory", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      // Seed a log so we can prove the dir (not just intent.md) is gone.
      appendLogEntry(cwd, intent.id, { kind: "discovery", body: "note" });
      deleteIntent(store, cwd, intent.id);
      assert.equal(existsSync(intentDir(cwd, intent.id)), false);
    });
  });
});

describe("log and verification helpers", () => {
  test("appendLogEntry creates and appends a timestamped block", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      appendLogEntry(cwd, intent.id, {
        kind: "discovery",
        body: "UserService already handles rate limiting",
      });
      appendLogEntry(cwd, intent.id, {
        kind: "decision",
        body: "Reuse existing middleware rather than add a new one",
      });
      const log = readLog(cwd, intent.id);
      assert.ok(log.includes("## ["));
      assert.ok(log.includes("discovery"));
      assert.ok(log.includes("decision"));
      assert.ok(log.includes("UserService already handles rate limiting"));
      assert.ok(log.includes("Reuse existing middleware"));
    });
  });

  test("readLog returns empty string when no log exists", () => {
    withTempDir((cwd) => {
      assert.equal(readLog(cwd, "nonexistent"), "");
    });
  });

  test("writeVerification + readVerification round-trip", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      const result = {
        ranAt: "2026-04-21T12:00:00.000Z",
        passed: false,
        commands: [
          {
            command: "npm test",
            exitCode: 1,
            passed: false,
            output: "2 tests failed",
          },
        ],
      };
      writeVerification(cwd, intent.id, result);
      assert.ok(existsSync(intentVerificationPath(cwd, intent.id)));
      assert.deepEqual(readVerification(cwd, intent.id), result);
    });
  });

  test("readVerification returns null when no file exists", () => {
    withTempDir((cwd) => {
      assert.equal(readVerification(cwd, "nonexistent"), null);
    });
  });

  test("intentLogPath returns the log location inside the intent dir", () => {
    withTempDir((cwd) => {
      assert.ok(intentLogPath(cwd, "abc").endsWith(join("abc", "log.md")));
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
