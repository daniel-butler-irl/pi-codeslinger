/**
 * Minimal header extension.
 *
 * Replaces Pi's verbose keyboard-shortcut welcome screen with a single compact
 * line showing the project directory and current git branch.
 *
 *   pi  ~/IdeaProjects/public/pi-codeslinger  (main)
 */
import { execSync } from "child_process";
import { homedir } from "os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function gitBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function shortenPath(fullPath: string): string {
  const home = homedir();
  return fullPath.startsWith(home)
    ? "~" + fullPath.slice(home.length)
    : fullPath;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const cwd = ctx.cwd;

    ctx.ui.setHeader((_tui, theme) => {
      const accent = (s: string) => theme.fg("accent", s);
      const dim = (s: string) => theme.fg("dim", s);
      const bold = (s: string) => theme.bold(s);

      return {
        render(_width: number): string[] {
          const branch = gitBranch(cwd);
          const path = shortenPath(cwd);
          const branchPart = branch ? dim("  (" + branch + ")") : "";
          return [" " + bold(accent("pi")) + "  " + dim(path) + branchPart];
        },
        invalidate() {},
      };
    });
  });
}
