# Intent

## Description
Create a "terse" extension that reduces agent output tokens by 60-75% using caveman-inspired compression rules while maintaining technical accuracy. The extension must prevent agents from generating unnecessary summary files to the repository root and enforce terse communication style by default. This reduces token costs and speeds up agent responses without sacrificing code quality or correctness.

## Success Criteria

1. **Extension structure**: A new extension at `extensions/terse/` exists with `index.ts`, `terse.SKILL.md`, and test files following the pattern of existing extensions (qq, intent)

2. **Terse skill file**: `extensions/terse/terse.SKILL.md` defines compression rules that:
   - Drop articles (a/an/the), filler words (just/really/basically/actually/simply), pleasantries (sure/certainly/happy to), and hedging
   - Use fragments and short synonyms
   - Preserve all technical terms, code blocks, URLs, file paths, and commands exactly
   - Apply pattern: `[thing] [action] [reason]. [next step].`
   - Maintain auto-clarity rules for security warnings and destructive operations

3. **Default activation**: The extension modifies the system prompt for all agent sessions (implementing-against-intent, adversarial-review) to include the terse skill by default, without requiring `/terse` command

4. **Hotkey toggle**: Ctrl+T hotkey registered that toggles terse mode on/off for the current session, displaying a notification of the current state

5. **Command interface**: `/terse` command exists with subcommands:
   - `/terse` - show current status (enabled/disabled)
   - `/terse:off` - disable terse mode for current session
   - `/terse:on` - re-enable terse mode for current session

6. **File write prevention**: The extension intercepts or warns when agents attempt to write markdown files to repository root (excluding README.md, LICENSE.md, CLAUDE.md, and files in .pi/intents/), suggesting use of understanding tool or log entries instead

7. **Agent integration**: The orchestrator's agent definitions (intent-implementer.md, intent-reviewer.md) are modified to load the terse skill, and propose_done/report_review responses are compressed

8. **Status indicator**: When terse mode is active, the header extension or similar displays "[TERSE]" badge in the UI

9. **No quality regression**: Existing tests continue to pass (npm test), including all 148+ tests for extensions/intent, extensions/orchestrator, extensions/qq

10. **Documented**: Extension includes a README.md explaining the compression rules, toggle commands, and integration points with examples

## Verification

### Automated Checks

```bash
# Extension files exist with correct structure
test -f extensions/terse/index.ts
test -f extensions/terse/terse.SKILL.md
test -f extensions/terse/index.test.ts
test -f extensions/terse/README.md

# Terse skill is referenced in orchestrator agent definitions
grep -q "terse" extensions/orchestrator/agents/intent-implementer.md
grep -q "terse" extensions/orchestrator/agents/intent-reviewer.md

# Hotkey is registered
grep -q "ctrl+t\|Ctrl+T" extensions/terse/index.ts

# Command is registered
grep -q 'registerCommand.*"terse"' extensions/terse/index.ts

# System prompt modification exists
grep -q "appendSystemPrompt\|terse" extensions/terse/index.ts

# All tests pass
npm test

# TypeScript compiles
npm run build
```

### Manual Verification

**Test 1: Default terse mode active**
1. Start a fresh session with any intent
2. Ask a question or observe agent output
3. Verify: Agent responses are compressed (no articles, fragments OK, no pleasantries)
4. Check: No verbose summaries or unnecessary elaboration

**Test 2: Hotkey toggle**
1. Start session, verify terse mode active
2. Press Ctrl+T
3. Verify: Notification shows "Terse mode disabled"
4. Ask a question
5. Verify: Agent responds in normal verbose style
6. Press Ctrl+T again
7. Verify: Notification shows "Terse mode enabled"
8. Ask another question
9. Verify: Agent responds tersely again

**Test 3: Command interface**
1. Run `/terse` with no subcommand
2. Verify: Shows current status (enabled/disabled)
3. Run `/terse:off`
4. Verify: Notification confirms disabled, next response is verbose
5. Run `/terse:on`
6. Verify: Notification confirms enabled, next response is terse

**Test 4: File write prevention**
1. With terse mode active, ask agent to "create a summary document"
2. Verify: Agent either refuses and suggests using understanding tool, or warns before writing
3. Verify: No new .md files appear in repository root (excluding allowed files)

**Test 5: propose_done compression**
1. Complete an intent implementation
2. Agent calls propose_done
3. Verify: Summary field is terse (compare token count to normal mode - should be 60-75% less)
4. Verify: Technical accuracy maintained (all artifacts listed, key changes described)

**Test 6: Status indicator**
1. With terse mode enabled
2. Check UI header or status bar
3. Verify: "[TERSE]" badge visible
4. Toggle off with Ctrl+T
5. Verify: Badge disappears or changes to "[VERBOSE]"

**Test 7: No quality regression**
1. Run full test suite: `npm test`
2. Verify: All tests pass (≥148 tests)
3. Verify: No regressions in intent, orchestrator, or qq functionality

**Test 8: Agent integration**
1. Lock an intent and let agent implement
2. Observe agent's decision logs, discoveries, and understanding updates
3. Verify: All are written in terse style
4. Verify: Technical content preserved (specific file paths, function names, line numbers)
