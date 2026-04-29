# Intent Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each intent gets its own git worktree. Defining stays in main repo; on `defining → implementing` (with explicit user confirm) a worktree is auto-created. Intent metadata (intents.json + intent.md contract) lives only on main; per-intent audit-trail files (log/understanding/verification/review) live in the feature worktree and merge to main on `done`.

**Architecture:**
- New module `worktree-manager.ts` owns worktree lifecycle (create/remove/dirty-check, slug, branch naming, base = main).
- New module `paths.ts` resolves "main repo `.pi/`" from any worktree cwd via `git worktree list --porcelain` (main = first/leftmost worktree on the `main` branch).
- `store.ts` is split: shared store (intents.json + contract on main repo) and per-worktree active-intent state (in `.git/pi-active-intent`).
- File lock on `intents.json` via `proper-lockfile` (auto-stale-reclaim + `/intent unlock` command).
- Phase transition `defining → implementing` gated by `ask` extension confirm; on confirm, worktree is created, then fresh session starts in the worktree.
- `done` flow: dirty-check → squash-merge into main → prompt "delete worktree?" → cd-out + remove (or keep).
- `intents.json` + `intents/*/intent.md` gitignored on non-main branches.

**Tech Stack:** TypeScript, `proper-lockfile`, Node `child_process` (git), existing `ask` extension overlay, existing `pi-coding-agent` ExtensionAPI.

---

## File Structure

**New files:**
- `extensions/intent/paths.ts` — main repo `.pi/` resolution from any cwd (worktree-aware).
- `extensions/intent/paths.test.ts` — unit tests for path resolution.
- `extensions/intent/lock.ts` — wrapper around `proper-lockfile` for `intents.json`.
- `extensions/intent/lock.test.ts` — unit tests for lock acquire/release/stale.
- `extensions/intent/worktree-manager.ts` — git worktree CRUD: `slug()`, `branchName()`, `worktreePath()`, `createWorktree()`, `removeWorktree()`, `isDirty()`, `mergeWorktree()`.
- `extensions/intent/worktree-manager.test.ts` — unit tests over a temp git repo fixture.
- `extensions/intent/active-local.ts` — per-worktree active-intent storage (`.git/pi-active-intent`).
- `extensions/intent/active-local.test.ts` — unit tests.
- `extensions/intent/done-flow.ts` — orchestrates `done` transition (dirty check, merge, delete prompt).
- `extensions/intent/done-flow.test.ts` — unit tests.

**Modified files:**
- `extensions/intent/store.ts` — `loadStore`/`saveStore` route through `paths.ts` + `lock.ts`; `activeIntentId` removed from `IntentStore` (now per-worktree).
- `extensions/intent/store.test.ts` — update for new path resolution + active-intent split.
- `extensions/intent/index.ts` — wire new modules; intercept `defining → implementing` for confirm; intercept `done` for done-flow; wire `/intent unlock`.
- `extensions/intent/overlay.ts` — pass through dirty/worktree info to delete confirm; add `unlock` action.
- `extensions/intent/panel.ts` — show worktree path/branch on active intent (display only).
- `package.json` — add `proper-lockfile` dependency + `@types/proper-lockfile` dev dep.
- `.gitignore` (root) — add `.pi/intents.json` and `.pi/intents/*/intent.md` gating notes (see Task 11).

---

## Conventions

- Test file naming: `<module>.test.ts` next to the module. Run individual tests: `node --experimental-strip-types --test extensions/intent/<file>.test.ts`. Run full suite: `npm test`. Typecheck: `npm run typecheck`.
- All new code uses Node 22+ APIs already in use in the codebase (`fs`, `child_process.execFileSync`, `crypto.randomUUID`).
- Error handling: throw `Error` with descriptive message; callers catch and surface via `ctx.ui.notify`.
- No `console.log` left in production code. Tests can use `console.log` only on assertion failure.
- Commit message style: conventional commits (`feat(intent):`, `fix(intent):`, `test(intent):`, `refactor(intent):`).

---

## Task 1: Add `proper-lockfile` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dependency**

Run:
```bash
npm install proper-lockfile
npm install --save-dev @types/proper-lockfile
```

Expected: `package.json` gains `"proper-lockfile": "^4.x.x"` under `dependencies` and `"@types/proper-lockfile"` under `devDependencies`. `package-lock.json` updates.

- [ ] **Step 2: Verify install**

Run: `node -e "console.log(require('proper-lockfile').lock.length)"`
Expected: prints a number (function arity), no error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(intent): add proper-lockfile dependency"
```

---

## Task 2: Path resolution module — main repo `.pi/` from any worktree

**Files:**
- Create: `extensions/intent/paths.ts`
- Create: `extensions/intent/paths.test.ts`

**Background:** Given a `cwd` that may be inside a worktree, find the main repo's working tree (the worktree with the `main` branch checked out) and resolve `.pi/` paths there. Falls back to `cwd` if not in a git repo (testing convenience).

- [ ] **Step 1: Write failing test**

Create `extensions/intent/paths.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mainRepoRoot, mainPiDir, mainIntentsJsonPath } from "./paths.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-paths-"));
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

test("mainPiDir / mainIntentsJsonPath compose correctly", () => {
  const { dir, cleanup } = initRepo();
  try {
    assert.equal(mainPiDir(dir), join(dir, ".pi"));
    assert.equal(mainIntentsJsonPath(dir), join(dir, ".pi", "intents.json"));
  } finally {
    cleanup();
  }
});

