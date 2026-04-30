/**
 * Canonical intent tool factory.
 *
 * Both `extensions/intent` (main session) and `extensions/qq` (side-chat)
 * share these implementations so the agent has a consistent surface across
 * sessions. Differences in disposition (e.g., qq runs without a UI) are
 * expressed via the optional callbacks passed in, not by reimplementing.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createIntent,
  deleteIntent,
  filterIntents,
  getActiveIntent,
  loadIntentContent,
  loadStore,
  readLog,
  readUnderstanding,
  readVerification,
  saveIntentContent,
  saveStore,
  transitionPhase,
  writeUnderstanding,
  type Intent,
  type IntentPhase,
  type IntentStore,
} from "./store.ts";
import { readActiveIntent, writeActiveIntent } from "./active-local.ts";
import { validateIntentForLock } from "./validate.ts";
import {
  createWorktree,
  worktreePath,
  branchName,
  type CreatedWorktree,
} from "./worktree-manager.ts";
import { mainRepoRoot, mainIntentContractPath } from "./paths.ts";
import { existsSync } from "node:fs";

/**
 * Options the factory needs to wire into the host extension.
 *
 * - `pi`: ExtensionAPI for emitting events.
 * - `getCwd`: returns the current working directory for the session. Both
 *   extensions track cwd dynamically (intent updates `cwdRef` after worktree
 *   swap), so we take a getter rather than a value.
 * - `getStore` / `setStore`: optional; when provided the factory mutates the
 *   in-memory store the host already maintains. When absent the factory
 *   loads/saves from disk on each call (qq's stateless model).
 * - `refreshPanel`: optional UI hook the factory calls after mutating state.
 * - `injectIntentContext`: optional hook to re-inject context after writes
 *   that change the contract or understanding.
 * - `gateAndCreateWorktree`: optional hook to gate + create a worktree on
 *   lock. When present, lock_intent (with `createWorktree:true`) calls it.
 *   When absent or `createWorktree:false`, the lock skips worktree creation.
 */
export interface MakeIntentToolsOptions {
  pi: ExtensionAPI;
  getCwd: () => string;
  getStore?: () => IntentStore;
  setStore?: (store: IntentStore) => void;
  refreshPanel?: () => void;
  injectIntentContext?: () => void;
  gateAndCreateWorktree?: (intent: Intent) => Promise<CreatedWorktree | null>;
}

const noActiveIntent = {
  content: [
    {
      type: "text" as const,
      text: "No active intent. Create or switch to an intent first.",
    },
  ],
  isError: true,
  details: undefined,
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
    details: undefined,
  };
}

