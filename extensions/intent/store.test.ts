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
import { execFileSync } from "node:child_process";
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
  intentUnderstandingPath,
  intentVerificationPath,
  getChildren,
  getParent,
  getRoot,
  getActivePath,
  canTransition,
  transitionPhase,
  appendLogEntry,
  readLog,
  readUnderstanding,
  writeUnderstanding,
  writeVerification,
  readVerification,
  type Intent,
  type IntentPhase,
} from "./store.ts";
import { readActiveIntent, writeActiveIntent } from "./active-local.ts";
import { existsSync } from "fs";

async function withTempDir(fn: (cwd: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-intent-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Like withTempDir but initialises a git repo so writeActiveIntent works. */
async function withGitTempDir(fn: (cwd: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-intent-git-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    await fn(dir);
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
  test("returns empty store when file does not exist", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      assert.deepEqual(store.intents, []);
    });
  });

  test("returns empty store when file is corrupt", async () => {
    await withTempDir((cwd) => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "intents.json"), "not json");
      const store = loadStore(cwd);
      assert.deepEqual(store.intents, []);
    });
  });
});

describe("saveStore / loadStore round-trip", () => {
  test("persists and restores a modern intent", async () => {
    await withTempDir(async (cwd) => {
      const intent: Intent = {
        id: "abc",
        title: "Test",
        createdAt: 1,
        updatedAt: 2,
        parentId: null,
        phase: "implementing",
        reworkCount: 3,
      };
      const original = { intents: [intent] };
      await saveStore(cwd, original);
      const loaded = loadStore(cwd);
      assert.deepEqual(loaded, original);
    });
  });
});

describe("loadStore migration", () => {
  test("fills defaults for legacy intents missing new fields", async () => {
    await withTempDir((cwd) => {
      // Simulate an on-disk store written by an older version of the code.
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "intents.json"),
        JSON.stringify({
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
  test("adds intent to the store", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "fix the login bug");
      assert.equal(store.intents.length, 1);
      assert.equal(store.intents[0].title, "Fix the login bug");
      assert.equal(store.intents[0].id, intent.id);
    });
  });

  test("caller can set intent as active via writeActiveIntent", async () => {
    await withGitTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "fix the login bug");
      writeActiveIntent(cwd, intent.id);
      assert.equal(readActiveIntent(cwd), intent.id);
    });
  });

  test("writes structured template to .md file", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "my description");
      const content = loadIntentContent(cwd, intent.id);
      assert.ok(content.includes("## Description\nmy description"));
      assert.ok(content.includes("## Success Criteria"));
      assert.ok(content.includes("## Verification"));
    });
  });

  test("multiple intents can be created independently", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      createIntent(store, cwd, "first intent");
      createIntent(store, cwd, "second intent");
      assert.equal(store.intents.length, 2);
    });
  });

  test("new intents start in the defining phase with no parent", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "top-level work");
      assert.equal(intent.phase, "defining");
      assert.equal(intent.parentId, null);
      assert.equal(intent.reworkCount, 0);
      assert.ok(intent.updatedAt >= intent.createdAt);
    });
  });

  test("accepts a parentId to create a child intent", async () => {
    await withTempDir((cwd) => {
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
  test("removes intent from store", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      deleteIntent(store, cwd, intent.id);
      assert.equal(store.intents.length, 0);
    });
  });

  test("does not manage active state — caller must clean up", async () => {
    await withGitTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      writeActiveIntent(cwd, intent.id);
      deleteIntent(store, cwd, intent.id);
      // deleteIntent does not clear active state; caller is responsible
      assert.equal(store.intents.length, 0);
      // active file still points to the deleted id — caller must clear it
      assert.equal(readActiveIntent(cwd), intent.id);
      // caller cleans up:
      writeActiveIntent(cwd, null);
      assert.equal(readActiveIntent(cwd), null);
    });
  });

  test("removes the .md file", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "to delete");
      const path = intentFilePath(cwd, intent.id);
      deleteIntent(store, cwd, intent.id);
      assert.throws(() => readFileSync(path), /ENOENT/);
    });
  });

  test("refuses to delete an intent that has children", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const parent = createIntent(store, cwd, "parent");
      createIntent(store, cwd, "child", { parentId: parent.id });
      assert.throws(() => deleteIntent(store, cwd, parent.id), /child intent/);
    });
  });
});

