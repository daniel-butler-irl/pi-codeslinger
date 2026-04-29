import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseAgentDefinition, loadAgentDefinitions } from "./agent-defs.ts";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-defs-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseAgentDefinition", () => {
  test("parses a valid agent definition", () => {
    const content = `---
name: intent-reviewer
description: Adversarial reviewer for implementation artifacts.
provider: openai
model: gpt-4o
tools: read, grep, find, ls
---

You are the adversarial reviewer.
`;
    const def = parseAgentDefinition("intent-reviewer.md", content);
    assert.equal(def.name, "intent-reviewer");
    assert.equal(
      def.description,
      "Adversarial reviewer for implementation artifacts.",
    );
    assert.equal(def.provider, "openai");
    assert.equal(def.model, "gpt-4o");
    assert.deepEqual(def.tools, ["read", "grep", "find", "ls"]);
    assert.ok(def.systemPrompt.startsWith("You are the adversarial reviewer."));
  });

  test("handles empty tools list", () => {
    const content = `---
name: tiny
description: Tiny.
provider: openai
model: gpt-4o-mini
tools:
---

body
`;
    const def = parseAgentDefinition("tiny.md", content);
    assert.deepEqual(def.tools, []);
  });

  test("ignores commented lines in frontmatter", () => {
    const content = `---
# this is a note
name: x
description: X.
provider: openai
model: gpt-4o
---

body
`;
    const def = parseAgentDefinition("x.md", content);
    assert.equal(def.name, "x");
  });

  test("throws on missing frontmatter", () => {
    assert.throws(
      () => parseAgentDefinition("bad.md", "no frontmatter\n"),
      /malformed frontmatter/,
    );
  });

  test("allows missing provider and model (main-chat mode)", () => {
    const content = `---
name: x
description: X.
---

body
`;
    const def = parseAgentDefinition("x.md", content);
    assert.equal(def.name, "x");
    assert.equal(def.provider, undefined);
    assert.equal(def.model, undefined);
  });

  test("throws on missing required name", () => {
    const content = `---
description: X.
---

body
`;
    assert.throws(
      () => parseAgentDefinition("x.md", content),
      /missing required field "name"/,
    );
  });
});

describe("loadAgentDefinitions", () => {
  test("loads all .md files from a directory", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "a.md"),
        `---
name: a
description: A.
provider: openai
model: gpt-4o
---

A body
`,
      );
      writeFileSync(
        join(dir, "b.md"),
        `---
name: b
description: B.
provider: google
model: gemini-2.5-pro
---

B body
`,
      );
      // A non-markdown file should be ignored.
      writeFileSync(join(dir, "notes.txt"), "ignore me");

      const defs = loadAgentDefinitions(dir);
      assert.equal(defs.size, 2);
      assert.ok(defs.has("a"));
      assert.ok(defs.has("b"));
    });
  });

  test("returns empty map for non-existent directory", () => {
    const defs = loadAgentDefinitions("/tmp/definitely-not-there-xyz");
    assert.equal(defs.size, 0);
  });

  test("throws on duplicate agent names", () => {
    withTempDir((dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "one.md"),
        `---
name: shared
description: X.
provider: openai
model: gpt-4o
---

`,
      );
      writeFileSync(
        join(dir, "two.md"),
        `---
name: shared
description: Y.
provider: openai
model: gpt-4o
---

`,
      );
      assert.throws(
        () => loadAgentDefinitions(dir),
        /Duplicate agent definition name/,
      );
    });
  });
});

describe("auditAgentDefinitions", () => {
  test("errors when canonical role is missing", async () => {
    const { auditAgentDefinitions } = await import("./agent-defs.ts");
    const defs = new Map();
    const audit = auditAgentDefinitions(defs, ["intent-implementer", "intent-reviewer"]);
    assert.equal(audit.errors.length, 2);
    assert.match(audit.errors[0], /not loaded/);
  });

  test("errors when canonical role lacks provider/model", async () => {
    const { auditAgentDefinitions } = await import("./agent-defs.ts");
    const defs = new Map([
      [
        "intent-implementer",
        {
          name: "intent-implementer",
          description: "x",
          tools: [],
          systemPrompt: "x",
        },
      ],
      [
        "intent-reviewer",
        {
          name: "intent-reviewer",
          description: "x",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          tools: [],
          systemPrompt: "x",
        },
      ],
    ]);
    const audit = auditAgentDefinitions(defs, ["intent-implementer", "intent-reviewer"]);
    assert.equal(audit.errors.length, 1);
    assert.match(audit.errors[0], /must declare provider and model/);
  });

  test("warns for non-canonical roles missing provider/model", async () => {
    const { auditAgentDefinitions } = await import("./agent-defs.ts");
    const defs = new Map([
      [
        "intent-implementer",
        {
          name: "intent-implementer",
          description: "x",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          tools: [],
          systemPrompt: "x",
        },
      ],
      [
        "intent-reviewer",
        {
          name: "intent-reviewer",
          description: "x",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          tools: [],
          systemPrompt: "x",
        },
      ],
      [
        "extra-helper",
        {
          name: "extra-helper",
          description: "x",
          tools: [],
          systemPrompt: "x",
        },
      ],
    ]);
    const audit = auditAgentDefinitions(defs, ["intent-implementer", "intent-reviewer"]);
    assert.equal(audit.errors.length, 0);
    assert.equal(audit.warnings.length, 1);
    assert.match(audit.warnings[0], /extra-helper/);
  });

  test("clean audit returns no errors or warnings", async () => {
    const { auditAgentDefinitions } = await import("./agent-defs.ts");
    const defs = new Map([
      [
        "intent-implementer",
        {
          name: "intent-implementer",
          description: "x",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          tools: [],
          systemPrompt: "x",
        },
      ],
      [
        "intent-reviewer",
        {
          name: "intent-reviewer",
          description: "x",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          tools: [],
          systemPrompt: "x",
        },
      ],
    ]);
    const audit = auditAgentDefinitions(defs, ["intent-implementer", "intent-reviewer"]);
    assert.deepEqual(audit, { errors: [], warnings: [] });
  });
});
