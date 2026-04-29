import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readActiveIntent, writeActiveIntent } from "./active-local.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-active-")));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readActiveIntent returns null when unset", () => {
  const { dir, cleanup } = initRepo();
  try {
    assert.equal(readActiveIntent(dir), null);
  } finally {
    cleanup();
  }
});

test("writeActiveIntent + readActiveIntent round-trip", () => {
  const { dir, cleanup } = initRepo();
  try {
    writeActiveIntent(dir, "abc-123");
    assert.equal(readActiveIntent(dir), "abc-123");
    writeActiveIntent(dir, null);
    assert.equal(readActiveIntent(dir), null);
  } finally {
    cleanup();
  }
});

test("active intent is per-worktree (not shared)", () => {
  const { dir, cleanup } = initRepo();
  try {
    const wtPath = realpathSync(mkdtempSync(join(tmpdir(), "active-wt-feat-"))).replace(/[^/]+$/, "wt-feat");
    // Create wt as a sibling we control:
    const sibling = join(dir, "..", "active-wt-sibling");
    execFileSync("git", ["worktree", "add", "-b", "feat", sibling], { cwd: dir });
    const realSibling = realpathSync(sibling);
    try {
      writeActiveIntent(dir, "main-id");
      writeActiveIntent(realSibling, "feat-id");
      assert.equal(readActiveIntent(dir), "main-id");
      assert.equal(readActiveIntent(realSibling), "feat-id");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", sibling], { cwd: dir });
    }
  } finally {
    cleanup();
  }
});

test("readActiveIntent returns null outside a git repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-active-nogit-")));
  try {
    assert.equal(readActiveIntent(dir), null);
    // writeActiveIntent should silently no-op (not throw)
    writeActiveIntent(dir, "x");
    assert.equal(readActiveIntent(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
