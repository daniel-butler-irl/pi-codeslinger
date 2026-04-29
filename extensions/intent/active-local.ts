/**
 * Per-worktree active intent. Stored in `<git-dir>/pi-active-intent`,
 * where `<git-dir>` is what `git rev-parse --git-dir` returns for the
 * given cwd. In a linked worktree this is `.git/worktrees/<name>/`,
 * which is unique per worktree, so each worktree has its own active
 * intent independently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

function gitDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return isAbsolute(out) ? out : resolve(cwd, out);
  } catch {
    return null;
  }
}

function activeFile(cwd: string): string | null {
  const g = gitDir(cwd);
  return g ? join(g, "pi-active-intent") : null;
}

export function readActiveIntent(cwd: string): string | null {
  const f = activeFile(cwd);
  if (!f || !existsSync(f)) return null;
  const v = readFileSync(f, "utf-8").trim();
  return v.length === 0 ? null : v;
}

export function writeActiveIntent(cwd: string, id: string | null): void {
  const f = activeFile(cwd);
  if (!f) return; // not in a git repo — no-op
  if (id === null) {
    if (existsSync(f)) unlinkSync(f);
    return;
  }
  writeFileSync(f, id, "utf-8");
}
