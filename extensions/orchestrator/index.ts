/**
 * Orchestrator extension entry point.
 *
 * Responsibilities:
 *   - Loads agent definitions from ./agents/*.md
 *   - Instantiates the OrchestratorDriver at session_start
 *   - Subscribes the driver to intent lifecycle events
 *   - Disposes live subagents on session_shutdown
 *
 * Keeps no state of its own — everything lives in the driver and its
 * FlightTable.
 */
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { loadAgentDefinitions } from "./agent-defs.ts";
import { OrchestratorDriver } from "./driver.ts";

// Resolve our own location so we find the bundled agents/ directory
// regardless of where the user's cwd is when Pi launches.
const here = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(here, "agents");

export default function (pi: ExtensionAPI) {
  let driver: OrchestratorDriver | null = null;

  pi.on("session_start", (_event, ctx) => {
    try {
      const agentDefs = loadAgentDefinitions(AGENTS_DIR);
      if (agentDefs.size === 0) {
        ctx.ui.setStatus(
          "orchestrator",
          ctx.ui.theme.fg("dim", "orchestrator: no agent definitions found"),
        );
        return;
      }

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      driver = new OrchestratorDriver(
        pi,
        ctx.cwd,
        authStorage,
        modelRegistry,
        agentDefs,
      );
      driver.start();

      ctx.ui.setStatus(
        "orchestrator",
        ctx.ui.theme.fg(
          "dim",
          `orchestrator: ${agentDefs.size} agent(s) loaded`,
        ),
      );
    } catch (err) {
      // Orchestrator failure must not block the host session. Log and
      // continue; the intent extension still works without it.
      ctx.ui.notify(
        `Orchestrator failed to start: ${(err as Error).message}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (driver) {
      await driver.shutdown();
      driver = null;
    }
  });
}
