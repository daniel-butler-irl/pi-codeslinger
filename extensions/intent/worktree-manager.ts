/**
 * Git worktree lifecycle for intents.
 *
 * Branch: `intent/<slug>-<short-id>`.
 * Path:   `<base>/<repo-name>/<slug>-<short-id>/`
 *         where `<base>` defaults to `~/.pi/repos`, overridable via
 *         `PI_WORKTREE_BASE` env var.
 *
 * Worktrees are always branched off `main` HEAD.
 */
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mainRepoRoot } from "./paths.ts";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function branchName(title: string, id: string): string {
  return `intent/${slugify(title)}-${shortId(id)}`;
}

export function worktreeBase(): string {
  return process.env.PI_WORKTREE_BASE ?? join(homedir(), ".pi", "repos");
}

export function worktreePath(repoRoot: string, title: string, id: string): string {
  return join(worktreeBase(), basename(repoRoot), `${slugify(title)}-${shortId(id)}`);
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export function createWorktree(repoRoot: string, title: string, id: string): CreatedWorktree {
  const main = mainRepoRoot(repoRoot);
  const branch = branchName(title, id);
  const path = worktreePath(main, title, id);
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path}`);
  }
  execFileSync("git", ["worktree", "add", "-b", branch, path, "main"], {
    cwd: main,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gitDirOut = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: path,
    encoding: "utf-8",
  }).trim();
  const gitDirAbs = gitDirOut.startsWith("/") ? gitDirOut : join(path, gitDirOut);
  const excludeDir = join(gitDirAbs, "info");
  mkdirSync(excludeDir, { recursive: true });
  writeFileSync(
    join(excludeDir, "exclude"),
    ["# Pi worktree: shared intent metadata lives on main only", ".pi/intents.json", ".pi/intents/*/intent.md", ""].join("\n"),
  );
  return { path, branch };
}

export function isDirty(worktreePath: string): boolean {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim().length > 0;
}

export function removeWorktree(repoRoot: string, worktreePath: string, branch: string): void {
  const main = mainRepoRoot(repoRoot);
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: main,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  }
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: main,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // branch may not exist
  }
}
