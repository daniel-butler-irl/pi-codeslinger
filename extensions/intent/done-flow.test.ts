import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { squashMergeWorktree, mergeStatus } from "./done-flow.ts";
import { createWorktree } from "./worktree-manager.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-done-")));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "main\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("squashMergeWorktree merges clean branch into main", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-done-base-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Feat", "abcdef01");
    writeFileSync(join(path, "feat.txt"), "feat\n");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["commit", "-m", "add feat"], { cwd: path });

    const status = squashMergeWorktree(dir, branch, "feat: merge");
    assert.equal(status.kind, "merged");
    assert.equal(existsSync(join(dir, "feat.txt")), true);
    assert.equal(readFileSync(join(dir, "feat.txt"), "utf-8"), "feat\n");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("squashMergeWorktree returns conflict status on conflicting changes", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-done-base2-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Conf", "abcdef02");
    writeFileSync(join(path, "README"), "wt-side\n");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["commit", "-m", "wt change"], { cwd: path });
    writeFileSync(join(dir, "README"), "main-side\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "main change"], { cwd: dir });

    const status = squashMergeWorktree(dir, branch, "feat: merge");
    assert.equal(status.kind, "conflict");
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
    assert.equal(out.trim(), "");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("squashMergeWorktree treats empty branch as merged", () => {
  const { dir, cleanup } = initRepo();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-done-base3-")));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { branch } = createWorktree(dir, "Empty", "abcdef03");
    // no commits on the branch beyond what was already on main
    const status = squashMergeWorktree(dir, branch, "feat: empty");
    assert.equal(status.kind, "merged");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});
