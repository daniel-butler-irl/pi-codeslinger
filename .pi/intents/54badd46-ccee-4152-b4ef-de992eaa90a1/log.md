## [2026-04-22T12:40:00.000Z] decision

Approach: Implement auto-injection using pi.sendMessage() with display:false and hook into session lifecycle events.

Implementation strategy:
1. Track injection state (intentId, phase, contractUpdatedAt, understandingMtime) to detect when re-injection needed
2. Inject context on session_start when active intent exists
3. Use before_agent_start hook to check and re-inject if changes detected
4. Monitor context event to detect when intent-context message is not in last 20 messages
5. Listen to intent events (phase-changed, updated, active-changed) to trigger re-injection
6. Hook update_understanding tool to trigger re-injection after updates

Message format uses customType: "intent-context" with display: false to stay invisible in UI while providing background context to the AI.

Rationale:
- before_agent_start is the ideal injection point as it runs right before LLM calls
- context event allows us to detect message distance without maintaining complex state
- Clearing lastInjection state when not in last 20 messages ensures before_agent_start will re-inject
- Using deliverAs: "nextTurn" ensures messages queue properly without triggering turns
- Tracking file mtime for understanding.md catches external edits

## [2026-04-22T12:45:00.000Z] discovery

Implementation complete. Key discoveries during implementation:

1. The `context` event provides `AgentMessage` objects, not session entries with IDs. To track message distance, we check if our customType exists in the last 20 messages.

2. Cannot modify messages during `context` event - it's for filtering/returning modified list. The `before_agent_start` hook is the proper injection point.

3. Clearing `lastInjection` state when intent-context not found in last 20 messages elegantly triggers re-injection without complex state management.

4. File mtime tracking for understanding.md catches both tool updates and external file edits.

5. Using `deliverAs: "nextTurn"` with `triggerTurn: false` ensures messages queue properly without interrupting the conversation flow.

Technical details:
- Used `require("fs")` not `import` to avoid async complications
- `setImmediate()` not needed - `before_agent_start` handles timing correctly
- customType "intent-context" makes messages easily identifiable for filtering

All 126 tests pass. Implementation ready for verification.

## [2026-04-22T12:50:00.000Z] verification

Automated verification complete:
✅ npm test -- extensions/intent/*.test.ts
   - 126 tests passed
   - 0 tests failed
   - No compilation errors
   - No runtime warnings

Implementation satisfies all success criteria:

1. ✅ Auto-injection on session start
   - Code: session_start event handler calls injectIntentContext()
   - Location: extensions/intent/index.ts:232-234

2. ✅ Dynamic refresh on changes
   - Phase changes: intent:phase-changed event listener (line 306)
   - Understanding updates: update_understanding tool (line 392)
   - Contract edits: intent:updated event listener (line 310)

3. ✅ Context maintenance
   - context event checks last 20 messages (lines 288-300)
   - before_agent_start re-injects when needed (lines 282-286)

4. ✅ Metadata included
   - Lines 111-117: ID, title, phase, rework count, timestamp
   - Lines 120-126: Contract content
   - Lines 128-130: Understanding content (if exists)

5. ✅ No visible clutter
   - Line 138: display: false in pi.sendMessage call

6. ✅ AI can reference without tools
   - Messages injected with customType: "intent-context"
   - Available in conversation context for AI to read

7. ✅ Existing tests pass
   - All 126 tests pass without modification

8. ✅ No startup errors
   - Tests run cleanly, no warnings in output

Ready for manual verification and review.
