# Workflow Visualization Feature

## Overview

The Intent sidebar now displays a **workflow progress indicator** that shows where you are in the intent lifecycle and what comes next.

## What's New

The sidebar now displays three key workflow elements:

1. **Visual Flow Indicator**: Shows the three main phases with the current phase highlighted
   - Format: `defining → [IMPLEMENTING] → reviewing`
   - Current phase is shown in brackets and uppercase
   - Wraps to multiple lines on narrow screens

2. **Progress Percentage**: Calculates how far through the workflow you are
   - Defining: 25%
   - Implementing: 50%
   - Reviewing: 75%
   - Done: 100%

3. **Next Action**: Shows what needs to happen to advance
   - Defining: "Lock intent to start"
   - Implementing: "Submit for review"
   - Reviewing: "Accept or rework"
   - Done: "Complete"

## Example Sidebar Views

### Defining Phase

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [DEFINING]         │
│                    │
│ [DEFINING] →       │
│ implementing →     │
│ reviewing          │
│ Progress: 25%      │
│ Next: Lock intent  │
│       to start     │
│                    │
│ Add JWT rotation   │
│ middleware...      │
╰────────────────────╯
```

### Implementing Phase

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
│                    │
│ ─ Understanding ─  │
│ Problem: Add JWT   │
│ Next: Create...    │
╰────────────────────╯
```

### Reviewing Phase

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [REVIEWING]        │
│                    │
│ defining →         │
│ implementing →     │
│ [REVIEWING]        │
│ Progress: 75%      │
│ Next: Accept or    │
│       rework       │
│                    │
│ Add rotation...    │
╰────────────────────╯
```

### Done

```
╭─ Intent ───────────╮
│ Fix JWT rotation   │
│ [DONE]             │
│                    │
│ ✓ Complete         │
│                    │
│ Add rotation...    │
╰────────────────────╯
```

## Implementation Details

### New Functions in `panel.ts`

- `getWorkflowProgress(phase)`: Calculates percentage based on phase
- `getNextActions(phase)`: Returns next available actions for each phase
- `renderWorkflowIndicator(width, phase)`: Renders the visual flow

### Phase Mapping

The workflow only displays for the three main phases:

- `defining`, `implementing`, `reviewing`

Special phases are handled differently:

- `blocked-on-child`: Workflow indicator is hidden
- `done`: Shows checkmark instead of workflow

### Progress Calculation

Progress is based on position in the linear workflow:

```typescript
const WORKFLOW_PHASES = ["defining", "implementing", "reviewing"];
progress = ((currentIndex + 1) / (totalPhases + 1)) * 100;
```

This gives us:

- Defining: (0+1)/(3+1) = 25%
- Implementing: (1+1)/(3+1) = 50%
- Reviewing: (2+1)/(3+1) = 75%
- Done: 100%

## Benefits

1. **Clear Context**: Users always know where they are in the process
2. **Predictable Flow**: The linear progression is explicit
3. **Next Steps**: No guessing what to do next
4. **Progress Visibility**: See how close you are to completion
5. **Minimal Space**: Compact design fits in existing sidebar

## Testing

All existing tests pass (126 tests, 0 failures). The new rendering logic is integrated into the existing panel component and doesn't break any existing functionality.
