/**
 * Resolve the main repo's `.pi/` paths from any cwd, including from a
 * feature worktree. The "main repo" is the worktree whose checked-out
 * branch is `main`. If the cwd isn't in a git repo, fall back to cwd
 * (test/dev convenience).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function mainRepoRoot(cwd: string): string {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return cwd; // not a git repo — fall back
  }

  // Parse porcelain: blocks separated by blank lines, each starts with
  // "worktree <path>" and contains a "branch refs/heads/<name>" line.
  const blocks = porcelain.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.startsWith("branch ")) branch = line.slice(7).trim();
    }
    if (path && branch === "refs/heads/main") return path;
  }
  // No main worktree found (detached HEAD on main, etc.) — fall back.
  return cwd;
}

export function mainPiDir(cwd: string): string {
  return join(mainRepoRoot(cwd), ".pi");
}

export function mainIntentsJsonPath(cwd: string): string {
  return join(mainPiDir(cwd), "intents.json");
}

export function mainIntentDir(cwd: string, id: string): string {
  return join(mainPiDir(cwd), "intents", id);
}

export function mainIntentContractPath(cwd: string, id: string): string {
  return join(mainIntentDir(cwd, id), "intent.md");
}
