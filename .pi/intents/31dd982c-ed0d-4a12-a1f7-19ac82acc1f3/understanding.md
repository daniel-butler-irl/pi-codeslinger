Reviewing: intent-management tool exposure across main session, QQ side session, and orchestrator subagents, plus repo-root AGENTS.md guidance.

Verification: FAILED for current proposal. `verification.json` at `2026-04-29T09:40:32.541Z` shows `pre-commit run --all-files` exited 1 after fixing `.pi/intents.json`.

Inspected:
- `verification.json`
- `extensions/intent/store.ts`
- `extensions/intent/store.test.ts`
- `extensions/intent/index.ts`
- `extensions/intent/index.test.ts`
- `extensions/orchestrator/protocol-tools.ts`
- `extensions/orchestrator/protocol-tools.test.ts`
- `extensions/qq/index.ts`
- `extensions/qq/index.test.ts`
- `AGENTS.md`
- Intent log chronology

Findings:
1. Latest proposal still lacks passing recorded verification evidence. Even though the on-disk newline fix looks correct and tests are stronger, the artifact for this proposal remains failed, so success criterion 6 is not yet satisfied in reviewable evidence.