describe("tree traversal", () => {
  test("getChildren returns direct children only", async () => {
    await withTempDir((cwd) => {
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

  test("getParent returns the parent intent", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const child = createIntent(store, cwd, "child", { parentId: root.id });
      assert.equal(getParent(store, child.id)?.id, root.id);
    });
  });

  test("getParent returns undefined for top-level intents", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      assert.equal(getParent(store, root.id), undefined);
    });
  });

  test("getRoot walks up to the top-level ancestor", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const mid = createIntent(store, cwd, "mid", { parentId: root.id });
      const leaf = createIntent(store, cwd, "leaf", { parentId: mid.id });
      assert.equal(getRoot(store, leaf.id)?.id, root.id);
    });
  });

  test("getRoot returns the intent itself if it is top-level", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      assert.equal(getRoot(store, root.id)?.id, root.id);
    });
  });

  test("getActivePath returns root→active order", async () => {
    await withGitTempDir((cwd) => {
      const store = loadStore(cwd);
      const root = createIntent(store, cwd, "root");
      const mid = createIntent(store, cwd, "mid", { parentId: root.id });
      const leaf = createIntent(store, cwd, "leaf", { parentId: mid.id });
      // Explicitly set leaf as active via per-worktree storage.
      writeActiveIntent(cwd, leaf.id);
      assert.equal(readActiveIntent(cwd), leaf.id);

      const path = getActivePath(store, cwd);
      assert.deepEqual(
        path.map((i) => i.id),
        [root.id, mid.id, leaf.id],
      );
    });
  });

  test("getActivePath is empty when no intent is active", async () => {
    await withTempDir((cwd) => {
      const store = { intents: [] };
      assert.deepEqual(getActivePath(store, cwd), []);
    });
  });
});

describe("phase transitions", () => {
  const legal: Array<[IntentPhase, IntentPhase]> = [
    ["defining", "implementing"],
    ["defining", "blocked-on-child"],
    ["implementing", "reviewing"],
    ["implementing", "blocked-on-child"],
    ["implementing", "done"],
    ["reviewing", "implementing"],
    ["reviewing", "proposed-ready"],
    ["proposed-ready", "done"],
    ["proposed-ready", "implementing"],
    ["blocked-on-child", "defining"],
    ["blocked-on-child", "implementing"],
  ];

  const illegal: Array<[IntentPhase, IntentPhase]> = [
    ["defining", "done"],
    ["defining", "reviewing"],
    ["implementing", "defining"],
    ["reviewing", "done"],
    ["reviewing", "defining"],
    ["reviewing", "blocked-on-child"],
    ["proposed-ready", "defining"],
    ["proposed-ready", "reviewing"],
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
    await withTempDir((cwd) => {
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

  test("transitionPhase throws on illegal transition", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      assert.throws(
        () => transitionPhase(store, intent.id, "done"),
        /Illegal phase transition/,
      );
    });
  });

  test("transitionPhase throws on unknown id", () => {
    const store: { intents: Intent[] } = {
      intents: [],
    };
    assert.throws(
      () => transitionPhase(store, "nope", "implementing"),
      /Intent not found/,
    );
  });
});

