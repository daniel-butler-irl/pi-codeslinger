import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { withExclusiveLock, forceUnlock, isLocked } from "./lock.ts";

function fixture(): { file: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lock-")));
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
    const lockfile = await import("proper-lockfile");
    const release = await lockfile.lock(file, { stale: 60_000 });
    assert.equal(isLocked(file), true);
    forceUnlock(file);
    assert.equal(isLocked(file), false);
    try { await release(); } catch { /* already removed */ }
  } finally {
    cleanup();
  }
});
