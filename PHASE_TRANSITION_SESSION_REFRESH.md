# Phase Transition Session Refresh Fix

## Problem

When submitting an intent for review (or transitioning to any agent-driven phase), the system would:

1. ✅ Correctly transition the phase (e.g., `implementing` → `reviewing`)
2. ✅ Trigger the orchestrator to spawn the appropriate agent (reviewer)
3. ❌ **Leave you in the old chat session** - you couldn't see what the agent was doing
4. ❌ When the agent finished, it would dump you back to chat with no visibility

**Result**: The review process felt like it was "hanging" because the reviewer agent was working invisibly in the background while you stared at your old conversation.

## Root Cause

The `handleTransition()` function in `extensions/intent/index.ts` was **not calling `ctx.newSession()`** when transitioning phases. This meant:

- ✅ Switching intents → fresh session (already worked)
- ❌ Transitioning phases → same session (broken)

## Solution

Modified three handler functions to start fresh sessions when an agent is taking over:

### 1. `handleLock()` (defining → implementing)

```typescript
// Start fresh session if this is the active intent (implementer agent will take over)
if (isActiveIntent && "newSession" in ctx) {
  await ctx.newSession();
}
```

### 2. `handleTransition()` (any phase transition)

```typescript
// Start fresh session if transitioning to a phase where an agent takes over
// (implementing or reviewing) and this is the active intent
if (
  isActiveIntent &&
  (toPhase === "implementing" || toPhase === "reviewing") &&
  "newSession" in ctx
) {
  await ctx.newSession();
}
```

### 3. Switch intent handler (already worked, now consistent)

```typescript
// Start a fresh session with the new intent active (if we have command context)
if ("newSession" in ctx) {
  await ctx.newSession();
}
```

## Key Design Decisions

1. **Check `'newSession' in ctx`**: The overlay can be invoked from both commands (ExtensionCommandContext) and hotkeys (ExtensionContext). Only command contexts support `newSession()`.

2. **Only for active intent**: We only refresh the session if the transitioned intent is currently active. If you transition a different intent's phase from the overlay, your session stays as-is.

3. **Only for agent-driven phases**: We refresh on transitions to `implementing` or `reviewing` where an orchestrator agent will take control. Transitions to `done` or `defining` don't need a refresh since no agent is spawning.

## Additional Fixes

While fixing the main issue, also resolved:

1. **Type errors in overlay.ts**:
   - Fixed `pageup`/`pagedown` → `pageUp`/`pageDown` (camelCase)
   - Added type assertion for `DetailState.intentId` access

2. **Consistent function signatures**: All handlers now accept `ExtensionCommandContext | ExtensionContext`

## Testing

- ✅ All 140 tests passing
- ✅ Type checking passes
- ✅ Ready for manual verification

## Expected Behavior After Fix

**Before:**

1. Open overlay, submit for review
2. Overlay closes → back to old chat
3. ??? (reviewer working invisibly)
4. Eventually dumps back to chat when done

**After:**

1. Open overlay, submit for review
2. Overlay closes → **fresh session starts**
3. You see the reviewer agent working
4. Session naturally shows agent's progress and completion

## Manual Verification Steps

1. Create an intent, lock it (should see fresh session with implementer)
2. When implementer calls `propose_done`, submit for review (should see fresh session with reviewer)
3. Verify you can see the reviewer's work in real-time
4. When reviewer completes, verify smooth transition to next phase

## Files Modified

- `extensions/intent/index.ts` - Added `newSession()` calls to transition handlers
- `extensions/intent/overlay.ts` - Fixed type errors (pageUp/pageDown, DetailState)
