# Bug Fix: Intent Switching Not Working

## Problem

When attempting to switch intents using `pi intent switch <id>`, the command appeared to succeed but did not actually change the active intent. The sidebar continued to show the old intent.

## Root Causes

### 1. No Programmatic Switch Tool

- The `pi intent switch <id>` command doesn't exist as a CLI command
- When run, it was interpreted as a natural language prompt to the AI
- The AI simulated a success response without actually performing any action
- **Only the interactive UI command** (`pi intent` → select "Switch intent") actually worked

### 2. In-Memory State Not Persisted

- The intent extension loads the store once at `session_start`
- Manual edits to `.pi/intents.json` don't update the in-memory store
- The store gets saved periodically, overwriting manual changes
- The sidebar renders from the in-memory store, not the file

### 3. Duplicate Tool Registration

- The `list_intents` tool was registered twice (bug)

## Solutions Implemented

### 1. Added `switch_intent` Tool (Primary Fix)

Added a new programmatic tool in `extensions/intent/index.ts` that allows the AI assistant to switch intents:

```typescript
pi.registerTool({
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
  execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const intent = store.intents.find((i) => i.id === params.intentId);
    if (!intent) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No intent found with ID: ${params.intentId}`,
          },
        ],
        isError: true,
        details: undefined,
      };
    }
    store.activeIntentId = intent.id;
    persist(cwdRef);
    pi.events.emit("intent:active-changed", { id: intent.id });
    return {
      content: [
        {
          type: "text" as const,
          text: `Switched to intent: ${intent.title} (${intent.id})\\nPhase: ${intent.phase}`,
        },
      ],
      isError: false,
      details: undefined,
    };
  },
});
```

Key features:

- Validates the intent ID exists
- Updates the in-memory store
- Persists to disk via `persist()`
- Emits `intent:active-changed` event for UI refresh
- Returns clear success/error messages

### 2. Removed Duplicate Tool Registration

Removed the second identical `list_intents` tool registration.

## Testing

To test the fix:

1. **Restart pi** to load the new extension code
2. Use the AI tool: "switch to intent 54badd46-ccee-4152-b4ef-de992eaa90a1"
3. Verify the sidebar updates to show the new active intent
4. Check `.pi/intents.json` confirms the `activeIntentId` changed

## Files Modified

- `extensions/intent/index.ts` - Added `switch_intent` tool, removed duplicate `list_intents`

## Notes

- The interactive UI command (`pi intent` menu) already worked correctly
- The issue only affected programmatic/AI-driven intent switching
- This fix enables the AI assistant to autonomously switch between intents during conversations
