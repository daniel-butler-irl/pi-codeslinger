import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractVerificationCommands,
  runVerification,
} from "./verification.ts";
import {
  createIntent,
  loadStore,
  saveIntentContent,
  readVerification,
} from "../intent/store.ts";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-verif-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("extractVerificationCommands", () => {
  test("pulls commands from a bash fenced block", () => {
    const contract = `# Intent

## Verification

\`\`\`bash
npm test
npm run typecheck
\`\`\`
`;
    assert.deepEqual(extractVerificationCommands(contract), [
      "npm test",
      "npm run typecheck",
    ]);
  });

  test("strips leading '$ ' prompts and skips comments", () => {
    const contract = `## Verification

\`\`\`sh
$ npm test
# a comment
$ npm run typecheck
\`\`\`
`;
    assert.deepEqual(extractVerificationCommands(contract), [
      "npm test",
      "npm run typecheck",
    ]);
  });

  test("falls back to inline backticks when no fenced block", () => {
    const contract = `## Verification

Run this to verify:

\`npm test\`
`;
    assert.deepEqual(extractVerificationCommands(contract), ["npm test"]);
  });

  test("returns empty when section missing", () => {
    assert.deepEqual(extractVerificationCommands("# No verif"), []);
  });

  test("returns empty when section has only prose", () => {
    const contract = `## Verification

Just run the tests manually.
`;
    assert.deepEqual(extractVerificationCommands(contract), []);
  });
});

describe("runVerification", () => {
  test("runs a passing command and writes the result", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "test pass");
      saveIntentContent(
        cwd,
        intent.id,
        `## Verification

\`\`\`bash
true
\`\`\`
`,
      );
      const result = runVerification(cwd, intent.id);
      assert.equal(result.passed, true);
      assert.equal(result.commands.length, 1);
      assert.equal(result.commands[0].exitCode, 0);

      // Cached file matches.
      assert.deepEqual(readVerification(cwd, intent.id), result);
    });
  });

  test("records failure for a failing command", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "test fail");
      saveIntentContent(
        cwd,
        intent.id,
        `## Verification

\`\`\`bash
false
\`\`\`
`,
      );
      const result = runVerification(cwd, intent.id);
      assert.equal(result.passed, false);
      assert.notEqual(result.commands[0].exitCode, 0);
    });
  });

  test("captures stdout and stderr", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "t");
      saveIntentContent(
        cwd,
        intent.id,
        `## Verification

\`\`\`bash
echo hello; echo oops >&2
\`\`\`
`,
      );
      const result = runVerification(cwd, intent.id);
      assert.ok(result.commands[0].output.includes("hello"));
      assert.ok(result.commands[0].output.includes("oops"));
    });
  });

  test("marks empty command list as an unverified failure", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "t");
      // Default template has an empty Verification section.
      const result = runVerification(cwd, intent.id);
      assert.equal(result.passed, false);
      assert.ok(result.commands[0].output.includes("No verification commands"));
    });
  });

  test("stops at first failure but records all attempted", () => {
    withTempDir((cwd) => {
      const store = loadStore(cwd);
      const intent = createIntent(store, cwd, "t");
      saveIntentContent(
        cwd,
        intent.id,
        `## Verification

\`\`\`bash
true
false
true
\`\`\`
`,
      );
      const result = runVerification(cwd, intent.id);
      assert.equal(result.passed, false);
      assert.equal(result.commands.length, 3);
      assert.equal(result.commands[0].passed, true);
      assert.equal(result.commands[1].passed, false);
      assert.equal(result.commands[2].passed, true);
    });
  });
});