export function makeIntentTools(opts: MakeIntentToolsOptions): any[] {
  const { pi, getCwd } = opts;

  function getStore(): IntentStore {
    if (opts.getStore) return opts.getStore();
    return loadStore(getCwd());
  }

  async function persistStore(store: IntentStore): Promise<void> {
    await saveStore(getCwd(), store);
    opts.refreshPanel?.();
  }

  return [
    {
      name: "create_intent",
      label: "Create Intent",
      description:
        "Create a new intent from a description and make it the active intent. Optionally create it as a child of an existing intent.",
      promptSnippet:
        "Create a new intent or child intent from a short description.",
      parameters: Type.Object({
        description: Type.String({
          description: "Short description of the new intent.",
        }),
        parentIntentId: Type.Optional(
          Type.String({
            description:
              "Optional parent intent ID to create a child intent under.",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { description: string; parentIntentId?: string },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const parentIntentId = params.parentIntentId?.trim();
        if (
          parentIntentId &&
          !store.intents.some((i) => i.id === parentIntentId)
        ) {
          return textResult(
            `No intent found with ID: ${parentIntentId}`,
            true,
          );
        }
        const intent = createIntent(store, cwd, params.description, {
          parentId: parentIntentId ?? null,
        });
        writeActiveIntent(cwd, intent.id);
        await persistStore(store);
        pi.events.emit("intent:created", { id: intent.id });
        pi.events.emit("intent:active-changed", { id: intent.id });
        return textResult(
          `Created intent: ${intent.title} (${intent.id})\n` +
            `Phase: ${intent.phase}` +
            (intent.parentId ? `\nParent: ${intent.parentId}` : ""),
        );
      },
    },

    {
      name: "delete_intent",
      label: "Delete Intent",
      description:
        "Delete an intent by ID. Defaults to the active intent when no ID is provided. " +
        "Refuses if the intent has child intents — delete leaves first.",
      parameters: Type.Object({
        intentId: Type.Optional(
          Type.String({
            description:
              "Optional intent ID to delete. Defaults to the active intent.",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { intentId?: string },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const targetId = params.intentId ?? readActiveIntent(cwd) ?? undefined;
        if (!targetId) return noActiveIntent;
        const target = store.intents.find((i) => i.id === targetId);
        if (!target) {
          return textResult(`No intent found with ID: ${targetId}`, true);
        }
        try {
          deleteIntent(store, cwd, targetId);
        } catch (err) {
          return textResult(
            err instanceof Error ? err.message : String(err),
            true,
          );
        }
        if (readActiveIntent(cwd) === targetId) {
          writeActiveIntent(cwd, null);
        }
        await persistStore(store);
        pi.events.emit("intent:deleted", { id: targetId });
        const newActive = readActiveIntent(cwd);
        if (newActive) {
          pi.events.emit("intent:active-changed", { id: newActive });
        }
        return textResult(`Deleted intent: ${target.title} (${target.id})`);
      },
    },

    {
      name: "read_intent",
      label: "Read Intent",
      description:
        "Read the contract for the active intent. Returns the full content " +
        "of the intent.md file (Description, Success Criteria, and Verification sections).",
      parameters: Type.Object({}),
      execute: async () => {
        const cwd = getCwd();
        const active = getActiveIntent(getStore(), cwd);
        if (!active) return noActiveIntent;
        const content = loadIntentContent(cwd, active.id);
        return textResult(content || "(Intent contract file is empty)");
      },
    },

    {
      name: "list_intents",
      label: "List Intents",
      description:
        "List all intents in the project with their metadata (id, title, phase, " +
        "parent relationship). Useful for understanding the intent tree structure, " +
        "finding related work, or checking status.",
      parameters: Type.Object({
        filter: Type.Optional(
          Type.Union(
            [
              Type.Literal("all"),
              Type.Literal("active"),
              Type.Literal("done"),
              Type.Literal("children"),
            ],
            {
              description:
                'Filter: "all" (default), "active" (current intent only), ' +
                '"done" (completed intents), "children" (children of current intent)',
            },
          ),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { filter?: "all" | "active" | "done" | "children" },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const filter = params.filter ?? "all";
        const intents = filterIntents(store, filter, cwd);
        const currentActiveId = readActiveIntent(cwd);

        if (intents.length === 0) {
          return textResult("No intents found matching the filter.");
        }

        const lines = intents.map((intent) => {
          const active = intent.id === currentActiveId ? " [ACTIVE]" : "";
          const parent = intent.parentId ? ` (child of ${intent.parentId})` : "";
          return (
            `- ${intent.title}${active}\n` +
            `  ID: ${intent.id}\n` +
            `  Phase: ${intent.phase}\n` +
            `  Rework count: ${intent.reworkCount}${parent}`
          );
        });

        return textResult(
          `Found ${intents.length} intent(s):\n\n${lines.join("\n\n")}`,
        );
      },
    },

    {
      name: "read_intent_log",
      label: "Read Intent Log",
      description:
        "Read the append-only log for the active intent. The log contains " +
        "discoveries, decisions, verification results, review findings, and " +
        "other timestamped events from the intent's lifecycle.",
      parameters: Type.Object({}),
      execute: async () => {
        const cwd = getCwd();
        const active = getActiveIntent(getStore(), cwd);
        if (!active) return noActiveIntent;
        const content = readLog(cwd, active.id);
        return textResult(content || "(Log is empty)");
      },
    },

    {
      name: "read_intent_understanding",
      label: "Read Intent Understanding",
      description:
        "Read the understanding file for the active intent. This contains " +
        "the session's current problem understanding, key discoveries, next " +
        "steps needed, and open questions.",
      parameters: Type.Object({}),
      execute: async () => {
        const cwd = getCwd();
        const active = getActiveIntent(getStore(), cwd);
        if (!active) return noActiveIntent;
        const content = readUnderstanding(cwd, active.id);
        return textResult(content || "(Understanding file is empty)");
      },
    },

    {
      name: "read_verification_results",
      label: "Read Verification Results",
      description:
        "Read the cached verification results for the active intent. Shows " +
        "which commands passed or failed in the most recent verification run, " +
        "with exit codes and output.",
      parameters: Type.Object({}),
      execute: async () => {
        const cwd = getCwd();
        const active = getActiveIntent(getStore(), cwd);
        if (!active) return noActiveIntent;
        const result = readVerification(cwd, active.id);
        if (!result) {
          return textResult("No verification results available yet.");
        }
        const summary = `Verification ran at: ${result.ranAt}\nOverall: ${
          result.passed ? "PASSED" : "FAILED"
        }\n\n`;
        const commands = result.commands
          .map(
            (cmd) =>
              `Command: ${cmd.command}\n` +
              `Status: ${cmd.passed ? "✓ PASS" : "✗ FAIL"} (exit ${cmd.exitCode})\n` +
              (cmd.output ? `Output:\n${cmd.output}\n` : ""),
          )
          .join("\n");
        return textResult(summary + commands);
      },
    },

    {
      name: "update_understanding",
      label: "Update Understanding",
      description:
        "Update the session's understanding of the current intent problem. " +
        "This should capture: 1) current problem understanding, 2) key discoveries, " +
        "3) next steps needed, 4) open questions. This persists across sessions.",
      parameters: Type.Object({
        understanding: Type.String({
          description:
            "Markdown-formatted summary of current problem understanding, " +
            "next steps, and open questions. Should be concise but informative.",
        }),
      }),
      execute: async (
        _toolCallId: string,
        params: { understanding: string },
      ) => {
        const cwd = getCwd();
        const active = getActiveIntent(getStore(), cwd);
        if (!active) return noActiveIntent;
        writeUnderstanding(cwd, active.id, params.understanding);
        opts.refreshPanel?.();
        opts.injectIntentContext?.();
        pi.events.emit("intent:updated", { id: active.id });
        return textResult(
          "Understanding updated and will persist across sessions.",
        );
      },
    },

    {
      name: "switch_intent",
      label: "Switch Intent",
      description:
        "Switch the active intent to a different intent by ID. This changes which " +
        "intent's contract, understanding, and tools are active.",
      parameters: Type.Object({
        intentId: Type.String({
          description: "The ID of the intent to switch to",
        }),
      }),
      execute: async (
        _toolCallId: string,
        params: { intentId: string },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const intent = store.intents.find((i) => i.id === params.intentId);
        if (!intent) {
          return textResult(`No intent found with ID: ${params.intentId}`, true);
        }
        writeActiveIntent(cwd, intent.id);
        await persistStore(store);
        pi.events.emit("intent:active-changed", { id: intent.id });
        return textResult(
          `Switched to intent: ${intent.title} (${intent.id})\nPhase: ${intent.phase}`,
        );
      },
    },

    {
      name: "write_intent_contract",
      label: "Write Intent Contract",
      description:
        "Write or update sections of the active intent's contract (intent.md). " +
        "Resolves to the main repo path, even when called from a worktree. " +
        "Refuses if the intent is not in the defining phase. " +
        "Provide any combination of description, successCriteria, and verification — " +
        "only provided sections are rewritten; omitted sections are preserved.",
      promptSnippet:
        "Update the intent contract (Description, Success Criteria, Verification).",
      parameters: Type.Object({
        intentId: Type.Optional(
          Type.String({
            description:
              "Intent ID to write. Defaults to the active intent.",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description: "New body for the Description section.",
          }),
        ),
        successCriteria: Type.Optional(
          Type.String({
            description: "New body for the Success Criteria section.",
          }),
        ),
        verification: Type.Optional(
          Type.String({
            description: "New body for the Verification section.",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: {
          intentId?: string;
          description?: string;
          successCriteria?: string;
          verification?: string;
        },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const targetId = params.intentId ?? readActiveIntent(cwd) ?? undefined;
        if (!targetId) return noActiveIntent;
        const intent = store.intents.find((i) => i.id === targetId);
        if (!intent) {
          return textResult(`No intent found with ID: ${targetId}`, true);
        }
        if (intent.phase !== "defining") {
          return textResult(
            `Intent contract is locked (phase: ${intent.phase}). ` +
              `The contract is immutable outside the defining phase.`,
            true,
          );
        }

        const provided: Array<{ heading: string; body: string }> = [];
        if (params.description !== undefined) {
          provided.push({ heading: "Description", body: params.description });
        }
        if (params.successCriteria !== undefined) {
          provided.push({
            heading: "Success Criteria",
            body: params.successCriteria,
          });
        }
        if (params.verification !== undefined) {
          provided.push({ heading: "Verification", body: params.verification });
        }
        if (provided.length === 0) {
          return textResult(
            "No sections provided. Pass at least one of description, successCriteria, verification.",
            true,
          );
        }

        const current = loadIntentContent(cwd, intent.id);
        let updated = current;
        for (const { heading, body } of provided) {
          updated = replaceSection(updated, heading, body);
        }
        // Resolve canonical main-repo contract path for the response.
        const path = mainContractPath(cwd, intent.id);
        saveIntentContent(cwd, intent.id, updated);
        intent.updatedAt = Date.now();
        await persistStore(store);
        pi.events.emit("intent:updated", { id: intent.id });
        opts.injectIntentContext?.();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Updated intent contract sections: ${provided
                  .map((p) => p.heading)
                  .join(", ")}\nPath: ${path}`,
            },
          ],
          isError: false,
          details: {
            ok: true,
            written: provided.map((p) => p.heading),
            path,
          },
        };
      },
    },

    {
      name: "lock_intent",
      label: "Lock Intent",
      description:
        "Lock the active intent and move it from defining to implementing. " +
        "Validates that all required contract sections are filled. Returns a " +
        "structured failure with the missing section names if validation fails. " +
        "When createWorktree is true (default), creates a git worktree for the work.",
      parameters: Type.Object({
        intentId: Type.Optional(
          Type.String({
            description: "Intent ID to lock. Defaults to the active intent.",
          }),
        ),
        createWorktree: Type.Optional(
          Type.Boolean({
            description:
              "Whether to create a git worktree as part of locking. Default true. " +
              "Set false for non-interactive callers (e.g., side-chat) that " +
              "cannot prompt the user.",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { intentId?: string; createWorktree?: boolean },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const targetId = params.intentId ?? readActiveIntent(cwd) ?? undefined;
        if (!targetId) return noActiveIntent;
        const intent = store.intents.find((i) => i.id === targetId);
        if (!intent) {
          return textResult(`No intent found with ID: ${targetId}`, true);
        }
        if (intent.phase !== "defining") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Intent is already locked (phase: ${intent.phase}).`,
              },
            ],
            isError: true,
            details: { ok: false, reason: "not-defining", phase: intent.phase },
          };
        }

        const content = loadIntentContent(cwd, intent.id);
        const validation = validateIntentForLock(content);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot lock intent — missing: ${validation.missing.join(", ")}`,
              },
            ],
            isError: true,
            details: { ok: false, missing: validation.missing },
          };
        }

        const wantWorktree = params.createWorktree !== false;
        let created: CreatedWorktree | null = null;
        if (wantWorktree) {
          if (opts.gateAndCreateWorktree) {
            created = await opts.gateAndCreateWorktree(intent);
            if (!created) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      "Worktree creation was declined or failed. Lock aborted.",
                  },
                ],
                isError: true,
                details: { ok: false, reason: "worktree-aborted" },
              };
            }
          } else {
            // No host-provided gate (e.g., qq side-chat). Create the worktree
            // directly using the canonical helper so behavior matches overlay.
            try {
              created = createOrAdoptWorktree(cwd, intent);
            } catch (err) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Worktree creation failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  },
                ],
                isError: true,
                details: { ok: false, reason: "worktree-failed" },
              };
            }
            intent.worktreePath = created.path;
            intent.worktreeBranch = created.branch;
          }
        }

        const from: IntentPhase = intent.phase;
        try {
          transitionPhase(store, intent.id, "implementing");
        } catch (err) {
          return textResult(
            err instanceof Error ? err.message : String(err),
            true,
          );
        }
        await persistStore(store);
        pi.events.emit("intent:phase-changed", {
          id: intent.id,
          from,
          to: "implementing",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: created
                ? `Intent locked: ${intent.title} (${intent.id})\nWorktree: ${created.path}\nBranch: ${created.branch}`
                : `Intent locked: ${intent.title} (${intent.id})`,
            },
          ],
          isError: false,
          details: {
            ok: true,
            phase: "implementing",
            worktreePath: created?.path,
            worktreeBranch: created?.branch,
          },
        };
      },
    },

    {
      name: "transition_phase",
      label: "Transition Phase",
      description:
        "Transition an intent to a new phase. Validates the transition is legal " +
        "and emits intent:phase-changed. Note: locking (defining → implementing) " +
        "should use lock_intent instead so the worktree is created.",
      parameters: Type.Object({
        intentId: Type.Optional(
          Type.String({
            description: "Intent ID. Defaults to the active intent.",
          }),
        ),
        toPhase: Type.Union(
          [
            Type.Literal("defining"),
            Type.Literal("implementing"),
            Type.Literal("reviewing"),
            Type.Literal("proposed-ready"),
            Type.Literal("done"),
            Type.Literal("blocked-on-child"),
          ],
          { description: "Target phase." },
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: { intentId?: string; toPhase: IntentPhase },
      ) => {
        const cwd = getCwd();
        const store = getStore();
        const targetId = params.intentId ?? readActiveIntent(cwd) ?? undefined;
        if (!targetId) return noActiveIntent;
        const intent = store.intents.find((i) => i.id === targetId);
        if (!intent) {
          return textResult(`No intent found with ID: ${targetId}`, true);
        }
        const from = intent.phase;
        try {
          transitionPhase(store, intent.id, params.toPhase);
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
            details: {
              ok: false,
              reason: err instanceof Error ? err.message : String(err),
            },
          };
        }
        await persistStore(store);
        pi.events.emit("intent:phase-changed", {
          id: intent.id,
          from,
          to: params.toPhase,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Intent ${intent.title} moved: ${from} → ${params.toPhase}`,
            },
          ],
          isError: false,
          details: { ok: true, from, to: params.toPhase },
        };
      },
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Replace (or insert) a `## <heading>` section's body inside `content`.
 * Preserves all other sections. If the heading is not present, appends it
 * at the end of the file.
 */
function replaceSection(
  content: string,
  heading: string,
  body: string,
): string {
  const trimmedBody = body.replace(/\s+$/, "");
  const headingPattern = new RegExp(
    `^##\\s+${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = content.match(headingPattern);
  if (!match) {
    const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    return `${content}${sep}\n## ${heading}\n${trimmedBody}\n`;
  }
  const startIdx = match.index! + match[0].length;
  // Find next ## heading
  const rest = content.slice(startIdx);
  const nextHeading = rest.match(/\n##\s+/);
  const endIdx = nextHeading
    ? startIdx + nextHeading.index!
    : content.length;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx);
  return `${before}\n${trimmedBody}\n${after.startsWith("\n") ? after : `\n${after}`}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mainContractPath(cwd: string, id: string): string {
  return mainIntentContractPath(cwd, id);
}

/**
 * Worktree creation path used when no host-provided gate is available
 * (e.g., qq side-chat). Mirrors the overlay's `gateAndCreateWorktree` body
 * minus the user-confirm step: re-uses an existing worktree if present,
 * otherwise creates a new one off main.
 */
function createOrAdoptWorktree(
  cwd: string,
  intent: Intent,
): CreatedWorktree {
  if (intent.worktreePath && intent.worktreeBranch) {
    if (existsSync(intent.worktreePath)) {
      return { path: intent.worktreePath, branch: intent.worktreeBranch };
    }
  }
  const proposedPath = worktreePath(
    mainRepoRoot(cwd),
    intent.title,
    intent.id,
  );
  const proposedBranch = branchName(intent.title, intent.id);
  if (existsSync(proposedPath)) {
    return { path: proposedPath, branch: proposedBranch };
  }
  return createWorktree(cwd, intent.title, intent.id);
}