test("mainRepoRoot falls back to cwd outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-paths-nogit-"));
  try {
    assert.equal(mainRepoRoot(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/paths.test.ts`
Expected: FAIL — module `./paths.ts` does not exist.

- [ ] **Step 3: Implement `paths.ts`**

Create `extensions/intent/paths.ts`:

```typescript
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
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/paths.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/paths.ts extensions/intent/paths.test.ts
git commit -m "feat(intent): add main repo path resolver for worktrees"
```

---

## Task 3: File lock wrapper for `intents.json`

**Files:**
- Create: `extensions/intent/lock.ts`
- Create: `extensions/intent/lock.test.ts`

- [ ] **Step 1: Write failing test**

Create `extensions/intent/lock.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExclusiveLock, forceUnlock, isLocked } from "./lock.ts";

function fixture(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-lock-"));
  const file = join(dir, "intents.json");
  writeFileSync(file, "{}");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("withExclusiveLock runs callback and releases", async () => {
  const { file, cleanup } = fixture();
  try {
    let ran = false;
    await withExclusiveLock(file, async () => {
      ran = true;
      assert.equal(isLocked(file), true);
    });
    assert.equal(ran, true);
    assert.equal(isLocked(file), false);
  } finally {
    cleanup();
  }
});

test("withExclusiveLock serializes concurrent callers", async () => {
  const { file, cleanup } = fixture();
  try {
    const order: string[] = [];
    await Promise.all([
      withExclusiveLock(file, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
      }),
      withExclusiveLock(file, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  } finally {
    cleanup();
  }
});

test("forceUnlock removes a stale lock", async () => {
  const { file, cleanup } = fixture();
  try {
    // Simulate stale lock by creating one and not releasing.
    const lockfile = await import("proper-lockfile");
    const release = await lockfile.lock(file, { stale: 60_000 });
    // Pretend the process died; we don't call release().
    assert.equal(isLocked(file), true);
    forceUnlock(file);
    assert.equal(isLocked(file), false);
    // Restore for cleanup-safety
    try { await release(); } catch { /* already removed */ }
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/lock.test.ts`
Expected: FAIL — module `./lock.ts` does not exist.

- [ ] **Step 3: Implement `lock.ts`**

Create `extensions/intent/lock.ts`:

```typescript
/**
 * Advisory file lock around `intents.json`. proper-lockfile handles
 * stale-lock reclaim natively via its `stale` option (default-rejects
 * locks older than the threshold, allowing acquisition).
 *
 * `forceUnlock` is the manual-override escape hatch surfaced as
 * `/intent unlock` for cases where auto-reclaim doesn't kick in.
 */
import lockfile from "proper-lockfile";
import { existsSync } from "node:fs";

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
  // proper-lockfile's lock is a directory; remove it.
  const { rmSync } = require("node:fs");
  rmSync(filePath + ".lock", { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/lock.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/lock.ts extensions/intent/lock.test.ts
git commit -m "feat(intent): add file lock wrapper for intents.json"
```

---

## Task 4: Per-worktree active-intent storage

**Files:**
- Create: `extensions/intent/active-local.ts`
- Create: `extensions/intent/active-local.test.ts`

**Background:** Each worktree needs its own `activeIntentId`. Stored in `<git-dir>/pi-active-intent` where `<git-dir>` is the per-worktree git dir (returned by `git rev-parse --git-dir`).

- [ ] **Step 1: Write failing test**

Create `extensions/intent/active-local.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readActiveIntent, writeActiveIntent } from "./active-local.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-active-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readActiveIntent returns null when unset", () => {
  const { dir, cleanup } = initRepo();
  try {
    assert.equal(readActiveIntent(dir), null);
  } finally {
    cleanup();
  }
});

test("writeActiveIntent + readActiveIntent round-trip", () => {
  const { dir, cleanup } = initRepo();
  try {
    writeActiveIntent(dir, "abc-123");
    assert.equal(readActiveIntent(dir), "abc-123");
    writeActiveIntent(dir, null);
    assert.equal(readActiveIntent(dir), null);
  } finally {
    cleanup();
  }
});

test("active intent is per-worktree (not shared)", () => {
  const { dir, cleanup } = initRepo();
  try {
    const wtPath = join(dir, "..", "active-wt-feat");
    execFileSync("git", ["worktree", "add", "-b", "feat", wtPath], { cwd: dir });
    try {
      writeActiveIntent(dir, "main-id");
      writeActiveIntent(wtPath, "feat-id");
      assert.equal(readActiveIntent(dir), "main-id");
      assert.equal(readActiveIntent(wtPath), "feat-id");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir });
    }
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/active-local.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `extensions/intent/active-local.ts`:

```typescript
/**
 * Per-worktree active intent. Stored in `<git-dir>/pi-active-intent`,
 * where `<git-dir>` is what `git rev-parse --git-dir` returns for the
 * given cwd. In a linked worktree this is `.git/worktrees/<name>/`,
 * which is unique per worktree (so each worktree has its own active
 * intent independently).
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
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/active-local.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/active-local.ts extensions/intent/active-local.test.ts
git commit -m "feat(intent): per-worktree active intent storage"
```

---

## Task 5: Refactor `store.ts` to use main-repo paths and locking, drop activeIntentId from store

**Files:**
- Modify: `extensions/intent/store.ts`
- Modify: `extensions/intent/store.test.ts`

**Background:** `IntentStore` currently has `activeIntentId`. Move that to per-worktree storage (Task 4). All path helpers should resolve to main repo's `.pi/`. All writes to `intents.json` go through `withExclusiveLock`.

- [ ] **Step 1: Inspect current `store.test.ts`**

Run: `wc -l extensions/intent/store.test.ts && head -60 extensions/intent/store.test.ts`
Note: count + first 60 lines for context. Test file modifications must preserve existing intent-tree/transition coverage.

- [ ] **Step 2: Update test for path-routing through main repo**

Add to `extensions/intent/store.test.ts` (place near existing tests; do not delete others):

```typescript
test("loadStore reads main repo .pi/ from a feature worktree", () => {
  // Setup: create main repo, write intents.json on main, add a feature worktree.
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-store-wt-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "intents.json"),
      JSON.stringify({ intents: [{ id: "x", title: "T", createdAt: 1, updatedAt: 1, parentId: null, phase: "defining", reworkCount: 0 }] }),
    );

    const wtPath = join(dir, "..", "store-wt-feat");
    execFileSync("git", ["worktree", "add", "-b", "feat", wtPath], { cwd: dir });
    try {
      const store = loadStore(wtPath); // should read main's intents.json
      assert.equal(store.intents.length, 1);
      assert.equal(store.intents[0].id, "x");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Then update existing tests that reference `store.activeIntentId` to instead call `readActiveIntent(cwd)` / `writeActiveIntent(cwd, id)`. Search the test file for `activeIntentId` and change each usage. **Show one example replacement to anchor the pattern:**

Before:
```typescript
const store = createIntent(loadStore(cwd), cwd, "x");
assert.equal(store.activeIntentId, store.intents[0].id);
```

After:
```typescript
const store = loadStore(cwd);
const intent = createIntent(store, cwd, "x");
saveStore(cwd, store);
writeActiveIntent(cwd, intent.id);
assert.equal(readActiveIntent(cwd), intent.id);
```

Apply this pattern to every existing test that asserts on `activeIntentId`.

- [ ] **Step 3: Run test — confirm failures**

Run: `node --experimental-strip-types --test extensions/intent/store.test.ts`
Expected: FAIL — `activeIntentId` removed; loadStore not yet routing via paths.

- [ ] **Step 4: Update `store.ts` — remove activeIntentId, route paths through `paths.ts`, lock writes**

In `extensions/intent/store.ts`:

(a) Remove `activeIntentId` from `IntentStore`:

```typescript
export interface IntentStore {
  intents: Intent[];
}
```

(b) Replace `piDir` / `storePath` / `intentDir` / `intentContractPath` to resolve via `paths.ts`:

```typescript
import {
  mainPiDir,
  mainIntentsJsonPath,
  mainIntentDir,
  mainIntentContractPath,
} from "./paths.js";

function piDir(cwd: string): string { return mainPiDir(cwd); }
function storePath(cwd: string): string { return mainIntentsJsonPath(cwd); }
export function intentDir(cwd: string, id: string): string { return mainIntentDir(cwd, id); }
export function intentContractPath(cwd: string, id: string): string { return mainIntentContractPath(cwd, id); }
```

(Other path helpers — `intentLogPath`, `intentUnderstandingPath`, `intentVerificationPath`, `reviewResultPath` — STAY pointed at the worktree's `<cwd>/.pi/intents/<id>/` since those are the audit-trail files that live in the feature worktree. **Do not** route them through `mainPiDir`. They use the existing local `<cwd>/.pi/...` resolution; preserve that — i.e., keep their original implementations that compute paths via `join(cwd, ".pi", ...)` directly, do not delegate to the main-repo helpers.)

Concretely, keep:
```typescript
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
```

(c) `loadStore` — drop `activeIntentId`:

```typescript
export function loadStore(cwd: string): IntentStore {
  try {
    const raw = readFileSync(storePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as { intents?: Array<Partial<Intent> & { id: string; title: string; createdAt: number }> };
    const store: IntentStore = { intents: (parsed.intents ?? []).map(migrateIntent) };
    migrateLegacyFileLayout(cwd, store);
    return store;
  } catch {
    return { intents: [] };
  }
}
```

(d) `saveStore` — wrap with lock; make async:

```typescript
import { withExclusiveLock } from "./lock.js";

export async function saveStore(cwd: string, store: IntentStore): Promise<void> {
  mkdirSync(piDir(cwd), { recursive: true });
  const file = storePath(cwd);
  // Ensure file exists for proper-lockfile to lock against.
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ intents: [] }, null, 2));
  await withExclusiveLock(file, async () => {
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmp, file);
  });
}
```

(e) `createIntent` no longer sets `activeIntentId`:

```typescript
export function createIntent(
  store: IntentStore,
  cwd: string,
  description: string,
  options?: { parentId?: string | null },
): Intent {
  const id = crypto.randomUUID();
  const now = Date.now();
  const intent: Intent = {
    id, title: deriveTitle(description), createdAt: now, updatedAt: now,
    parentId: options?.parentId ?? null, phase: "defining", reworkCount: 0,
  };
  store.intents.push(intent);
  saveIntentContent(cwd, id, intentTemplate(description));
  return intent;
}
```

(f) `deleteIntent` — remove the `activeIntentId` fallback logic at the bottom (active is now per-worktree, handled by callers).

(g) Remove `getActiveIntent(store)` from this file. Callers must now call `readActiveIntent(cwd)` from `active-local.ts` and look up the intent themselves. Add a helper:

```typescript
import { readActiveIntent } from "./active-local.js";
export function getActiveIntent(store: IntentStore, cwd: string): Intent | undefined {
  const id = readActiveIntent(cwd);
  if (!id) return undefined;
  return store.intents.find((i) => i.id === id);
}
```

(h) `getActivePath` — same change: take cwd, look up active via `readActiveIntent`:

```typescript
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
```

- [ ] **Step 5: Run tests — confirm pass**

Run: `npm test`
Expected: All tests in `store.test.ts` PASS. **Other tests that import store will fail** — that's Task 6+.

- [ ] **Step 6: Commit**

```bash
git add extensions/intent/store.ts extensions/intent/store.test.ts
git commit -m "refactor(intent): route store through main repo + per-worktree active"
```

---

## Task 6: Update `index.ts` and other callers for new store API

**Files:**
- Modify: `extensions/intent/index.ts`
- Modify: `extensions/intent/overlay.ts`
- Modify: `extensions/intent/panel.ts`
- Modify: `extensions/orchestrator/*.ts` (any file calling `getActiveIntent(store)`)

- [ ] **Step 1: Find all call sites**

Run:
```bash
grep -rn "getActiveIntent\|activeIntentId" extensions/ --include="*.ts"
```
Expected: list of every call site. Reference this list while updating.

- [ ] **Step 2: Update `index.ts`**

For every `getActiveIntent(store)` call, change to `getActiveIntent(store, cwdRef)`.
For every read of `store.activeIntentId`, replace with `readActiveIntent(cwdRef)`.
For every write to `store.activeIntentId = X`, replace with `writeActiveIntent(cwdRef, X)`.
Add import:
```typescript
import { readActiveIntent, writeActiveIntent } from "./active-local.js";
```

`saveStore` is now async — every call must be `await`ed. Audit `persist()` and any caller. Update `persist`:

```typescript
async function persist(cwd: string): Promise<void> {
  await saveStore(cwd, store);
  refreshPanel();
}
```

Then `await persist(...)` everywhere.

- [ ] **Step 3: Update `overlay.ts` and `panel.ts`**

Same pattern: `getActiveIntent(store)` → `getActiveIntent(store, cwd)`. `store.activeIntentId` references replaced with `readActiveIntent(cwd)`. Pass `cwd` into helpers as needed (the overlay already takes `cwd` as the 4th constructor arg per current code).

- [ ] **Step 4: Update orchestrator**

Run: `grep -rn "getActiveIntent\|activeIntentId" extensions/orchestrator/`
For each match, apply the same translation as Step 2 (need cwd in scope; the orchestrator already tracks `this.cwd`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: No errors. Fix any remaining references.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests PASS. (Tests that previously asserted on `store.activeIntentId` should already have been updated in Task 5; if any still fail, fix them now using the same pattern.)

- [ ] **Step 7: Commit**

```bash
git add extensions/
git commit -m "refactor(intent): update callers for per-worktree active + async saveStore"
```

---

## Task 7: Worktree manager module

**Files:**
- Create: `extensions/intent/worktree-manager.ts`
- Create: `extensions/intent/worktree-manager.test.ts`

**Background:** Encapsulates all git worktree operations. Slug from title (lowercased, alphanumeric + hyphens, capped at 60 chars). Branch = `intent/<slug>-<short-id>`. Default worktree path = `~/.pi/repos/<repo-name>/<slug>-<short-id>/`. Configurable via env `PI_WORKTREE_BASE` (which replaces `~/.pi/repos`).

- [ ] **Step 1: Write failing test**

Create `extensions/intent/worktree-manager.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import {
  slugify,
  branchName,
  worktreePath,
  createWorktree,
  removeWorktree,
  isDirty,
  shortId,
} from "./worktree-manager.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("slugify lowercases, replaces non-alphanum with hyphens, caps length", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugify("UPPER lower 123"), "upper-lower-123");
  const long = "a".repeat(100);
  assert.equal(slugify(long).length, 60);
});

test("shortId returns first 8 chars", () => {
  assert.equal(shortId("e609fe06-6dd3-4029"), "e609fe06");
});

test("branchName is intent/<slug>-<short-id>", () => {
  assert.equal(branchName("Foo Bar", "abcdef01-2345"), "intent/foo-bar-abcdef01");
});

test("worktreePath uses PI_WORKTREE_BASE override", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-wtbase-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const p = worktreePath("/path/to/myrepo", "Foo", "abcdef01");
    assert.equal(p, join(base, "myrepo", "foo-abcdef01"));
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
  }
});

test("createWorktree creates branch + worktree dir off main", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-wtbase2-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Test Intent", "abcdef01");
    assert.equal(branch, "intent/test-intent-abcdef01");
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(path, "README")), true);
    const out = execFileSync("git", ["branch", "--list", branch], { cwd: dir, encoding: "utf-8" });
    assert.match(out, /test-intent-abcdef01/);
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("isDirty detects uncommitted changes", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-wtbase3-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path } = createWorktree(dir, "Dirty Test", "abcdef02");
    assert.equal(isDirty(path), false);
    writeFileSync(join(path, "newfile"), "x");
    assert.equal(isDirty(path), true);
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("removeWorktree force-removes dir + branch", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-wtbase4-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Rm Test", "abcdef03");
    assert.equal(existsSync(path), true);
    removeWorktree(dir, path, branch);
    assert.equal(existsSync(path), false);
    const out = execFileSync("git", ["branch", "--list", branch], { cwd: dir, encoding: "utf-8" });
    assert.equal(out.trim(), "");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/worktree-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `extensions/intent/worktree-manager.ts`:

```typescript
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
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mainRepoRoot } from "./paths.js";

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
    // worktree may already be gone; remove dir if it exists
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  }
  // Delete the branch (force, since it may not be merged)
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: main,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // branch may not exist
  }
}
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/worktree-manager.test.ts`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/worktree-manager.ts extensions/intent/worktree-manager.test.ts
git commit -m "feat(intent): worktree manager (create/remove/dirty/slug)"
```

---

## Task 8: Persist branch + worktree path on intent metadata

**Files:**
- Modify: `extensions/intent/store.ts`
- Modify: `extensions/intent/store.test.ts`

**Background:** When a worktree is created, we need to remember the branch name and absolute path on the intent so we can find them later (for done flow / delete flow). Add optional fields and a migration.

- [ ] **Step 1: Write failing test**

Add to `extensions/intent/store.test.ts`:

```typescript
test("Intent supports optional worktree fields", () => {
  const store: IntentStore = { intents: [] };
  const intent = createIntent(store, process.cwd(), "x");
  intent.worktreeBranch = "intent/x-abc";
  intent.worktreePath = "/tmp/x";
  // Round-trip via JSON
  const json = JSON.stringify(store);
  const parsed = JSON.parse(json) as IntentStore;
  assert.equal(parsed.intents[0].worktreeBranch, "intent/x-abc");
  assert.equal(parsed.intents[0].worktreePath, "/tmp/x");
});

test("migrateIntent fills missing worktree fields with undefined", () => {
  // Already-stored intent without worktree fields should still load.
  const raw = { id: "x", title: "T", createdAt: 1 };
  // Simulate by writing directly and loading.
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "pi-mig-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "intents.json"), JSON.stringify({ intents: [raw] }));
    const store = loadStore(dir);
    assert.equal(store.intents[0].worktreeBranch, undefined);
    assert.equal(store.intents[0].worktreePath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/store.test.ts`
Expected: FAIL — `Intent` type does not include `worktreeBranch` / `worktreePath`.

- [ ] **Step 3: Add fields to `Intent`**

In `extensions/intent/store.ts`, update `Intent`:

```typescript
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
```

Update `migrateIntent` to pass through these fields when present:

```typescript
function migrateIntent(raw: Partial<Intent> & { id: string; title: string; createdAt: number }): Intent {
  return {
    id: raw.id, title: raw.title, createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    parentId: raw.parentId ?? null,
    phase: raw.phase ?? "defining",
    reworkCount: raw.reworkCount ?? 0,
    worktreeBranch: raw.worktreeBranch,
    worktreePath: raw.worktreePath,
  };
}
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/store.ts extensions/intent/store.test.ts
git commit -m "feat(intent): persist worktree branch + path on intent"
```

---

## Task 9: Phase transition gate — ask "Ready to start implementation?" + create worktree on confirm

**Files:**
- Modify: `extensions/intent/index.ts` (specifically `handleLock` and `handleTransition`)

**Background:** Today, `defining → implementing` immediately starts the implementer loop in a fresh session. New behavior: prompt user via `ask` extension; on confirm, create worktree, persist branch+path on intent, transition phase, then start fresh session **inside the new worktree**.

- [ ] **Step 1: Read current `handleLock` and `handleTransition`**

Run: `sed -n '1114,1192p' extensions/intent/index.ts`
Note: lines 1114-1192 (per current state) hold the two handlers.

- [ ] **Step 2: Inspect `ask` extension's exposed API**

Run:
```bash
grep -n "registerCommand\|registerTool\|sendMessage\|export" extensions/ask/index.ts | head -30
```
Note: identify how to invoke a yes/no prompt synchronously from another extension. If the ask extension exposes an event-bus API, use it; otherwise use `ctx.ui.confirm` (already used by `handleDelete`).

**Decision rule:** If `ctx.ui.confirm` is available (it is — see existing `handleDelete`), use it. Reserve the `ask` overlay for richer flows (multi-line questions). Document this in code comment.

- [ ] **Step 3: Write a unit test for the gate logic**

Add a new file `extensions/intent/transition-gate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
// We test the pure gate function in isolation.
import { decideTransitionToImplementing } from "./transition-gate.ts";

test("returns 'cancel' when user declines", async () => {
  const result = await decideTransitionToImplementing({ confirm: async () => false });
  assert.equal(result, "cancel");
});

test("returns 'proceed' when user confirms", async () => {
  const result = await decideTransitionToImplementing({ confirm: async () => true });
  assert.equal(result, "proceed");
});
```

Create `extensions/intent/transition-gate.ts`:

```typescript
/**
 * Pure decision: should we proceed with `defining → implementing`?
 * Wrapping the prompt in a small function keeps it unit-testable.
 */
export interface ConfirmGate {
  confirm: () => Promise<boolean>;
}

export async function decideTransitionToImplementing(
  gate: ConfirmGate,
): Promise<"proceed" | "cancel"> {
  const ok = await gate.confirm();
  return ok ? "proceed" : "cancel";
}
```

Run: `node --experimental-strip-types --test extensions/intent/transition-gate.test.ts`
Expected: 2 PASS.

- [ ] **Step 4: Modify `handleLock` in `index.ts`**

Replace the body of `handleLock` (after the `validateIntentForLock` check) with:

```typescript
async function handleLock(
  ctx: ExtensionCommandContext | ExtensionContext,
  intentId?: string,
): Promise<void> {
  const intent = intentId ? store.intents.find((i) => i.id === intentId) : getActiveIntent(store, cwdRef);
  if (!intent || intent.phase !== "defining") return;

  const content = loadIntentContent(ctx.cwd, intent.id);
  const result = validateIntentForLock(content);
  if (!result.valid) {
    ctx.ui.notify(`Cannot lock — missing: ${result.missing.join(", ")}`, "warning");
    return;
  }

  // Gate: confirm with the user before starting implementation.
  const proceed = await ctx.ui.confirm(
    "Ready to start implementation?",
    `This will create a worktree at ${worktreePath(mainRepoRoot(ctx.cwd), intent.title, intent.id)} ` +
    `on branch ${branchName(intent.title, intent.id)} and start the implementer.`,
  );
  if (!proceed) {
    ctx.ui.notify("Implementation not started.", "info");
    return;
  }

  // Create worktree.
  let created;
  try {
    created = createWorktree(ctx.cwd, intent.title, intent.id);
  } catch (err) {
    ctx.ui.notify(`Worktree creation failed: ${(err as Error).message}`, "warning");
    return;
  }
  intent.worktreeBranch = created.branch;
  intent.worktreePath = created.path;

  const from: IntentPhase = intent.phase;
  const isActiveIntent = readActiveIntent(cwdRef) === intent.id;

  transitionPhase(store, intent.id, "implementing");
  await persist(ctx.cwd);
  pi.events.emit("intent:phase-changed", {
    id: intent.id, from, to: "implementing",
  });
  ctx.ui.notify(`Worktree created: ${created.path}`, "info");

  // Start fresh session in the worktree (the implementer agent will take over).
  if (isActiveIntent && "newSession" in ctx) {
    await ctx.newSession({ cwd: created.path });
  }
}
```

Add imports at top of `index.ts`:

```typescript
import {
  createWorktree,
  worktreePath,
  branchName,
} from "./worktree-manager.js";
import { mainRepoRoot } from "./paths.js";
```

**Note:** `ctx.newSession({ cwd })` — verify the `newSession` API in `@mariozechner/pi-coding-agent` supports a cwd override. If it does not, the fallback is to `process.chdir(created.path)` before calling `ctx.newSession()`. Add a comment noting this; the engineer should consult `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts` for the exact signature.

Run:
```bash
grep -n "newSession" node_modules/@mariozechner/pi-coding-agent/dist/*.d.ts 2>/dev/null | head
```
If it accepts a `{ cwd }` option, use it. If not, use `process.chdir(created.path)` immediately before `await ctx.newSession()`.

- [ ] **Step 5: Same gate for `handleTransition` when `toPhase === "implementing"`**

In `handleTransition`, before the `transitionPhase` call, when `toPhase === "implementing"` and there is no existing `intent.worktreePath`, run the same confirm + create flow as in `handleLock` (extract a shared helper to avoid duplication):

```typescript
async function gateAndCreateWorktree(
  ctx: ExtensionCommandContext | ExtensionContext,
  intent: Intent,
): Promise<{ ok: true; path: string; branch: string } | { ok: false }> {
  const proceed = await ctx.ui.confirm(
    "Ready to start implementation?",
    `Creates worktree on branch ${branchName(intent.title, intent.id)}.`,
  );
  if (!proceed) return { ok: false };
  try {
    const created = createWorktree(ctx.cwd, intent.title, intent.id);
    intent.worktreeBranch = created.branch;
    intent.worktreePath = created.path;
    return { ok: true, path: created.path, branch: created.branch };
  } catch (err) {
    ctx.ui.notify(`Worktree creation failed: ${(err as Error).message}`, "warning");
    return { ok: false };
  }
}
```

Use it in both `handleLock` and `handleTransition`. **Skip the gate** if `intent.worktreePath` already exists (re-entry after crash, rework after review, etc.) — the worktree is already there.

- [ ] **Step 6: Typecheck + run full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run: build + start (`npm run start` if defined, else launch pi as configured).
1. Create new intent.
2. Fill in success criteria + verification.
3. Lock → expect confirm dialog "Ready to start implementation?".
4. Decline → no worktree, phase stays defining.
5. Lock again → confirm → expect worktree at `~/.pi/repos/pi-codeslinger/<slug>-<short-id>/`, fresh session in that dir, phase = implementing.

Document outcome in commit body.

- [ ] **Step 8: Commit**

```bash
git add extensions/intent/index.ts extensions/intent/transition-gate.ts extensions/intent/transition-gate.test.ts
git commit -m "feat(intent): gate defining->implementing on user confirm + auto-create worktree"
```

---

## Task 10: `done` flow — dirty check, squash merge, prompt to delete worktree

**Files:**
- Create: `extensions/intent/done-flow.ts`
- Create: `extensions/intent/done-flow.test.ts`
- Modify: `extensions/intent/index.ts` (intercept `done` transition)

**Background:** When transitioning to `done`:
1. If intent has a worktree, refuse if dirty (uncommitted changes).
2. Squash-merge the worktree's branch into `main` from main repo.
3. On merge conflict: abort, leave worktree intact, surface error, do not transition.
4. After successful merge: prompt "Delete worktree? [y/N]" (default keep).
5. If user confirms delete: cd current shell (best-effort) out of worktree if inside, then `removeWorktree`.

- [ ] **Step 1: Write failing test**

Create `extensions/intent/done-flow.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { squashMergeWorktree, mergeStatus } from "./done-flow.ts";
import { createWorktree } from "./worktree-manager.ts";

function initRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-done-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "main\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("squashMergeWorktree merges clean branch into main", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-done-base-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Feat", "abcdef01");
    writeFileSync(join(path, "feat.txt"), "feat\n");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["commit", "-m", "add feat"], { cwd: path });

    const status = squashMergeWorktree(dir, branch, "feat: merge");
    assert.equal(status.kind, "merged");
    assert.equal(existsSync(join(dir, "feat.txt")), true);
    assert.equal(readFileSync(join(dir, "feat.txt"), "utf-8"), "feat\n");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});

test("squashMergeWorktree returns conflict status on conflicting changes", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-done-base2-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path, branch } = createWorktree(dir, "Conf", "abcdef02");
    writeFileSync(join(path, "README"), "wt-side\n");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["commit", "-m", "wt change"], { cwd: path });
    // Conflicting change on main
    writeFileSync(join(dir, "README"), "main-side\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "main change"], { cwd: dir });

    const status = squashMergeWorktree(dir, branch, "feat: merge");
    assert.equal(status.kind, "conflict");
    // Main should be in clean state (we aborted)
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
    assert.equal(out.trim(), "");
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});
```

- [ ] **Step 2: Run test — confirm failure**

Run: `node --experimental-strip-types --test extensions/intent/done-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `done-flow.ts`**

Create `extensions/intent/done-flow.ts`:

```typescript
/**
 * Done-flow operations: squash-merge a worktree branch into main and
 * recover cleanly on conflict.
 *
 * Done flow at the orchestration level (called from index.ts):
 *   1. Reject if the worktree is dirty (uncommitted changes).
 *   2. squashMergeWorktree(...) — abort on conflict.
 *   3. On success: prompt user; optionally removeWorktree(...).
 */
import { execFileSync, execFile } from "node:child_process";
import { mainRepoRoot } from "./paths.js";

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
  // Ensure main is checked out and clean.
  try {
    execFileSync("git", ["checkout", "main"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { kind: "error", branch, message: `Could not checkout main: ${(err as Error).message}` };
  }
  // Squash merge.
  try {
    execFileSync("git", ["merge", "--squash", branch], { cwd: main, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // Abort + reset to clean state.
    try { execFileSync("git", ["merge", "--abort"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] }); } catch {}
    try { execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: main, stdio: ["ignore", "pipe", "pipe"] }); } catch {}
    return { kind: "conflict", branch, message: (err as Error).message };
  }
  // Commit the squashed result.
  try {
    execFileSync("git", ["commit", "-m", commitMessage], { cwd: main, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // Nothing to commit (rare — branch was empty). Treat as merged.
    return { kind: "merged", branch };
  }
  return { kind: "merged", branch };
}

export function mergeStatus(s: MergeStatus): string {
  if (s.kind === "merged") return `Merged ${s.branch} into main.`;
  if (s.kind === "conflict") return `Merge conflict on ${s.branch}: ${s.message}`;
  return `Merge error on ${s.branch}: ${s.message}`;
}
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/done-flow.test.ts`
Expected: 2 PASS.

- [ ] **Step 5: Wire into `index.ts`**

In `index.ts`, intercept transitions to `done`. Find `handleTransition` and add a branch for `toPhase === "done"`:

```typescript
import { squashMergeWorktree, mergeStatus } from "./done-flow.js";
import { isDirty, removeWorktree } from "./worktree-manager.js";

async function handleDoneTransition(
  ctx: ExtensionCommandContext | ExtensionContext,
  intent: Intent,
): Promise<"done" | "blocked"> {
  if (intent.worktreePath && intent.worktreeBranch) {
    if (isDirty(intent.worktreePath)) {
      ctx.ui.notify(
        `Cannot mark done: worktree has uncommitted changes at ${intent.worktreePath}. Commit or stash first.`,
        "warning",
      );
      return "blocked";
    }
    const result = squashMergeWorktree(
      ctx.cwd,
      intent.worktreeBranch,
      `feat(${intent.id.slice(0, 8)}): ${intent.title}`,
    );
    if (result.kind !== "merged") {
      ctx.ui.notify(mergeStatus(result), "warning");
      return "blocked";
    }
    ctx.ui.notify(mergeStatus(result), "info");

    const remove = await ctx.ui.confirm(
      "Delete worktree?",
      `Worktree at ${intent.worktreePath} (branch ${intent.worktreeBranch}) is no longer needed. Delete it?`,
    );
    if (remove) {
      // If current cwd is inside the worktree, attempt cd-out (best effort).
      if (ctx.cwd.startsWith(intent.worktreePath)) {
        ctx.ui.notify(
          `Note: current shell is inside worktree. cd to main repo manually after deletion.`,
          "info",
        );
      }
      removeWorktree(ctx.cwd, intent.worktreePath, intent.worktreeBranch);
      intent.worktreePath = undefined;
      intent.worktreeBranch = undefined;
      ctx.ui.notify("Worktree deleted.", "info");
    }
  }
  return "done";
}
```

In the existing `handleTransition`, before the unconditional `transitionPhase` call, add:

```typescript
if (toPhase === "done") {
  const outcome = await handleDoneTransition(ctx, intent);
  if (outcome === "blocked") return; // do not transition
}
```

- [ ] **Step 6: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Manual verification**

1. With an intent in `implementing`, commit some change in its worktree.
2. Trigger `done` from overlay. Expect: merge succeeds, prompt for delete.
3. Decline delete → worktree remains, intent moves to done, fields keep branch+path.
4. Make a new intent, trigger done with dirty worktree → expect block + warning.

- [ ] **Step 8: Commit**

```bash
git add extensions/intent/done-flow.ts extensions/intent/done-flow.test.ts extensions/intent/index.ts
git commit -m "feat(intent): squash-merge worktree on done + prompt to delete"
```

---

## Task 11: Migration — gitignore intents.json + intent.md on non-main; preserve audit-trail files

**Files:**
- Modify: `.gitignore` (root)
- Possibly modify: `extensions/intent/store.ts` (no functional change; the gitignore is the migration)

- [ ] **Step 1: Inspect current `.gitignore`**

Run: `cat .gitignore 2>/dev/null || echo "(no .gitignore)"`

- [ ] **Step 2: Add gating rules**

The challenge: `.pi/intents.json` and `.pi/intents/*/intent.md` should be tracked on `main` but **ignored on feature/worktree branches**. Git's `.gitignore` is per-tree, not per-branch — but if a file is already tracked, gitignore is irrelevant for that file. So:

(a) Keep `.pi/intents.json` and `.pi/intents/*/intent.md` tracked on `main`. Don't add them to `.gitignore`.
(b) On feature branches (worktrees), the bare gitignore won't help — but those branches simply won't have those files modified by the agent (they get written to main worktree's filesystem). So the worktree branch's tracked copy stays whatever was on main HEAD when the worktree was branched. As main's `.pi/intents.json` evolves on the user's main worktree, the feature worktree's tracked copy stays static — that's expected and fine: the feature worktree should never read its own `.pi/intents.json`; it always reads through `mainPiDir(cwd)`.

(c) **Add a worktree-only `.git/info/exclude` rule** in `createWorktree` so any accidental edits to those files inside the worktree don't show up in `git status`. After `git worktree add`:

In `worktree-manager.ts`, modify `createWorktree` to write to the new worktree's local exclude file:

```typescript
import { writeFileSync, mkdirSync as fsMkdir } from "node:fs";
// ... after execFileSync("git", ["worktree", "add", ...]) succeeds:

// Local exclude (per-worktree, not committed) — keep main-only files out of status.
const gitDirOut = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, encoding: "utf-8" }).trim();
const gitDirAbs = gitDirOut.startsWith("/") ? gitDirOut : join(path, gitDirOut);
const excludeDir = join(gitDirAbs, "info");
fsMkdir(excludeDir, { recursive: true });
writeFileSync(
  join(excludeDir, "exclude"),
  ["# Pi worktree: shared intent metadata lives on main only", ".pi/intents.json", ".pi/intents/*/intent.md", ""].join("\n"),
);
```

- [ ] **Step 3: Add a unit test**

Add to `extensions/intent/worktree-manager.test.ts`:

```typescript
test("createWorktree writes local excludes for shared intent metadata", () => {
  const { dir, cleanup } = initRepo();
  const base = mkdtempSync(join(tmpdir(), "pi-wtbase5-"));
  process.env.PI_WORKTREE_BASE = base;
  try {
    const { path } = createWorktree(dir, "Excl", "abcdef04");
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path, encoding: "utf-8" }).trim();
    const excludeFile = join(gitDir.startsWith("/") ? gitDir : join(path, gitDir), "info", "exclude");
    const contents = require("node:fs").readFileSync(excludeFile, "utf-8");
    assert.match(contents, /\.pi\/intents\.json/);
    assert.match(contents, /\.pi\/intents\/\*\/intent\.md/);
  } finally {
    delete process.env.PI_WORKTREE_BASE;
    rmSync(base, { recursive: true, force: true });
    cleanup();
  }
});
```

- [ ] **Step 4: Run test — confirm pass**

Run: `node --experimental-strip-types --test extensions/intent/worktree-manager.test.ts`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/intent/worktree-manager.ts extensions/intent/worktree-manager.test.ts
git commit -m "feat(intent): add per-worktree git excludes for shared intent metadata"
```

---

## Task 12: `/intent unlock` command for stale-lock manual override

**Files:**
- Modify: `extensions/intent/index.ts`

- [ ] **Step 1: Wire the command**

In `index.ts`, register a sub-command. Easiest route: extend the existing `pi.registerCommand("intent", ...)` handler to recognize an `unlock` argument:

```typescript
pi.registerCommand("intent", {
  description: "Manage intents. Subcommands: unlock (clear a stale lock).",
  handler: async (args, ctx) => {
    if (args.trim() === "unlock") {
      const { forceUnlock } = await import("./lock.js");
      const lockPath = mainIntentsJsonPath(ctx.cwd);
      forceUnlock(lockPath);
      ctx.ui.notify(`Cleared lock on ${lockPath}`, "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/intent requires interactive mode", "error");
      return;
    }
    await showIntentOverlay(ctx);
    refreshPanel();
  },
});
```

Add import:

```typescript
import { mainIntentsJsonPath } from "./paths.js";
```

- [ ] **Step 2: Manual verification**

1. Trigger a stale lock by running `node -e 'require("proper-lockfile").lock(".pi/intents.json", { stale: 60000 })'` and Ctrl-C.
2. Confirm `.pi/intents.json.lock` directory exists.
3. Run `/intent unlock` from the CLI.
4. Confirm directory is gone and a normal `/intent` invocation works.

- [ ] **Step 3: Commit**

```bash
git add extensions/intent/index.ts
git commit -m "feat(intent): add /intent unlock for stale-lock recovery"
```

---

## Task 13: End-to-end verification + close out the intent

**Files:** none (verification + commit only)

- [ ] **Step 1: Full test run**

Run: `npm run typecheck && npm test`
Expected: All PASS.

- [ ] **Step 2: Manual end-to-end run-through**

In a clean main worktree:
1. Create a new intent via `/intent`. Verify `.pi/intents.json` updates on main repo.
2. Switch to a different existing worktree. Run `/intent` — verify the new intent appears.
3. Back on main, fill success criteria + verification on the new intent. Lock it. Confirm "Ready to start?" prompt. Confirm.
4. Verify worktree at `~/.pi/repos/pi-codeslinger/<slug>-<short-id>/` exists, branch `intent/<slug>-<short-id>` exists, fresh session lands inside it.
5. Make some changes, commit. Run `propose_done` flow / mark done from overlay.
6. Verify squash-merge happened on main. Verify "Delete worktree?" prompt. Confirm delete.
7. Verify worktree dir gone and branch deleted.
8. Repeat with a dirty worktree → confirm `done` is blocked.
9. Repeat with a conflicting change on main → confirm conflict surfaces and worktree remains intact.

Document any deviations in the intent's `log.md` (audit trail) before merging.

- [ ] **Step 3: Update intent verification.json**

Once manual + automated verification pass, the implementer subagent should write a passing `verification.json` and run `propose_done`.

- [ ] **Step 4: Final commit / PR**

```bash
git status
# expect clean working tree
```

Then follow the user's normal merge process (this implementation lives in its own intent worktree which gets squash-merged on `done`).

---

## Self-Review Checklist (run before declaring plan complete)

- [x] Every spec line in `e609fe06`'s intent.md has a task that addresses it.
- [x] No "TBD", "TODO", "implement later" in any step.
- [x] Type names consistent across tasks (`Intent`, `IntentStore`, `MergeStatus`, `CreatedWorktree`).
- [x] All new function signatures defined before being called.
- [x] Test file paths and source file paths are absolute and consistent.

**Spec coverage map:**

| Spec line | Task |
|---|---|
| Creating an intent persists to main's `.pi/intents.json` | Tasks 2, 5, 6 |
| Worktree auto-created (lazy on `defining → implementing`) | Task 9 |
| Switching active intent (per-worktree) | Tasks 4, 6 |
| `done` triggers merge to main | Task 10 |
| `done` prompts "delete worktree?" | Task 10 |
| `done` blocked on dirty worktree | Task 10 |
| Concurrent edits don't corrupt intents.json | Tasks 1, 3, 5 |
| `defining → implementing` requires confirm | Task 9 |
| Fresh session per phase transition | Task 9 (preserved from existing behavior) |
| Slug + short-id branch naming | Task 7 |
| Hybrid storage (main contract + worktree audit trail) | Tasks 5, 11 |
| Worktree base path configurable, default `~/.pi/repos/...` | Task 7 |
| Squash merge + abort on conflict | Task 10 |
| File lock with stale-reclaim + manual override | Tasks 3, 12 |
| Direct fs writes (no auto-commit) | Tasks 5, 6 (no commit logic added) |
| Migration: gitignore on non-main via local excludes | Task 11 |
| Abandoned intents: confirm + force-remove | Existing `handleDelete` + Task 10's `removeWorktree` are sufficient — extend `handleDelete` to also call `removeWorktree(intent.worktreePath, intent.worktreeBranch)` if set. (See note below.) |
| Per-worktree active intent in `.git/pi-active-intent` | Task 4 |
| Worktree base = main HEAD | Task 7 |
| Parallel implementing | Naturally enabled by Task 4 (per-worktree active) |
| `ask` extension UI prompts | Task 9, 10 (uses `ctx.ui.confirm`, which is the same overlay system) |
| Cwd-inside-worktree on remove | Task 10 (notify-only fallback documented) |

**Note on Abandoned Intents:** The existing `handleDelete` already confirms; it needs one extension — if `intent.worktreePath` is set, also call `removeWorktree(ctx.cwd, intent.worktreePath, intent.worktreeBranch)` after `deleteIntent`. This is a 3-line change. Add it as part of Task 10's `index.ts` edits or a small follow-up; minimal and explicit, no separate task needed.