describe("file layout", () => {
  test("createIntent writes into a per-intent directory", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "layout test");
      assert.ok(existsSync(intentDir(cwd, intent.id)));
      assert.ok(existsSync(intentContractPath(cwd, intent.id)));
    });
  });

  test("intentFilePath aliases intentContractPath", async () => {
    await withTempDir((cwd) => {
      assert.equal(intentFilePath(cwd, "abc"), intentContractPath(cwd, "abc"));
    });
  });

  test("loadStore migrates legacy <id>.md files into <id>/intent.md", async () => {
    await withTempDir((cwd) => {
      const id = "legacy-id";
      // Write a legacy single-file intent.
      mkdirSync(join(cwd, ".pi", "intents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "intents", `${id}.md`), "# Legacy body\n", "utf-8");
      writeFileSync(
        join(cwd, ".pi", "intents.json"),
        JSON.stringify({
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

  test("deleteIntent removes the whole intent directory", async () => {
    await withTempDir((cwd) => {
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
  test("appendLogEntry creates and appends a timestamped block", async () => {
    await withTempDir((cwd) => {
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

  test("readLog returns empty string when no log exists", async () => {
    await withTempDir((cwd) => {
      assert.equal(readLog(cwd, "nonexistent"), "");
    });
  });

  test("writeVerification + readVerification round-trip", async () => {
    await withTempDir((cwd) => {
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

  test("readVerification returns null when no file exists", async () => {
    await withTempDir((cwd) => {
      assert.equal(readVerification(cwd, "nonexistent"), null);
    });
  });

  test("intentLogPath returns the log location inside the intent dir", async () => {
    await withTempDir((cwd) => {
      assert.ok(intentLogPath(cwd, "abc").endsWith(join("abc", "log.md")));
    });
  });

  test("intentUnderstandingPath returns the understanding location", async () => {
    await withTempDir((cwd) => {
      assert.ok(
        intentUnderstandingPath(cwd, "abc").endsWith(
          join("abc", "understanding.md"),
        ),
      );
    });
  });

  test("writeUnderstanding + readUnderstanding round-trip", async () => {
    await withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "work");
      const understanding = `Problem: Add JWT auth

Next steps:
1. Create middleware
2. Add tests`;
      writeUnderstanding(cwd, intent.id, understanding);
      assert.ok(existsSync(intentUnderstandingPath(cwd, intent.id)));
      assert.equal(readUnderstanding(cwd, intent.id), understanding);
    });
  });

  test("readUnderstanding returns empty string when no file exists", async () => {
    await withTempDir((cwd) => {
      assert.equal(readUnderstanding(cwd, "nonexistent"), "");
    });
  });
});

describe("getActiveIntent", () => {
  test("returns undefined when no active intent", async () => {
    await withTempDir((cwd) => {
      const store = { intents: [] };
      assert.equal(getActiveIntent(store, cwd), undefined);
    });
  });

  test("returns the active intent when set via writeActiveIntent", async () => {
    await withGitTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "active one");
      writeActiveIntent(cwd, intent.id);
      assert.equal(getActiveIntent(store, cwd)?.id, intent.id);
    });
  });

  test("returns undefined when active id does not match any intent", async () => {
    await withGitTempDir((cwd) => {
      const store = { intents: [] };
      writeActiveIntent(cwd, "no-such-id");
      assert.equal(getActiveIntent(store, cwd), undefined);
    });
  });
});

describe("audit-trail writes go to feature worktree, not main repo", () => {
  test("appendLogEntry writes to the feature worktree, not the main repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-store-audit-wt-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "README"), "x");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

      // Create intent from the main repo (writes contract to main repo).
      const store = loadStore(dir);
      const intent = createIntent(store, dir, "audit trail worktree test");

      const wtPath = join(dir, "..", "audit-wt-feat");
      execFileSync("git", ["worktree", "add", "-b", "audit-feat", wtPath], { cwd: dir });
      try {
        // Call appendLogEntry from the feature worktree path.
        appendLogEntry(wtPath, intent.id, { kind: "discovery", body: "test note" });

        // Log file must exist in the feature worktree.
        assert.ok(
          existsSync(join(wtPath, ".pi", "intents", intent.id, "log.md")),
          "log.md should exist in the feature worktree",
        );
        // Log file must NOT exist in the main repo.
        assert.equal(
          existsSync(join(dir, ".pi", "intents", intent.id, "log.md")),
          false,
          "log.md should NOT be written to the main repo",
        );
      } finally {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadStore reads main repo .pi/ from a feature worktree", () => {
  test("loadStore reads main repo .pi/ from a feature worktree", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync: mktd, writeFileSync: wf, mkdirSync: mk, rmSync: rm } = await import("node:fs");
    const { tmpdir: td } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = mktd(j(td(), "pi-store-wt-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      wf(j(dir, "README"), "x");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

      mk(j(dir, ".pi"), { recursive: true });
      wf(
        j(dir, ".pi", "intents.json"),
        JSON.stringify({ intents: [{ id: "x", title: "T", createdAt: 1, updatedAt: 1, parentId: null, phase: "defining", reworkCount: 0 }] }),
      );

      const wtPath = j(dir, "..", "store-wt-feat");
      execFileSync("git", ["worktree", "add", "-b", "feat", wtPath], { cwd: dir });
      try {
        const store = loadStore(wtPath); // should read main's intents.json
        assert.equal(store.intents.length, 1);
        assert.equal(store.intents[0].id, "x");
      } finally {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir });
      }
    } finally {
      rm(dir, { recursive: true, force: true });
    }
  });
});
