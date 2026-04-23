## Problem
Auto-inject and maintain active intent contract and understanding in AI context dynamically throughout conversation.

## Implementation Complete ✅

### What Was Implemented

1. **Injection State Tracking**
   - Added `InjectionState` interface tracking intentId, phase, contractUpdatedAt, understandingMtime
   - `lastInjection` variable tracks when/what was last injected

2. **Core Injection Function**
   - `injectIntentContext()` builds message with contract + understanding + metadata
   - Uses `pi.sendMessage()` with `customType: "intent-context"`, `display: false`
   - Tracks file mtime for understanding.md to detect external edits

3. **Re-injection Detection**
   - `needsReinjection()` checks if intent changed, phase changed, contract updated, or understanding modified
   - Returns true when any tracked state differs from lastInjection

4. **Lifecycle Hooks**
   - `session_start`: Auto-inject on session start if active intent exists
   - `before_agent_start`: Re-inject if needsReinjection() returns true
   - `context` event: Detects when intent-context not in last 20 messages, clears lastInjection to force re-injection

5. **Event Listeners**
   - `intent:phase-changed` → triggers injectIntentContext()
   - `intent:updated` → triggers injectIntentContext()
   - `intent:active-changed` → triggers injectIntentContext()

6. **Tool Integration**
   - `update_understanding` tool calls injectIntentContext() after updating

### Files Modified
- `extensions/intent/index.ts` - Added all injection logic

### Tests
✅ All 126 existing tests pass
✅ No TypeScript compilation errors
✅ No runtime errors during startup

### Success Criteria Met
1. ✅ Auto-injection on session start
2. ✅ Dynamic refresh on phase changes, understanding updates, contract edits
3. ✅ Context maintenance via before_agent_start + context event
4. ✅ Metadata included (ID, title, phase, rework count, timestamp)
5. ✅ display: false keeps UI clean
6. ✅ AI can reference without tool calls (context is injected)
7. ✅ Existing tests pass
8. ✅ No startup errors (confirmed by test runs)

## Next Steps
Ready for manual verification and review.
