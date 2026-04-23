# Intent

## Description
Automatically inject and maintain the active intent contract and understanding in the AI assistant context throughout the conversation, eliminating unnecessary `read_intent` and `read_intent_understanding` tool calls.

## Success Criteria

1. **Auto-injection on session start**: When a session starts with an active intent, the intent contract and understanding (if it exists) are automatically injected into the AI context before the first user prompt is processed.

2. **Dynamic refresh on changes**: Intent context is re-injected whenever:
   - Intent phase changes (defining → implementing → reviewing → done)
   - Understanding is updated via `update_understanding` tool
   - Intent contract is edited (during defining phase)

3. **Context maintenance**: Intent context is re-injected when it's not present in the last 20 messages or when the intent has changed since last injection.

4. **Metadata included**: Injected context includes:
   - Intent contract (Description, Success Criteria, Verification)
   - Understanding content (if file exists)
   - Metadata: current phase, rework count, last updated timestamp
   - Intent ID and title

5. **No visible clutter**: Injected messages use `display: false` to keep the chat UI clean while providing background context.

6. **AI can reference without tools**: AI can answer questions about the current intent ("What is the current intent?", "What are the success criteria?") without calling `read_intent` or `read_intent_understanding` tools.

7. **Existing tests pass**: All intent extension tests pass: `npm test -- extensions/intent/`

8. **No startup errors**: No errors or warnings logged during session startup when an active intent exists.

## Verification

```bash
# Automated test suite must pass
npm test -- extensions/intent/

# Manual test 1: Session start auto-injection
# 1. Create and lock an intent with Success Criteria
# 2. Exit and restart pi in the same directory
# 3. In the new session, ask: "What is the current intent?"
# 4. Verify: AI responds with intent details without calling read_intent
# 5. Check terminal: No errors during startup

# Manual test 2: Dynamic refresh on understanding update
# 1. With active intent, ask AI to update understanding
# 2. Then ask: "What does the understanding say?"
# 3. Verify: AI has the updated understanding without calling read_intent_understanding

# Manual test 3: Re-injection after 20+ messages
# 1. With active intent, have a long conversation (25+ messages)
# 2. Ask: "What is the current intent?"
# 3. Verify: AI still knows the intent (context was re-injected)

# Manual test 4: Phase change refresh
# 1. Create intent in defining phase
# 2. Ask AI about the intent (should know it)
# 3. Lock the intent (phase → implementing)
# 4. Ask AI: "What phase is the intent in?"
# 5. Verify: AI knows the phase changed to implementing

# Verification checks:
# - No read_intent or read_intent_understanding calls in any test
# - Intent context messages have display: false (not visible in UI)
# - Metadata (phase, rework count) is present in injected context
# - npm test passes without errors
```
