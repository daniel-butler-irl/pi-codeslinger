/**
 * Orchestrator extension entry point.
 *
 * The OrchestratorDriver is a process-level singleton — built once on the
 * first session_start and reused across `ctx.newSession()` round-trips
 * (intent switch, lock, transition-to-implementing). This keeps in-flight
 * subagent work alive when the user switches focus between intents.
 *
 * session_start refreshes UI surfaces only. Real teardown waits for
 * process exit.
 */
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { auditAgentDefinitions, loadAgentDefinitions } from "./agent-defs.ts";
import { DEFAULT_AGENT_BINDING, OrchestratorDriver } from "./driver.ts";
export type { OrchestratorDriver } from "./driver.ts";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(here, "agents");

interface DriverRecord {
  driver: OrchestratorDriver;
  agentCount: number;
}

// Singleton registry keyed by cwd. Survives newSession round-trips.
// Multiple repos in the same process get isolated drivers.
const driversByCwd = new Map<string, DriverRecord>();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const dispose = async () => {
    for (const { driver } of driversByCwd.values()) {
      try {
        await driver.shutdown();
      } catch {
        // ignore per-driver shutdown errors at process exit
      }
    }
    driversByCwd.clear();
  };
  process.once("beforeExit", () => {
    void dispose();
  });
  process.once("SIGINT", () => {
    void dispose().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void dispose().then(() => process.exit(0));
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    try {
      const existing = driversByCwd.get(ctx.cwd);
      if (existing) {
        ctx.ui.setStatus(
          "orchestrator",
          ctx.ui.theme.fg(
            "dim",
            `orchestrator: ${existing.agentCount} agent(s) loaded`,
          ),
        );
        return;
      }

      const agentDefs = loadAgentDefinitions(AGENTS_DIR);
      if (agentDefs.size === 0) {
        ctx.ui.setStatus(
          "orchestrator",
          ctx.ui.theme.fg("dim", "orchestrator: no agent definitions found"),
        );
        return;
      }

      const audit = auditAgentDefinitions(agentDefs, [
        DEFAULT_AGENT_BINDING.implementer,
        DEFAULT_AGENT_BINDING.reviewer,
      ]);
      if (audit.errors.length > 0) {
        throw new Error(audit.errors.join("\n"));
      }
      for (const w of audit.warnings) {
        ctx.ui.notify(`orchestrator: ${w}`, "warning");
      }

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      const driver = new OrchestratorDriver(
        pi,
        ctx.cwd,
        authStorage,
        modelRegistry,
        agentDefs,
      );
      driver.start();
      driversByCwd.set(ctx.cwd, {
        driver,
        agentCount: agentDefs.size,
      });
      installExitHook();

      ctx.ui.setStatus(
        "orchestrator",
        ctx.ui.theme.fg(
          "dim",
          `orchestrator: ${agentDefs.size} agent(s) loaded`,
        ),
      );
    } catch (err) {
      ctx.ui.notify(
        `Orchestrator failed to start: ${(err as Error).message}`,
        "warning",
      );
    }
  });

  // session_shutdown is per host-session (fired on newSession). Driver
  // and FlightTable persist; subagents continue running. Real teardown
  // happens via the process-exit hook installed above.
}

/**
 * Return the live driver for a given cwd, or undefined if not yet started.
 * Used by other extensions (e.g., intent panel) to access active agents.
 */
export function getDriver(cwd: string): OrchestratorDriver | undefined {
  return driversByCwd.get(cwd)?.driver;
}

// Test-only: reset the singleton registry. Production code should not
// call this — driver lifetime is the process lifetime.
export function __resetOrchestratorRegistryForTests(): void {
  for (const { driver } of driversByCwd.values()) {
    void driver.shutdown();
  }
  driversByCwd.clear();
}
