# Intent

## Description
GTFO extension that monitors tokens and tries to wrap things up and create a handover document if nessisary

## Success Criteria

1. Extension registers `/gtfo:handover`, `/gtfo:enable`, `/gtfo:model`, `/gtfo:threshold` commands
2. Extension registers `Alt+G` shortcut
3. Extension monitors token usage on `turn_end` events
4. When token threshold reached, extension triggers LLM assessment of task completion
5. Assessment offers user choice: continue, create handover, or disable
6. Handover command generates markdown document with structured sections
7. Handover command switches to new session with handover content injected
8. Extension state persists across session restarts
9. All extension tests pass

## Verification

```bash
# Run GTFO extension tests
cd extensions/gtfo && npm test

# Verify extension files exist
ls -la extensions/gtfo/index.ts extensions/gtfo/index.test.ts
```
