/**
 * Verification runner.
 *
 * Reads the `## Verification` section of an intent's contract, extracts
 * shell commands (markdown code blocks tagged as bash or sh, or simple
 * inline `command` lines), executes each sequentially, and writes the
 * aggregated result to verification.json via the intent store helpers.
 *
 * Principle: the orchestrator runs verification, not the reviewer. The
 * reviewer is read-only and consumes the cached file. That keeps the
 * reviewer's tool surface tight (read/grep/find/ls) and makes the
 * evidence a first-class artifact that survives session turnover.
 */
import { spawnSync } from "child_process";
import {
  loadIntentContent,
  writeVerification,
  type VerificationResult,
} from "../intent/store.ts";

/**
 * Extract executable commands from the `## Verification` section.
 *
 * Two forms are recognised, in order of preference:
 *   1. Fenced code blocks tagged bash/sh/shell/console. Every non-empty,
 *      non-comment line is a separate command.
 *   2. Inline backticked commands on their own line.
 *
 * Anything that doesn't match is treated as prose and ignored.
 */
export function extractVerificationCommands(contract: string): string[] {
  const match = contract.match(
    /^##\s+Verification\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
  );
  if (!match) return [];
  const body = match[1];

  const commands: string[] = [];

  // Fenced code blocks.
  const fenceRe = /```(?:bash|sh|shell|console)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(body)) !== null) {
    for (const line of m[1].split("\n")) {
      const trimmed = line.trim().replace(/^\$\s*/, "");
      if (!trimmed || trimmed.startsWith("#")) continue;
      commands.push(trimmed);
    }
  }

  // Inline backticked single-command lines (one per line only).
  if (commands.length === 0) {
    const inlineRe = /^\s*`([^`]+)`\s*$/gm;
    while ((m = inlineRe.exec(body)) !== null) {
      commands.push(m[1].trim());
    }
  }

  return commands;
}

/**
 * Run every extracted command in sequence from the given cwd. An empty
 * command list yields `passed: false` with an explanatory entry — an
 * intent that declares no commands has not actually been verified.
 */
export function runVerification(
  cwd: string,
  intentId: string,
  options?: { timeoutMs?: number },
): VerificationResult {
  const contract = loadIntentContent(cwd, intentId);
  const commands = extractVerificationCommands(contract);
  const ranAt = new Date().toISOString();

  if (commands.length === 0) {
    const result: VerificationResult = {
      ranAt,
      passed: false,
      commands: [
        {
          command: "(none)",
          exitCode: -1,
          passed: false,
          output:
            "No verification commands found in the intent's Verification " +
            "section. An unverifiable intent cannot be marked done.",
        },
      ],
    };
    writeVerification(cwd, intentId, result);
    return result;
  }

  const timeoutMs = options?.timeoutMs ?? 120_000;
  const results: VerificationResult["commands"] = [];
  let allPassed = true;
  for (const command of commands) {
    const ran = spawnSync("bash", ["-lc", command], {
      cwd,
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    const exitCode = ran.status ?? -1;
    const passed = exitCode === 0 && !ran.error;
    const output = [
      ran.stdout?.trim() ?? "",
      ran.stderr?.trim() ?? "",
      ran.error ? `[runner error] ${ran.error.message}` : "",
    ]
      .filter((s) => s.length > 0)
      .join("\n")
      .slice(0, 8_000); // bound per-command output for sanity
    results.push({ command, exitCode, passed, output });
    if (!passed) allPassed = false;
  }

  const result: VerificationResult = {
    ranAt,
    passed: allPassed,
    commands: results,
  };
  writeVerification(cwd, intentId, result);
  return result;
}
