import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mainRepoRoot, mainPiDir, mainIntentsJsonPath, mainIntentDir, mainIntentContractPath } from "./paths.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-paths-")));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("mainRepoRoot returns cwd when on main branch", () => {
  const { dir, cleanup } = initRepo();
  try {
    assert.equal(mainRepoRoot(dir), dir);
  } finally {
    cleanup();
  }
});

test("mainRepoRoot returns main worktree path from a feature worktree", () => {
  const { dir, cleanup } = initRepo();
  try {
    const wtPath = join(dir, "..", "wt-feat");
    execFileSync("git", ["worktree", "add", "-b", "feat", wtPath], { cwd: dir });
    try {
      assert.equal(mainRepoRoot(wtPath), dir);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir });
    }
  } finally {
    cleanup();
  }
});

test("mainPiDir / mainIntentsJsonPath / mainIntentDir / mainIntentContractPath compose correctly", () => {
  const { dir, cleanup } = initRepo();
  try {
    assert.equal(mainPiDir(dir), join(dir, ".pi"));
    assert.equal(mainIntentsJsonPath(dir), join(dir, ".pi", "intents.json"));
    assert.equal(mainIntentDir(dir, "abc-123"), join(dir, ".pi", "intents", "abc-123"));
    assert.equal(
      mainIntentContractPath(dir, "abc-123"),
      join(dir, ".pi", "intents", "abc-123", "intent.md"),
    );
  } finally {
    cleanup();
  }
});

test("mainRepoRoot falls back to cwd outside a git repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-paths-nogit-")));
  try {
    assert.equal(mainRepoRoot(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
