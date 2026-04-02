// extensions/chat-ui/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { ChatStore } from "./store.js";
import { ChatUIComponent } from "./component.js";

export default function (pi: ExtensionAPI) {
  const store = new ChatStore();
  let component: ChatUIComponent | null = null;
  let tuiRef: TUI | null = null;

  // ── Pi event listeners ────────────────────────────────────────────────────
  // Registered here so closures capture store/component/tuiRef.
  // They only fire after session_start has run (component + tuiRef are set).

  pi.on("message_start", (event) => {
    store.onMessageStart(
      (event as any).message?.id ?? store.entries.length.toString(),
      (event as any).message,
    );
    component?.invalidate();
    tuiRef?.requestRender();
  });

  pi.on("message_update", (event) => {
    store.onMessageUpdate((event as any).message);
    component?.invalidate();
    tuiRef?.requestRender();
  });

  pi.on("message_end", (event) => {
    store.onMessageEnd((event as any).message);
    component?.invalidate();
    tuiRef?.requestRender();
  });

  pi.on("tool_execution_start", (event) => {
    const e = event as any;
    store.onToolStart(e.toolCallId, e.toolName, e.args ?? {});
    component?.invalidate();
    tuiRef?.requestRender();
  });

  pi.on("tool_execution_end", (event) => {
    const e = event as any;
    store.onToolEnd(e.toolCallId, e.result, e.isError);
    component?.invalidate();
    tuiRef?.requestRender();
  });

  pi.on("input", (event) => {
    const e = event as any;
    store.onInput(e.text ?? "");
    component?.invalidate();
    tuiRef?.requestRender();
  });

  // ── session_start: clear terminal, seed history, launch custom UI ─────────

  pi.on("session_start", (_event, ctx) => {
    // Clear terminal so there is nothing in the scrollback buffer
    process.stdout.write("\x1b[2J\x1b[H");

    // Seed store from existing session history (e.g. session resume)
    const entries = ctx.sessionManager.getEntries();
    store.seedFromEntries(entries as any[]);

    // Launch full-screen custom UI as a full-viewport overlay (fire-and-forget — never resolves).
    // overlay: true + row/col 0, 100% width/height causes our component to composite over Pi's
    // native chat/header/footer on every frame, giving us true full-screen control.
    ctx.ui.custom(
      (tui, theme, _kb, _done) => {
        tuiRef = tui;
        component = new ChatUIComponent(store, tui, theme, pi, ctx.cwd);
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          row: 0,
          col: 0,
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );
  });
}
