import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  slugify,
  branchName,
  worktreePath,
  createWorktree,
  removeWorktree,
  isDirty,
  shortId,
} from "./worktree-manager.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-")));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("slugify lowercases, replaces non-alphanum with hyphens, caps length", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugify("UPPER lower 123"), "upper-lower-123");
  const long = "a".repeat(100);
  assert.equal(slugify(long).length, 60);
});

test("shortId returns first 8 chars", () => {
  assert.equal(shortId("e609fe06-6dd3-4029"), "e609fe06");
});

test("branchName is intent/<slug>-<short-id>", () => {
  assert.equal(branchName("Foo Bar", "abcdef01-2345"), "intent/foo-bar-abcdef01");
});

test("worktreePath uses PI_WORKTREE_BASE override", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-wtbase-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const p = worktreePath("/path/to/myrepo", "Foo", "abcdef01");
    assert.equal(p, join(base, "myrepo", "foo-abcdef01"));
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
  }
});

test("createWorktree creates branch + worktree dir off main", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-wtbase2-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Test Intent", "abcdef01");
    assert.equal(branch, "intent/test-intent-abcdef01");
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(path, "README")), true);
    const out = execFileSync("git", ["branch", "--list", branch], { cwd: dir, encoding: "utf-8" });
    assert.match(out, /test-intent-abcdef01/);
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("isDirty detects uncommitted changes", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-wtbase3-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path } = createWorktree(dir, "Dirty Test", "abcdef02");
    assert.equal(isDirty(path), false);
    writeFileSync(join(path, "newfile"), "x");
    assert.equal(isDirty(path), true);
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("removeWorktree force-removes dir + branch", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-wtbase4-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Rm Test", "abcdef03");
    assert.equal(existsSync(path), true);
    removeWorktree(dir, path, branch);
    assert.equal(existsSync(path), false);
    const out = execFileSync("git", ["branch", "--list", branch], { cwd: dir, encoding: "utf-8" });
    assert.equal(out.trim(), "");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});
