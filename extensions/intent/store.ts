/**
 * Intent store — file-based persistence for the intent bar.
 *
 * Metadata lives in <main-repo>/.pi/intents.json (shared across all worktrees).
 * Rich content (description, goals, tasks, etc.) lives in <main-repo>/.pi/intents/<id>/intent.md.
 * Audit-trail files (log, understanding, verification, review-result) live in
 * the feature worktree's own <cwd>/.pi/intents/<id>/.
 *
 * Separating the two lets the .md file grow freely without touching the metadata
 * index, and lets the LLM read/edit intent content as a plain file.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  rmSync,
  statSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import {
  mainPiDir,
  mainIntentsJsonPath,
  mainIntentDir,
  mainIntentContractPath,
} from "./paths.ts";
import { withExclusiveLock } from "./lock.ts";
import { readActiveIntent } from "./active-local.ts";

/**
 * The lifecycle phase an intent is currently in.
 *
 * - defining: collaborative with the user; intent.md is writable
 * - implementing: locked; an implementer subagent is doing the work
 * - reviewing: locked; an adversarial reviewer subagent is checking the work
 * - proposed-ready: reviewer passed; waiting for human sign-off before done
 * - done: terminal; human signed off after review passed
 * - blocked-on-child: paused while a child (prerequisite) intent completes
 */
export type IntentPhase =
  | "defining"
  | "implementing"
  | "reviewing"
  | "proposed-ready"
  | "done"
  | "blocked-on-child";

export interface Intent {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
  phase: IntentPhase;
  reworkCount: number;
  worktreeBranch?: string;
  worktreePath?: string;
}

/**
 * Top-level store.
 *
 * Active intent tracking is now per-worktree via active-local.ts
 * (readActiveIntent / writeActiveIntent). This store holds only
 * the shared metadata for all intents.
 */
export interface IntentStore {
  intents: Intent[];
}

/**
 * Fill missing fields on a raw intent coming off disk, so older data files
 * stay usable after the schema grew. Defaults are deliberately conservative:
 * unknown intents are treated as top-level, still in "defining", fresh rework
 * count. updatedAt falls back to createdAt — best information we have.
 */
function migrateIntent(
  raw: Partial<Intent> & { id: string; title: string; createdAt: number },
): Intent {
  return {
    id: raw.id,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    parentId: raw.parentId ?? null,
    phase: raw.phase ?? "defining",
    reworkCount: raw.reworkCount ?? 0,
    worktreeBranch: raw.worktreeBranch,
    worktreePath: raw.worktreePath,
  };
}

function piDir(cwd: string): string {
  return mainPiDir(cwd);
}

function storePath(cwd: string): string {
  return mainIntentsJsonPath(cwd);
}

/**
 * Directory that holds the shared contract files for a single intent.
 * Resolves to the main repo's .pi/intents/<id>/ so that the contract
 * file is shared across all worktrees.
 *
 * Layout under <main-repo>/.pi/intents/<id>/:
 *   intent.md          — the contract (locked outside the defining phase)
 *
 * Audit-trail files (log, understanding, verification, review-result) are
 * per-worktree and use local path helpers below.
 */
export function intentDir(cwd: string, id: string): string {
  return mainIntentDir(cwd, id);
}

/**
 * Path to the intent contract file.
 *
 * Returns `<id>/intent.md` under the main repo intent directory.
 */
export function intentContractPath(cwd: string, id: string): string {
  return mainIntentContractPath(cwd, id);
}

/**
 * Local (feature-worktree) directory for per-worktree audit-trail files.
 * Always resolves relative to cwd, never to the main repo.
 */
function localIntentDir(cwd: string, id: string): string {
  return join(cwd, ".pi", "intents", id);
}

/**
 * Audit-trail files live in the feature worktree's own .pi/intents/<id>/.
 * These are per-worktree and do NOT route through the main repo.
 */
export function intentLogPath(cwd: string, id: string): string {
  return join(cwd, ".pi", "intents", id, "log.md");
}

export function intentUnderstandingPath(cwd: string, id: string): string {
  return join(cwd, ".pi", "intents", id, "understanding.md");
}

export function intentVerificationPath(cwd: string, id: string): string {
  return join(cwd, ".pi", "intents", id, "verification.json");
}

