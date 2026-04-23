import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerTerseExtension, isTerseEnabled } from "./index.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

describe("Terse extension", () => {
  let mockPi: ExtensionAPI;
  let registeredShortcuts: Map<string, any>;
  let registeredCommands: Map<string, any>;
  let sessionStartHandlers: Array<(event: any, ctx: any) => void>;
  let beforeAgentStartHandlers: Array<(event: any) => Promise<any>>;

  beforeEach(() => {
    registeredShortcuts = new Map();
    registeredCommands = new Map();
    sessionStartHandlers = [];
    beforeAgentStartHandlers = [];

    mockPi = {
      registerShortcut: (key: string, handler: any) => {
        registeredShortcuts.set(key, handler);
      },
      registerCommand: (name: string, handler: any) => {
        registeredCommands.set(name, handler);
      },
      on: (event: string, handler: any) => {
        if (event === "session_start") {
          sessionStartHandlers.push(handler);
        }
        if (event === "before_agent_start") {
          beforeAgentStartHandlers.push(handler);
        }
      },
    } as any;

    registerTerseExtension(mockPi);

    // Trigger session_start to ensure terse mode is enabled
    const mockCtx = { ui: { notify: () => {}, setStatus: () => {} } };
    for (const handler of sessionStartHandlers) {
      handler({}, mockCtx);
    }
  });

  describe("Hotkey registration", () => {
    it("registers Alt+T shortcut", () => {
      assert.ok(registeredShortcuts.has("alt+t"));
    });

    it("has correct description for Alt+T", () => {
      const shortcut = registeredShortcuts.get("alt+t");
      assert.ok(shortcut.description.includes("Toggle terse mode"));
    });
  });

  describe("Command registration", () => {
    it("registers /terse command", () => {
      assert.ok(registeredCommands.has("terse"));
    });

    it("has correct description for /terse command", () => {
      const command = registeredCommands.get("terse");
      assert.ok(command.description.includes("terse mode"));
    });
  });

  describe("Terse mode toggle", () => {
    let mockContext: any;

    beforeEach(() => {
      mockContext = {
        ui: {
          notify: () => {},
          setStatus: () => {},
        },
      };
    });

    it("starts enabled by default", () => {
      assert.ok(isTerseEnabled());
    });

    it("toggles state when Alt+T is pressed", async () => {
      const shortcut = registeredShortcuts.get("alt+t");
      const initialState = isTerseEnabled();

      await shortcut.handler(mockContext);
      assert.strictEqual(isTerseEnabled(), !initialState);

      await shortcut.handler(mockContext);
      assert.strictEqual(isTerseEnabled(), initialState);
    });

    it("disables with /terse:off", async () => {
      const command = registeredCommands.get("terse");
      await command.handler("off", mockContext);
      assert.strictEqual(isTerseEnabled(), false);
    });

    it("disables with /terse :off (space)", async () => {
      const command = registeredCommands.get("terse");
      await command.handler(":off", mockContext);
      assert.strictEqual(isTerseEnabled(), false);
    });

    it("enables with /terse:on", async () => {
      const command = registeredCommands.get("terse");
      // First disable
      await command.handler("off", mockContext);
      // Then enable
      await command.handler("on", mockContext);
      assert.ok(isTerseEnabled());
    });

    it("enables with /terse :on (space)", async () => {
      const command = registeredCommands.get("terse");
      await command.handler("off", mockContext);
      await command.handler(":on", mockContext);
      assert.ok(isTerseEnabled());
    });

    it("shows status with /terse (no args)", async () => {
      const command = registeredCommands.get("terse");
      let notifyMessage = "";
      mockContext.ui.notify = (msg: string) => {
        notifyMessage = msg;
      };

      await command.handler("", mockContext);
      assert.ok(notifyMessage.match(/enabled|disabled/));
    });
  });

  describe("Session start behavior", () => {
    it("registers session_start handler", () => {
      assert.ok(sessionStartHandlers.length > 0);
    });

    it("resets terse mode to enabled on session start", async () => {
      const command = registeredCommands.get("terse");
      const mockContext = { ui: { notify: () => {}, setStatus: () => {} } };

      // Disable terse mode
      await command.handler("off", mockContext);
      assert.strictEqual(isTerseEnabled(), false);

      // Trigger session start
      for (const handler of sessionStartHandlers) {
        await handler({}, mockContext);
      }

      // Should be re-enabled
      assert.ok(isTerseEnabled());
    });
  });

  describe("before_agent_start behavior", () => {
    it("registers before_agent_start handler", () => {
      assert.ok(beforeAgentStartHandlers.length > 0);
    });

    it("returns empty object when terse disabled", async () => {
      const command = registeredCommands.get("terse");
      const mockContext = { ui: { notify: () => {}, setStatus: () => {} } };

      // Disable terse mode
      await command.handler("off", mockContext);

      const handler = beforeAgentStartHandlers[0];
      const mockEvent = {
        systemPrompt: "Original prompt",
        systemPromptOptions: {},
      };

      const result = await handler(mockEvent);
      assert.deepStrictEqual(result, {});
    });

    it("injects terse instructions when enabled", async () => {
      // Ensure terse is enabled (default state)
      assert.ok(isTerseEnabled());

      const handler = beforeAgentStartHandlers[0];
      const mockEvent = {
        systemPrompt: "Original prompt",
        systemPromptOptions: {},
      };

      const result = await handler(mockEvent);

      assert.ok(result.systemPrompt);
      assert.ok(result.systemPrompt.includes("Original prompt"));
      assert.ok(result.systemPrompt.includes("# Terse Mode"));
      assert.ok(result.systemPrompt.includes("Respond terse"));
    });

    it("prevents double-injection when already present", async () => {
      assert.ok(isTerseEnabled());

      const handler = beforeAgentStartHandlers[0];
      const mockEvent = {
        systemPrompt:
          "Original prompt\n\nRespond terse. Technical substance exact.",
        systemPromptOptions: {},
      };

      const result = await handler(mockEvent);

      // Should return empty object, not inject again
      assert.deepStrictEqual(result, {});
    });
  });
});
