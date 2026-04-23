# Workflow Visualization Examples

## Side-by-Side Comparison

### Before (just phase badge)

```
╭─ Intent ────────────╮
│ Fix JWT rotation    │
│ [IMPLEMENTING]      │
│                     │
│ Add JWT rotation... │
│                     │
│ ─ Understanding ─   │
│ Problem: Add JWT... │
╰─────────────────────╯
```

### After (with workflow indicator)

```
╭─ Intent ────────────╮
│ Fix JWT rotation    │
│ [IMPLEMENTING]      │
│                     │
│ defini → [IMPLEM]   │
│        → review     │
│ Progress: 50%       │
│ Next: Submit for    │
│       review        │
│                     │
│ Add JWT rotation... │
│                     │
│ ─ Understanding ─   │
│ Problem: Add JWT... │
╰─────────────────────╯
```

## Benefits at a Glance

| Aspect            | Before     | After                   |
| ----------------- | ---------- | ----------------------- |
| **Current phase** | Badge only | Badge + visual position |
| **What's next**   | Not shown  | Explicit next action    |
| **Progress**      | Not shown  | Percentage complete     |
| **Context**       | Implicit   | Explicit workflow flow  |

## Real-World Workflow

### 1. Just started (Defining)

```
╭─ Intent ────────────╮
│ Add user analytics  │
│ [DEFINING]          │
│                     │
│ [DEFINI] → implem   │
│          → review   │
│ Progress: 25%       │
│ Next: Lock intent   │
│       to start      │
│                     │
│ Track user events   │
│ and generate...     │
╰─────────────────────╯
```

**User sees**: "I'm at the beginning, need to lock the intent before implementation starts"

### 2. Midway (Implementing)

```
╭─ Intent ────────────╮
│ Add user analytics  │
│ [IMPLEMENTING]      │
│                     │
│ defini → [IMPLEM]   │
│        → review     │
│ Progress: 50%       │
│ Next: Submit for    │
│       review        │
│                     │
│ Track user events   │
│                     │
│ ─ Understanding ─   │
│ Created Analytics   │
│ service, adding     │
│ event tracking...   │
╰─────────────────────╯
```

**User sees**: "Halfway through, once done I need to submit for review"

### 3. Almost done (Reviewing)

```
╭─ Intent ────────────╮
│ Add user analytics  │
│ [REVIEWING]         │
│                     │
│ defini → implem →   │
│ [REVIEW]            │
│ Progress: 75%       │
│ Next: Accept or     │
│       rework        │
│                     │
│ Track user events   │
╰─────────────────────╯
```

**User sees**: "In review phase, 75% complete, waiting for accept/rework decision"

### 4. Complete (Done)

```
╭─ Intent ────────────╮
│ Add user analytics  │
│ [DONE]              │
│                     │
│ ✓ Complete          │
│                     │
│ Track user events   │
│ and generate...     │
╰─────────────────────╯
```

**User sees**: "All done! Clean completion marker"

## Design Principles

1. **Linear Flow**: The arrow notation (`→`) creates a clear left-to-right reading order
2. **Current Highlight**: Brackets make the current phase immediately obvious
3. **Compact**: Uses only 3-4 lines for workflow info, leaving room for description/understanding
4. **Actionable**: "Next" line tells you exactly what to do
5. **Quantified**: Progress percentage gives measurable sense of completion

## Technical Notes

- Workflow indicator only shows for main phases (defining, implementing, reviewing)
- `blocked-on-child` hides the workflow (since progression is blocked)
- `done` shows a simple checkmark instead of workflow
- Width adapts to sidebar size (minimum 24 columns)
- Text truncation ensures it works even in narrow terminals
