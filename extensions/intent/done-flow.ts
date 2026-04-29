/**
 * Done-flow operations: squash-merge a worktree branch into main and
 * recover cleanly on conflict.
 *
 * Caller (index.ts handleDoneTransition) orchestrates:
 *   1. Reject if the worktree is dirty (uncommitted changes).
 *   2. squashMergeWorktree(...) — abort on conflict.
 *   3. On success: prompt user; optionally removeWorktree(...).
 */
import { execFileSync } from "node:child_process";
import { mainRepoRoot } from "./paths.ts";

export type MergeStatus =
  | { kind: "merged"; branch: string }
  | { kind: "conflict"; branch: string; message: string }
  | { kind: "error"; branch: string; message: string };

export function squashMergeWorktree(
  cwd: string,
  branch: string,
  commitMessage: string,
): MergeStatus {
  const main = mainRepoRoot(cwd);
  try {
    execFileSync("git", ["checkout", "main"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { kind: "error", branch, message: `Could not checkout main: ${(err as Error).message}` };
  }
  try {
    execFileSync("git", ["merge", "--squash", branch], { cwd: main, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] }); } catch {}
    try { execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] }); } catch {}
    return { kind: "conflict", branch, message: (err as Error).message };
  }
  try {
    execFileSync("git", ["commit", "-m", commitMessage], {
      cwd: main,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // execFileSync puts stdout/stderr on the error object when stdio is "pipe"
    const out = ((err as NodeJS.ErrnoException & { stdout?: Buffer }).stdout?.toString() ?? "") +
                ((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString() ?? "");
    if (
      msg.includes("nothing to commit") ||
      msg.includes("nothing added to commit") ||
      out.includes("nothing to commit") ||
      out.includes("nothing added to commit")
    ) {
      return { kind: "merged", branch };
    }
    // Real commit failure: staged but uncommitted. Reset to clean state and report.
    try {
      execFileSync("git", ["reset", "--hard", "HEAD"], {
        cwd: main,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {}
    return { kind: "error", branch, message: `Commit failed after squash: ${msg}` };
  }
  return { kind: "merged", branch };
}

export function mergeStatus(s: MergeStatus): string {
  if (s.kind === "merged") return `Merged ${s.branch} into main.`;
  if (s.kind === "conflict") return `Merge conflict on ${s.branch}: ${s.message}`;
  return `Merge error on ${s.branch}: ${s.message}`;
}
