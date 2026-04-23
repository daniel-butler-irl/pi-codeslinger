# Terse Extension

Reduces agent output tokens by 60-75% using caveman-inspired compression rules while maintaining technical accuracy.

## Purpose

Models tend to generate verbose outputs with unnecessary pleasantries, filler words, and repetitive explanations. This wastes tokens and slows responses. Terse mode compresses agent responses by:

- Dropping articles (a/an/the)
- Removing filler words (just/really/basically/actually/simply)
- Eliminating pleasantries (sure/certainly/of course/happy to)
- Removing hedging (might be worth/you could consider)
- Using fragments instead of full sentences
- Preferring short synonyms (use not utilize, fix not "implement a solution for")

**Technical accuracy preserved:** Code blocks, file paths, URLs, commands, and technical terms remain exact.

## Activation

**Default:** Terse mode is **enabled by default**. All agent responses are compressed automatically.

**Toggle:** Press `Alt+T` to toggle terse mode on/off for the current session. When disabled, agents respond in normal verbose style.

**Commands:**

- `/terse` - Show current status (enabled/disabled)
- `/terse:off` - Disable terse mode (agents respond verbosely)
- `/terse:on` - Re-enable terse mode (agents respond tersely)

## Compression Rules

### What Gets Removed

- Articles: a, an, the
- Filler: just, really, basically, actually, simply, essentially, generally
- Pleasantries: "sure", "certainly", "of course", "happy to", "I'd recommend"
- Hedging: "it might be worth", "you could consider", "it would be good to"

### What Gets Preserved

- Code blocks (`...`)
- Inline code (`...`)
- File paths (`src/auth/jwt.ts`)
- URLs and links
- Commands (`npm test`, `git commit`)
- Technical terms (exact names of libraries, APIs, protocols)
- Error messages (quoted exactly)

### Pattern

Terse responses follow: `[thing] [action] [reason]. [next step].`

## Examples

### Bad (Verbose)

> Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by your authentication middleware not properly validating the token expiry. Let me take a look and suggest a fix.

### Good (Terse)

> Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:

---

### Bad (Verbose)

> I have successfully added the JWT rotation middleware at the path src/auth/jwt.ts. All of the existing tests in the test suite continue to pass without any failures. Additionally, I have added new comprehensive tests in the file src/auth/**tests**/rotation.test.ts which cover both the expiry-within-grace case as well as the invalid-signature case.

### Good (Terse)

> Added JWT rotation middleware at src/auth/jwt.ts. Existing tests pass. New tests in src/auth/**tests**/rotation.test.ts cover expiry-within-grace and invalid-signature cases.

## File Write Prevention

Terse mode **intercepts and warns** when agents attempt to write summary files to the repository root. These files waste tokens because the information is already in the agent's context.

**How it works:** The extension hooks into `tool_call` events and checks for `write` operations to `.md` files in the repository root. When detected, it displays a warning and blocks the operation.

**Blocked patterns:**

- SUMMARY.md
- IMPLEMENTATION_SUMMARY.md
- SESSION_SUMMARY.md
- UNDERSTANDING.md
- NOTES.md
- WORKFLOW.md

**Allowed files:**

- README.md
- LICENSE.md
- CLAUDE.md
- CHANGELOG.md
- CONTRIBUTING.md
- package.json, tsconfig.json (config files)
- Files in .pi/intents/ (intent data)

**Alternative:** Use `update_understanding` tool or log entries instead of creating summary files.

## Auto-Clarity

Terse mode automatically disables for:

- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order could cause misunderstanding
- When user explicitly asks for clarification or repeats a question

After the critical section, terse mode resumes automatically.

### Example

```
**Warning:** This will permanently delete all intent data and cannot be undone.

rm -rf .pi/intents/

Terse resume. Verify backup exist first.
```

## Integration

### Orchestrator Agents

The orchestrator's agent definitions (intent-implementer.md, intent-reviewer.md) are modified to load the terse skill automatically. All agent responses, log entries, and understanding updates use terse style.

### Status Badge

The header extension displays `[TERSE]` badge when terse mode is active:

```
pi  ~/IdeaProjects/public/pi-codeslinger  (main)  [TERSE]
```

Toggle terse mode off (Alt+T or /terse:off) and the badge disappears. Agent responses immediately switch to normal verbose style.

### propose_done / report_review

Summaries in `propose_done` and `report_review` calls are compressed:

**Before:**

```typescript
propose_done({
  summary:
    "I have successfully implemented the JWT rotation middleware at src/auth/jwt.ts. All existing tests continue to pass, and I have added comprehensive new tests.",
  artifacts: ["src/auth/jwt.ts", "src/auth/__tests__/rotation.test.ts"],
});
```

**After:**

```typescript
propose_done({
  summary:
    "Implemented JWT rotation middleware at src/auth/jwt.ts. Existing tests pass. New tests added.",
  artifacts: ["src/auth/jwt.ts", "src/auth/__tests__/rotation.test.ts"],
});
```

## Testing

Run tests:

```bash
npm test -- extensions/terse
```

Verify structure:

```bash
test -f extensions/terse/index.ts
test -f extensions/terse/terse.SKILL.md
test -f extensions/terse/index.test.ts
test -f extensions/terse/README.md
```

## Token Savings

Expected savings: **60-75% reduction in output tokens**

- Log entries: ~70% reduction
- Agent responses: ~65% reduction
- propose_done summaries: ~60% reduction
- Understanding updates: ~70% reduction

Technical accuracy maintained at 100%.
