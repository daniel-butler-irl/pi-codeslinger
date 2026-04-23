import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let terseEnabled = true;
let terseInstructions: string | null = null;

// Load the terse instructions once
function loadTerseInstructions(): string {
  if (terseInstructions) return terseInstructions;

  const skillPath = path.join(__dirname, "terse.SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");

  // Remove frontmatter and return just the instructions
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  terseInstructions = bodyMatch ? bodyMatch[1].trim() : content;

  return terseInstructions;
}

function updateStatusBadge(ctx: any): void {
  if (terseEnabled) {
    ctx.ui.setStatus("terse-mode", "[TERSE]");
  } else {
    ctx.ui.setStatus("terse-mode", undefined);
  }
}

export function registerTerseExtension(pi: ExtensionAPI): void {
  // Load instructions on init
  loadTerseInstructions();

  // Register Alt+T hotkey to toggle terse mode
  pi.registerShortcut("alt+t", {
    description: "Toggle terse mode (compress output tokens)",
    handler: async (ctx) => {
      terseEnabled = !terseEnabled;
      const status = terseEnabled ? "enabled" : "disabled";
      ctx.ui.notify(`Terse mode ${status}`, "info");
      updateStatusBadge(ctx);
    },
  });

  // Register /terse command with subcommands
  pi.registerCommand("terse", {
    description: "Manage terse mode: /terse (status), /terse:off, /terse:on",
    handler: async (args, ctx) => {
      const subcommand = args.trim();

      if (subcommand === "off" || subcommand === ":off") {
        terseEnabled = false;
        ctx.ui.notify("Terse mode disabled", "info");
        updateStatusBadge(ctx);
        return;
      }

      if (subcommand === "on" || subcommand === ":on") {
        terseEnabled = true;
        ctx.ui.notify("Terse mode enabled", "info");
        updateStatusBadge(ctx);
        return;
      }

      // No subcommand - show status
      const status = terseEnabled ? "enabled" : "disabled";
      ctx.ui.notify(`Terse mode is currently ${status}`, "info");
    },
  });

  // Reset terse mode to enabled at session start and show badge
  pi.on("session_start", (_event, ctx) => {
    terseEnabled = true;
    updateStatusBadge(ctx);
  });

  // Inject terse instructions when enabled
  pi.on("before_agent_start", async (event) => {
    if (!terseEnabled) {
      // Don't modify prompt when terse is disabled
      return {};
    }

    // Check if terse instructions are already in the prompt
    if (
      event.systemPrompt.includes("Respond terse. Technical substance exact.")
    ) {
      // Already injected, don't duplicate
      return {};
    }

    // Inject terse instructions
    const instructions = loadTerseInstructions();
    const newSystemPrompt = `${event.systemPrompt}\n\n# Terse Mode\n\n${instructions}`;

    return {
      systemPrompt: newSystemPrompt,
    };
  });

  // Intercept file write operations to prevent summary files in repo root
  pi.on("tool_call", (event, ctx) => {
    // Type guard for write tool
    if (event.toolName !== "write") return;

    // TypeScript type narrowing: event is now WriteToolCallEvent
    const writeEvent = event as any; // Cast to access typed properties
    const writePath = writeEvent.input?.path as string | undefined;
    if (!writePath || typeof writePath !== "string") return;

    // Check if writing a .md file
    if (!writePath.endsWith(".md")) return;

    // Resolve to absolute path
    const absolutePath = path.resolve(writePath);
    const cwd = process.cwd();

    // Check if in repo root (not in subdirectory)
    const relativePath = path.relative(cwd, absolutePath);
    const inRoot =
      !relativePath.includes(path.sep) &&
      relativePath === path.basename(writePath);

    if (!inRoot) return;

    // Check if in .pi/ directory (not just starting with .pi)
    if (relativePath.startsWith(".pi/") || relativePath.includes("/.pi/"))
      return;

    // Allowlist
    const basename = path.basename(writePath);
    const allowlist = [
      "README.md",
      "LICENSE.md",
      "CLAUDE.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
    ];
    if (allowlist.includes(basename)) return;

    // Warn user about blocked write
    ctx.ui.notify(
      `⚠️ Terse: Blocked write to ${basename}. Use update_understanding or log entries instead.`,
      "warning",
    );

    // Return block signal
    return { block: true };
  });
}

export default function (pi: ExtensionAPI): void {
  registerTerseExtension(pi);
}

export function isTerseEnabled(): boolean {
  return terseEnabled;
}