export function reviewResultPath(cwd: string, id: string): string {
  return join(cwd, ".pi", "intents", id, "review-result.json");
}

/**
 * Legacy single-file path from before the directory-per-intent layout.
 * Kept only so migration can find and move it. Not used for new intents.
 */
function legacyIntentFilePath(cwd: string, id: string): string {
  return join(piDir(cwd), "intents", `${id}.md`);
}

/**
 * @deprecated Use intentContractPath. Kept as an alias so callers that
 * haven't been updated still resolve to the contract file.
 */
export function intentFilePath(cwd: string, id: string): string {
  return intentContractPath(cwd, id);
}

/**
 * Load the intent store metadata from disk.
 * Returns an empty store if the file doesn't exist or is corrupt.
 */
export function loadStore(cwd: string): IntentStore {
  try {
    const raw = readFileSync(storePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as {
      intents?: Array<
        Partial<Intent> & { id: string; title: string; createdAt: number }
      >;
    };
    const store: IntentStore = {
      intents: (parsed.intents ?? []).map(migrateIntent),
    };
    migrateLegacyFileLayout(cwd, store);
    return store;
  } catch {
    return { intents: [] };
  }
}

/**
 * Move any legacy single-file intents (<id>.md) into the per-intent
 * directory layout (<id>/intent.md). Idempotent — if the directory-form
 * already exists, the legacy file is simply removed.
 */
function migrateLegacyFileLayout(cwd: string, store: IntentStore): void {
  for (const intent of store.intents) {
    const legacy = legacyIntentFilePath(cwd, intent.id);
    if (!existsSync(legacy)) continue;
    try {
      // Only migrate if the legacy path is a real file, not the new directory.
      if (!statSync(legacy).isFile()) continue;
    } catch {
      continue;
    }
    const contract = intentContractPath(cwd, intent.id);
    mkdirSync(intentDir(cwd, intent.id), { recursive: true });
    if (existsSync(contract)) {
      // The new location already exists. Keep it, drop the stale legacy file.
      unlinkSync(legacy);
    } else {
      renameSync(legacy, contract);
    }
  }
}

/**
 * Save the intent store metadata atomically, with an exclusive lock.
 * Creates the file if it doesn't exist (proper-lockfile requires the
 * target file to exist before locking).
 */
export async function saveStore(cwd: string, store: IntentStore): Promise<void> {
  mkdirSync(piDir(cwd), { recursive: true });
  const file = storePath(cwd);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ intents: [] }, null, 2));
  await withExclusiveLock(file, async () => {
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmp, file);
  });
}

/**
 * Read the markdown content for an intent.
 * Returns an empty string if the file doesn't exist yet.
 */
