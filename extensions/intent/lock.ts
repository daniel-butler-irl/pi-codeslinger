/**
 * Advisory file lock around `intents.json`. proper-lockfile handles
 * stale-lock reclaim natively via its `stale` option (rejects locks
 * older than the threshold so a new acquirer can take over).
 *
 * `forceUnlock` is the manual-override escape hatch surfaced as
 * `/intent unlock` for cases where auto-reclaim doesn't kick in.
 */
import lockfile from "proper-lockfile";
import { existsSync, rmSync } from "node:fs";

const STALE_MS = 60_000;
const RETRIES = { retries: 10, minTimeout: 50, maxTimeout: 500 };

export async function withExclusiveLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(filePath, {
    stale: STALE_MS,
    retries: RETRIES,
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Lock may have been force-released; ignore.
    }
  }
}

export function isLocked(filePath: string): boolean {
  // proper-lockfile creates a `<filePath>.lock` directory.
  return existsSync(filePath + ".lock");
}

export function forceUnlock(filePath: string): void {
  if (!isLocked(filePath)) return;
  rmSync(filePath + ".lock", { recursive: true, force: true });
}
