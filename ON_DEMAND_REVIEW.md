# On-Demand Review Feature

## Problem

When an intent is in the `reviewing` phase, the orchestrator automatically spawns a reviewer agent. However, if you:

1. Manually fix issues found by the reviewer
2. Hand-edit any implementation files

There was **no way to re-trigger the reviewer** to verify your fixes. The only options were:

- "Mark as done" (skip verification)
- "Send back for rework" (go back to implementing phase, losing review context)

## Solution

Added a **"Review" action** that's available when an intent is in the `reviewing` phase. This action:

1. Emits an `intent:phase-changed` event with `from: "reviewing"` and `to: "reviewing"`
2. The orchestrator catches this event and re-runs the review
3. The reviewer runs in the **current session** (no session restart)

### UI Flow

When you open the overlay (`Ctrl+I`) on an intent in `reviewing` phase, the actions menu shows:

```
▶ Review                    ← New action! Triggers a fresh review
  Mark as done
  Send back for rework
  Delete intent
```

## Implementation Details

### New Action Type

Added `review` to the `OverlayAction` union type:

```typescript
export type OverlayAction =
  | { type: "create"; description: string }
  | { type: "switch"; intentId: string }
  | { type: "edit"; intentId: string }
  | { type: "lock"; intentId: string }
  | { type: "transition"; intentId: string; toPhase: IntentPhase }
  | { type: "review"; intentId: string } // ← New
  | { type: "delete"; intentId: string }
  | { type: "cancel" };
```

### Handler Function

Created `handleReview()` in `extensions/intent/index.ts`:

```typescript
async function handleReview(
  ctx: ExtensionCommandContext | ExtensionContext,
  intentId: string,
): Promise<void> {
  const intent = store.intents.find((i) => i.id === intentId);
  if (!intent) return;

  // Only allow review action if already in reviewing phase
  if (intent.phase !== "reviewing") {
    ctx.ui.notify(
      `Cannot review: intent is in ${intent.phase} phase`,
      "warning",
    );
    return;
  }

  // Emit phase-changed event to trigger orchestrator, even though phase doesn't change
  // This allows re-running the review after manual fixes
  // The reviewer will run in the current session
  pi.events.emit("intent:phase-changed", {
    id: intentId,
    from: "reviewing",
    to: "reviewing",
  });

  ctx.ui.notify(`Starting review for "${intent.title}"...`, "info");
}
```

### Why This Works

Even though `reviewing → reviewing` is not a legal phase transition (according to `LEGAL_TRANSITIONS` in `store.ts`), we:

1. **Don't call `transitionPhase()`** - we only emit the event
2. **The orchestrator listens to the event** and doesn't validate transitions
3. **The phase doesn't actually change** in the store
4. **The orchestrator sees "to: reviewing"** and spawns/re-runs the reviewer
5. **The reviewer runs in the current session** - no session restart needed

This is intentional: we want to trigger the orchestrator's review logic without modifying the intent's actual phase state or disrupting the user's session.

### Why No Session Restart?

Initially we tried calling `ctx.newSession()` to give a fresh view, but this caused a **race condition**:

- Event emitted → orchestrator starts spawning agent
- `newSession()` called → old session shuts down
- Agent spawn fails because session is gone

The solution: let the reviewer run in the **existing session**. This also has benefits:

- ✅ No disruptive UI freeze/restart
- ✅ Reviewer appears immediately in the chat
- ✅ You can see the review happening in real-time
- ✅ Less jarring user experience

## Files Modified

1. **extensions/intent/overlay.ts**:
   - Added `review` to `OverlayAction` type
   - Added "Review" to actions menu for `reviewing` phase
   - Updated `executeAction()` to handle "Review" action

2. **extensions/intent/index.ts**:
   - Created `handleReview()` function
   - Added handler dispatch in `showIntentOverlay()`

## Testing

- ✅ All 140 tests passing
- ✅ TypeScript compilation clean
- ✅ Ready for manual verification

## Usage

1. Make manual changes to files while in `reviewing` phase
2. Press `Ctrl+I` to open intent overlay
3. Press `a` to show actions menu
4. Select "Review" and press Enter
5. Reviewer starts working in the current session (no restart)
6. Reviewer checks your changes and you see it happen live

## Benefits

- **Immediate feedback** after manual fixes
- **No phase transitions** needed (stays in reviewing)
- **Preserves review context** (doesn't bounce back to implementing)
- **Works with orchestrator** naturally through event system
- **No session disruption** - reviewer appears in current chat
- **Live progress** - watch the reviewer work in real-time
