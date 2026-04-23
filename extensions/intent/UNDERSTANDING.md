# Session Understanding Feature

## Overview

The Intent extension now includes a **Session Understanding** section that tracks the model's current understanding of the problem, next steps, and open questions. This understanding:

- **Persists across sessions** - saved to `.pi/intents/<id>/understanding.md`
- **Displays in the sidebar** - visible alongside the intent title and description
- **Updates dynamically** - the model can update it as understanding evolves
- **Acts as durable memory** - helps maintain context across session restarts

## File Structure

Each intent now has three core files:

```
.pi/intents/<intent-id>/
├── intent.md          # The locked contract (immutable outside defining phase)
├── understanding.md   # Current session understanding (updateable)
├── log.md            # Append-only journal of discoveries and decisions
└── verification.json # Cached verification results
```

## Tool: `update_understanding`

The model can use the `update_understanding` tool to record its current understanding:

```typescript
{
  understanding: `
Problem: Add JWT rotation middleware per intent contract

Current state: Found existing auth at src/auth/, UserService handles
rates, no JWT code exists yet.

Next steps:
1. Create src/auth/jwt.ts with rotation middleware
2. Add tests in src/auth/__tests__/rotation.test.ts
3. Wire into app.ts router

Open questions: None yet
  `;
}
```

## Event: `intent:active-on-start`

When a session starts with an active intent, the extension emits an `intent:active-on-start` event:

```typescript
{
  id: string,
  title: string,
  phase: IntentPhase,
  contractPath: string,
  understandingPath: string
}
```

This signals to the agent that it should read the existing understanding and potentially update it.

## Skill Integration

The understanding feature is integrated into all three skills:

### defining-intent

Records clarifications needed, decisions made, and which sections still need work.

### implementing-against-intent

Records problem understanding from the contract, current code state, next steps, and open questions.

### adversarial-review

Records what's being reviewed, verification status, key areas to inspect, and findings.

## Sidebar Display

The understanding appears in the Intent sidebar below the workflow indicator:

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [IMPLEMENTING]     │
│                    │
│ defini → [IMPLEM]  │
│        → review    │
│ Progress: 50%      │
│ Next: Submit for   │
│       review       │
│                    │
│ Add rotation...    │
│                    │
│ ─ Understanding ─  │
│ Problem: Add JWT   │
│ rotation...        │
│                    │
│ Next steps:        │
│ 1. Create jwt.ts   │
╰────────────────────╯
```

The workflow indicator shows:

- **Visual flow**: The three main phases (define → implement → review)
- **Current phase**: Highlighted in brackets (e.g., `[IMPLEM]`)
- **Progress**: Percentage through the workflow
- **Next action**: What needs to happen to advance

## Best Practices

### Update at Session Start

When an intent is active at session start, immediately read and optionally update the understanding to establish context.

### Update on Major Progress

When completing a significant step or making a key discovery, update the understanding to reflect the new state.

### Keep it Concise

The sidebar has limited space (≤8 lines). Keep the understanding focused on:

- **Problem**: One-line summary
- **Next steps**: Concrete actions (numbered list)
- **Open questions**: Specific blockers

### Don't Duplicate the Log

The understanding is a snapshot of "now". The log is a timeline of "what happened". Put decisions and discoveries in the log, current state in understanding.
