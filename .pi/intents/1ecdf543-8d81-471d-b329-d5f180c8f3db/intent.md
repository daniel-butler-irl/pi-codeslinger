# Intent

## Description
We need a new intent management overlay dialog box. It should run with a sub-agent independent of the current session. I should be able to create new intents without any of that going into the context of the current session. It should generate an intent title based on the description. I should be able to use it to switch intents. If I switch intent, I should automatically get a fresh session.

## Success Criteria

1. **Overlay invocation**: The existing `/intent` command opens a new overlay dialog (replacing current menu-based flow)

2. **Hotkey access**: A hotkey (to be defined, e.g., Ctrl+I) opens the intent management overlay from anywhere

3. **Create intent flow**: The overlay provides a form to enter an intent description, and when submitted (blur/enter), automatically generates a concise title using a separate AI instance that doesn't consume the main session's context

4. **No context pollution**: Creating an intent via the overlay does NOT switch the active intent, does NOT inject messages into the main chat, and does NOT increment the main session's message/token counts

5. **Switch intent with fresh session**: When switching to a different intent via the overlay, the current session terminates and a completely fresh session starts with the new intent active (no carry-over of conversation history)

6. **Overlay UI consistency**: The overlay uses Pi's TUI components (SelectList, Input, BorderedLoader, DynamicBorder) and matches the visual style of other Pi overlays

7. **Intent list display**: The overlay shows a list of existing intents with their titles, phases, and allows selection for switching

8. **Sub-agent isolation**: Title generation uses a sub-agent/separate AI call that operates independently—failures in title generation don't crash the main session, and the main session's token budget is unaffected

9. **Sidebar hint**: The intent sidebar displays a hint at the bottom showing the hotkey (e.g., "Ctrl+I to manage intents")

## Verification

### Automated Checks
```bash
# /intent command modified to show overlay
grep -q "ctx.ui.custom" extensions/intent/index.ts

# Hotkey registered
grep -q "registerKeybinding\|keybinding" extensions/intent/index.ts

# Sub-agent or isolated AI call for title generation
grep -q "separateAgent\|spawn\|fork" extensions/intent/*.ts

# Sidebar hint visible in panel
grep -q "Ctrl.*manage\|hotkey.*hint" extensions/intent/panel.ts

# Tests pass
npm test -- extensions/intent
```

### Manual Verification

**Test 1: Command opens overlay**
1. Run `/intent` in a session
2. Verify: Dialog overlay appears (not simple menu selection)
3. Close with Escape

**Test 2: Hotkey opens overlay**
1. Press the defined hotkey (e.g., Ctrl+I)
2. Verify: Same overlay appears without typing `/intent`
3. Close and verify main UI resumes

**Test 3: No context pollution**
1. Start a session, count messages in conversation
2. Open overlay via hotkey or `/intent`
3. Create a new intent with description "Test intent for verification"
4. Close the overlay without switching
5. Verify: Message count unchanged, new intent created but not active, no messages in history

**Test 4: Fresh session on switch**
1. Create or activate intent A, have a 5-message conversation
2. Open overlay, switch to intent B
3. Verify: Session restarts, conversation history cleared, intent B is now active, editor cleared
4. Send a message, verify no history from intent A context

**Test 5: Sub-agent isolation**
1. Open overlay, enter a long intent description
2. Let the title be generated (should show loading indicator)
3. Check main session token count—should not increase from title generation
4. Verify the generated title appears in overlay and is saved with the intent

**Test 6: UI consistency**
1. Open overlay
2. Verify: Uses Pi TUI components (borders, inputs, lists)
3. Test keyboard: arrow keys navigate, enter selects, escape cancels
4. Verify overlay positioning and sizing are appropriate

**Test 7: Intent list**
1. Create 3 intents via overlay
2. Re-open overlay
3. Verify: All 3 intents listed with titles and phases
4. Select one, verify correct intent becomes active

**Test 8: Sidebar hint**
1. With any intent active, view the intent sidebar
2. Verify: Bottom of sidebar shows hint text like "Ctrl+I to manage intents"
3. Press that hotkey and verify overlay opens
