/**
 * Durable persistence for orchestrator PendingSignals.
 *
 * In-memory FlightTable.pendingSignal is lost on process death. This store
 * mirrors the writeReviewResult pattern (intent/store.ts) so that proposal,
 * spawn-child, and question signals survive a crash and are replayed by the
 * driver on the next session_start.
 *
 * File: <intent-cwd>/.pi/intents/<id>/pending-signal.json
 * Schema: serialized PendingSignal discriminated union from state.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { PendingSignal } from "./state.ts";

export function pendingSignalPath(cwd: string, intentId: string): string {
  return join(cwd, ".pi", "intents", intentId, "pending-signal.json");
}

export function writePendingSignal(
  cwd: string,
  intentId: string,
  signal: PendingSignal,
): void {
  const path = pendingSignalPath(cwd, intentId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(signal, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

export function readPendingSignal(
  cwd: string,
  intentId: string,
): PendingSignal | null {
  try {
    const raw = readFileSync(pendingSignalPath(cwd, intentId), "utf-8");
    return JSON.parse(raw) as PendingSignal;
  } catch {
    return null;
  }
}

export function clearPendingSignal(cwd: string, intentId: string): void {
  const path = pendingSignalPath(cwd, intentId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
