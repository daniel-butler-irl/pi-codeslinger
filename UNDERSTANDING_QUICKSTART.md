# Quick Start: Using Session Understanding

## When to Update Understanding

### At Session Start (with Active Intent)

When you receive an `intent:active-on-start` event:

1. Read the existing understanding if it exists
2. Read the intent contract
3. Update understanding with your assessment

### During Work

Update when:

- You make significant progress
- You discover something important
- Your plan changes
- You identify a blocker

### Before Proposing Done

Update to reflect completion state and any follow-up needed.

## Understanding Format

Keep it **concise** (sidebar shows max 8 lines). Use this structure:

```markdown
Problem: [One line summary from contract]

Current state: [What you've learned by examining code/context]

Next steps:

1. [Specific concrete action]
2. [Another specific action]
3. [...]

Open questions:

- [Specific blocker or unclear requirement]
```

## Tool Call Example

```typescript
await tools.update_understanding({
  understanding: `Problem: Add JWT rotation middleware per contract

Current state: Found existing auth in src/auth/, no JWT code exists yet,
UserService already handles rate limiting

Next steps:
1. Create src/auth/jwt.ts with rotation logic
2. Add tests in src/auth/__tests__/rotation.test.ts
3. Wire middleware into app.ts router
4. Run verification commands

Open questions: None`,
});
```

## Good vs Bad Understanding

### ❌ Too Vague

```
Working on auth stuff. Need to add some features.
```

### ❌ Too Detailed

```
Problem: Add JWT rotation middleware...

I examined the entire codebase structure starting from the root...
[20 more lines of analysis]
```

### ✅ Just Right

```
Problem: Add JWT rotation middleware

Current: src/auth/ exists, no JWT code yet

Next steps:
1. Create jwt.ts with rotation logic
2. Add rotation.test.ts
3. Wire into app.ts

Open questions: None
```

## Integration with Log

- **Understanding**: Current snapshot - where you are NOW
- **Log**: Historical timeline - decisions and discoveries over time

Don't duplicate. Use both:

- Put decisions in the log: "Decision: use existing middleware pattern"
- Put current state in understanding: "Next steps: 1. Wire middleware..."

## Skill-Specific Examples

### During Defining

```
Problem: User wants JWT auth but requirements unclear

Clarifications needed:
- Why JWT vs session tokens?
- Which tests should pass?
- Compliance requirement details?

Next: Refine Description and Success Criteria
```

### During Implementing

```
Problem: Add JWT rotation per contract

Current: Created jwt.ts, tests passing locally

Next steps:
1. Run full verification suite
2. Address any failures
3. Call propose_done

Open questions: None
```

### During Review

```
Reviewing: JWT rotation implementation

Verification: PASSED

Inspecting: jwt.ts rotation logic, test coverage, error handling

Findings:
1. Hard-coded token at jwt.ts:45
2. Missing expired token test case
```

## Command Access

Read the understanding file directly:

```bash
cat .pi/intents/<id>/understanding.md
```

Or it's visible in the Intent sidebar automatically.
