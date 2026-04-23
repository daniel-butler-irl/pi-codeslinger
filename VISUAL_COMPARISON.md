# Visual Comparison: Before vs After

## Scenario 1: Short Title, Implementing Phase

### Before

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [IMPLEMENTING]     │
│                    │
│ Add rotation...    │
╰────────────────────╯
```

### After

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [IMPLEMENTING]     │
│                    │
│ defining →         │
│ [IMPLEMENTING] →   │
│ reviewing          │
│ Progress: 50%      │
│ Next: Submit for   │
│       review       │
│                    │
│ Add rotation...    │
╰────────────────────╯
```

**What changed**: Added workflow indicator showing position and next steps.

---

## Scenario 2: Long Title with Wrapping

### Before (Truncated)

```
╭─ Intent ───────────╮
│ Implement compre...│ ← cut off!
│ [DEFINING]         │
│                    │
│ Create a system... │
╰────────────────────╯
```

### After (Word-Wrapped)

```
╭─ Intent ───────────╮
│ Implement          │
│ comprehensive user │
│ authentication     │
│ system             │
│ [DEFINING]         │
│                    │
│ [DEFINING] →       │
│ implementing →     │
│ reviewing          │
│ Progress: 25%      │
│ Next: Lock intent  │
│       to start     │
│                    │
│ Create a system    │
│ that handles...    │
╰────────────────────╯
```

**What changed**: Title wraps instead of truncating, workflow shows you're at the start.

---

## Scenario 3: Nested Intent with Breadcrumb

### Before (Truncated)

```
╭─ Intent ───────────╮
│ ↱ Complete user... │ ← parent truncated
│ Add email valida...│ ← title truncated
│ [IMPLEMENTING]     │
╰────────────────────╯
```

### After (Word-Wrapped)

```
╭─ Intent ───────────╮
│ ↱ Complete user    │
│   authentication   │
│   system           │
│ Add email          │
│ validation to      │
│ signup form        │
│ [IMPLEMENTING]     │
│                    │
│ defining →         │
│ [IMPLEMENTING] →   │
│ reviewing          │
│ Progress: 50%      │
│ Next: Submit for   │
│       review       │
╰────────────────────╯
```

**What changed**: Both breadcrumb and title wrap fully, workflow context added.

---

## Scenario 4: In Review Phase

### Before

```
╭─ Intent ───────────╮
│ Fix authentication │
│ [REVIEWING]        │
│                    │
│ Add JWT rotation...│
╰────────────────────╯
```

### After

```
╭─ Intent ───────────╮
│ Fix authentication │
│ [REVIEWING]        │
│                    │
│ defining →         │
│ implementing →     │
│ [REVIEWING]        │
│ Progress: 75%      │
│ Next: Accept or    │
│       rework       │
│                    │
│ Add JWT rotation...│
╰────────────────────╯
```

**What changed**: Shows you're near the end (75%), ready for accept/rework decision.

---

## Scenario 5: Complete (Done)

### Before

```
╭─ Intent ───────────╮
│ Fix authentication │
│ [DONE]             │
│                    │
│ Add JWT rotation...│
╰────────────────────╯
```

### After

```
╭─ Intent ───────────╮
│ Fix authentication │
│ [DONE]             │
│                    │
│ ✓ Complete         │
│                    │
│ Add JWT rotation...│
╰────────────────────╯
```

**What changed**: Simple checkmark confirms completion instead of workflow flow.

---

## Scenario 6: Narrow Sidebar (Minimum Width)

### Before (24 columns, truncated)

```
╭─ Intent ──────╮
│ Implement c...│
│ [IMPLEMENTI...│
│               │
│ Create a sy...│
╰───────────────╯
```

### After (24 columns, wrapped)

```
╭─ Intent ──────╮
│ Implement     │
│ comprehensive │
│ user auth     │
│ [IMPLEMENTING]│
│               │
│ defining →    │
│ [IMPLEMENTIN  │
│ G] →          │
│ reviewing     │
│ Progress: 50% │
│ Next: Submit  │
│ for review    │
│               │
│ Create a      │
│ system that   │
│ handles...    │
╰───────────────╯
```

**What changed**: Everything wraps gracefully, no information lost even at minimum width.

---

## Key Improvements Summary

| Feature                 | Before               | After                            |
| ----------------------- | -------------------- | -------------------------------- |
| **Workflow visibility** | Phase badge only     | Full flow with arrows            |
| **Progress tracking**   | Not shown            | Percentage (25%, 50%, 75%, 100%) |
| **Next steps**          | Not shown            | Explicit action required         |
| **Long titles**         | Truncated with "..." | Word-wrapped, fully visible      |
| **Breadcrumbs**         | Truncated            | Word-wrapped                     |
| **Actions**             | N/A                  | Word-wrapped                     |
| **Narrow terminals**    | Loss of information  | Graceful wrapping                |
| **Context**             | Implicit             | Explicit at all times            |