export function loadIntentContent(cwd: string, id: string): string {
  try {
    return readFileSync(intentContractPath(cwd, id), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Write markdown content for an intent.
 */
export function saveIntentContent(
  cwd: string,
  id: string,
  content: string,
): void {
  mkdirSync(intentDir(cwd, id), { recursive: true });
  writeFileSync(intentContractPath(cwd, id), content, "utf-8");
}

// ── Log and verification helpers ────────────────────────────────────────────
//
// The log is append-only; nothing reads back the middle of it, so simple
// appendFile is sufficient. Entries are markdown blocks separated by blank
// lines, timestamped so the sequence is obvious.

export interface LogEntry {
  /** Short tag for the entry type, e.g. "discovery", "decision", "review". */
  kind: string;
  /** Free-form markdown body. */
  body: string;
}

export function appendLogEntry(cwd: string, id: string, entry: LogEntry): void {
  mkdirSync(localIntentDir(cwd, id), { recursive: true });
  const stamp = new Date().toISOString();
  const block = `\n## [${stamp}] ${entry.kind}\n\n${entry.body.trimEnd()}\n`;
  appendFileSync(intentLogPath(cwd, id), block, "utf-8");
}

export function readLog(cwd: string, id: string): string {
  try {
    return readFileSync(intentLogPath(cwd, id), "utf-8");
  } catch {
    return "";
  }
}

export function readUnderstanding(cwd: string, id: string): string {
  try {
    return readFileSync(intentUnderstandingPath(cwd, id), "utf-8");
  } catch {
    return "";
  }
}

export function writeUnderstanding(
  cwd: string,
  id: string,
  content: string,
): void {
  mkdirSync(localIntentDir(cwd, id), { recursive: true });
  const tmp = intentUnderstandingPath(cwd, id) + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, intentUnderstandingPath(cwd, id));
}

export interface VerificationResult {
  /** ISO timestamp of when verification ran. */
  ranAt: string;
  /** Did every command succeed? */
  passed: boolean;
  /** Per-command results. */
  commands: Array<{
    command: string;
    exitCode: number;
    passed: boolean;
    /** Trimmed stdout+stderr for display. */
    output: string;
  }>;
}

export function writeVerification(
  cwd: string,
  id: string,
  result: VerificationResult,
): void {
  mkdirSync(localIntentDir(cwd, id), { recursive: true });
  const tmp = intentVerificationPath(cwd, id) + ".tmp";
  writeFileSync(tmp, JSON.stringify(result, null, 2), "utf-8");
  renameSync(tmp, intentVerificationPath(cwd, id));
}

export function readVerification(
  cwd: string,
  id: string,
): VerificationResult | null {
  try {
    const raw = readFileSync(intentVerificationPath(cwd, id), "utf-8");
    return JSON.parse(raw) as VerificationResult;
  } catch {
    return null;
  }
}

export interface ReviewResult {
  /** The reviewer's verdict. */
  verdict: "pass" | "rework";
  /** Brief summary of the most important findings (2–3 sentences). */
  summary: string;
  /** ISO timestamp of when the review was reported. */
  reviewedAt: string;
  /** Specific issues found (rework only). Persisted so they survive session restarts. */
  findings?: string[];
  /** Suggested fixes for each finding (rework only). */
  nextActions?: string[];
}

export function writeReviewResult(
  cwd: string,
  id: string,
  result: ReviewResult,
): void {
  mkdirSync(localIntentDir(cwd, id), { recursive: true });
  const tmp = reviewResultPath(cwd, id) + ".tmp";
  writeFileSync(tmp, JSON.stringify(result, null, 2), "utf-8");
  renameSync(tmp, reviewResultPath(cwd, id));
}

export function readReviewResult(cwd: string, id: string): ReviewResult | null {
  try {
    const raw = readFileSync(reviewResultPath(cwd, id), "utf-8");
    return JSON.parse(raw) as ReviewResult;
  } catch {
    return null;
  }
}

/**
 * Return the currently active intent for the given worktree, or undefined if none is set.
 * Reads the active intent id from per-worktree storage via active-local.ts.
 */
export function getActiveIntent(store: IntentStore, cwd: string): Intent | undefined {
  const id = readActiveIntent(cwd);
  if (!id) return undefined;
  return store.intents.find((i) => i.id === id);
}

/**
 * Derive a short title from the first 7 words of the description.
 */
export function deriveTitle(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 7);
  const raw = words.join(" ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Build the structured markdown template for a new intent.
 * The HTML comments act as placeholders that validateIntentForLock
 * treats as empty — so the gate works until the user fills them in.
 */
export function intentTemplate(description: string): string {
  return `# Intent

## Description
${description}

## Success Criteria
<!-- What does "done" look like? List specific, verifiable outcomes. -->

## Verification
<!-- How will you verify each criterion? Independent of the LLM. -->
`;
}

/**
 * Create a new intent: adds metadata to the store and writes the initial .md file.
 * Does NOT call saveStore() — caller must do that.
 */
export function createIntent(
  store: IntentStore,
  cwd: string,
  description: string,
  options?: { parentId?: string | null },
): Intent {
  const id = crypto.randomUUID();
  const now = Date.now();
  const intent: Intent = {
    id,
    title: deriveTitle(description),
    createdAt: now,
    updatedAt: now,
    parentId: options?.parentId ?? null,
    phase: "defining",
    reworkCount: 0,
  };
  store.intents.push(intent);
  saveIntentContent(cwd, id, intentTemplate(description));
  return intent;
}

/**
 * Delete an intent by id — removes its directory tree and metadata entry.
 * Caller is responsible for clearing per-worktree active state if the
 * deleted intent was active.
 * Does NOT call saveStore() — caller must do that.
 */
export function deleteIntent(
  store: IntentStore,
  cwd: string,
  id: string,
): void {
  // Refuse to orphan children. If the caller wants the subtree gone, they
  // must delete leaves first. This keeps the tree well-formed under all ops.
  const children = getChildren(store, id);
  if (children.length > 0) {
    throw new Error(
      `Cannot delete intent ${id}: it has ${children.length} child intent(s). Delete children first.`,
    );
  }
  // Remove the whole directory. Also wipe the legacy single-file if it
  // somehow still exists (defence in depth against half-migrated state).
  try {
    rmSync(intentDir(cwd, id), { recursive: true, force: true });
  } catch {
    /* dir may not exist */
  }
  try {
    unlinkSync(legacyIntentFilePath(cwd, id));
  } catch {
    /* legacy file may not exist */
  }
  store.intents = store.intents.filter((i) => i.id !== id);
}

// ── Phase transitions ───────────────────────────────────────────────────────
//
// All legal transitions live here as a single source of truth. Anything
// trying to change an intent's phase goes through transitionPhase() so the
// rules are enforced uniformly.

const LEGAL_TRANSITIONS: Record<IntentPhase, ReadonlySet<IntentPhase>> = {
  defining: new Set(["implementing", "blocked-on-child"]),
  // "done" kept here so the overlay's "skip review" fast-path works without
  // forcing the intent through proposed-ready.
  implementing: new Set(["reviewing", "blocked-on-child", "done"]),
  // Reviewer routes to proposed-ready (not done); only humans reach done.
  reviewing: new Set(["implementing", "proposed-ready"]),
  "proposed-ready": new Set(["done", "implementing"]),
  "blocked-on-child": new Set(["defining", "implementing"]),
  done: new Set(),
};

export function canTransition(from: IntentPhase, to: IntentPhase): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Move an intent to a new phase. Throws if the transition is illegal.
 * Also bumps updatedAt. Does NOT save — caller is responsible.
 */
export function transitionPhase(
  store: IntentStore,
  id: string,
  to: IntentPhase,
): Intent {
  const intent = store.intents.find((i) => i.id === id);
  if (!intent) throw new Error(`Intent not found: ${id}`);
  if (!canTransition(intent.phase, to)) {
    throw new Error(
      `Illegal phase transition for intent ${id}: ${intent.phase} → ${to}`,
    );
  }
  intent.phase = to;
  intent.updatedAt = Date.now();
  return intent;
}

// ── Tree traversal ──────────────────────────────────────────────────────────
//
// The store is a flat list; the tree shape is logical, built by walking
// parentId references. These helpers keep that walk in one place.

/**
 * Direct children of an intent (one level down).
 */
export function getChildren(store: IntentStore, id: string): Intent[] {
  return store.intents.filter((i) => i.parentId === id);
}

/**
 * Parent of an intent, or undefined if top-level or unknown id.
 */
export function getParent(store: IntentStore, id: string): Intent | undefined {
  const intent = store.intents.find((i) => i.id === id);
  if (!intent || intent.parentId === null) return undefined;
  return store.intents.find((i) => i.id === intent.parentId);
}

/**
 * Top-level ancestor of an intent. Returns the intent itself if it's already
 * top-level. Returns undefined for an unknown id.
 */
export function getRoot(store: IntentStore, id: string): Intent | undefined {
  let cursor = store.intents.find((i) => i.id === id);
  if (!cursor) return undefined;
  while (cursor.parentId !== null) {
    const parent = store.intents.find((i) => i.id === cursor!.parentId);
    if (!parent) return cursor; // orphaned parent ref; stop walking
    cursor = parent;
  }
  return cursor;
}

/**
 * Path from the root to the active intent, inclusive.
 * Empty array if there is no active intent.
 * Reads the active intent id from per-worktree storage via active-local.ts.
 */
export function getActivePath(store: IntentStore, cwd: string): Intent[] {
  const activeId = readActiveIntent(cwd);
  if (!activeId) return [];
  const path: Intent[] = [];
  let cursor = store.intents.find((i) => i.id === activeId);
  while (cursor) {
    path.unshift(cursor);
    if (cursor.parentId === null) break;
    cursor = store.intents.find((i) => i.id === cursor!.parentId);
  }
  return path;
}
