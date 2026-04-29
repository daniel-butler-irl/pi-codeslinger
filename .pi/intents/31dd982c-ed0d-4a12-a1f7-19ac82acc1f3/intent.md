# Intent

## Description
Expose intent management as first-class tools so assistants can inspect and change intent state directly from main sessions, QQ side sessions, and orchestrated subagents instead of relying on Python scripts, manual path construction, or direct file editing workarounds. Also add repo-root `AGENTS.md` contributor guidance for extension development stating that new tools should also be exposed programmatically where applicable; this file is for implementers working on the extension, not end users.

## Success Criteria
1. `extensions/intent/index.ts` registers main-session tools `read_intent`, `list_intents`, `read_intent_log`, `read_intent_understanding`, `read_verification_results`, and `switch_intent`.
2. `extensions/orchestrator/protocol-tools.ts` exposes `read_intent`, `list_intents`, `read_intent_log`, `read_intent_understanding`, and `read_verification_results` in subagent tool sets, and each `read_*` tool reads data for `flight.intentId`.
3. `extensions/qq/index.ts` exposes side-session intent tools `create_intent`, `update_understanding`, `read_intent`, `list_intents`, `read_intent_log`, `read_intent_understanding`, `read_verification_results`, `switch_intent`, `lock_intent`, and `delete_intent`.
4. `list_intents` supports `all`, `active`, `done`, and `children` filters in main-session and QQ implementations, and `switch_intent` returns an error for unknown IDs instead of mutating store state.
5. Automated tests cover subagent tool availability and QQ intent create/switch flows.
6. Repository passes project quality gates with no failures: `pre-commit run --all-files`, `npm test`, and `npm run typecheck`.
7. Repo-root `AGENTS.md` exists and states that when extension contributors add new tools, they should also add programmatic access where applicable; the guidance is written for extension implementers, not end users.

## Verification
```bash
npm ci

pre-commit run --all-files

test -f AGENTS.md
rg -n 'programmatic|new tools|implementers|end users|not end users' AGENTS.md

rg -n 'name: "read_intent"|name: "list_intents"|name: "read_intent_log"|name: "read_intent_understanding"|name: "read_verification_results"|name: "switch_intent"' extensions/intent/index.ts

rg -n 'name: "read_intent"|name: "list_intents"|name: "read_intent_log"|name: "read_intent_understanding"|name: "read_verification_results"' extensions/orchestrator/protocol-tools.ts

rg -n 'flight\.intentId|name: "read_intent"|name: "list_intents"|name: "read_intent_log"|name: "read_intent_understanding"|name: "read_verification_results"' extensions/orchestrator/protocol-tools.ts

rg -n 'name: "create_intent"|name: "update_understanding"|name: "read_intent"|name: "list_intents"|name: "read_intent_log"|name: "read_intent_understanding"|name: "read_verification_results"|name: "switch_intent"|name: "lock_intent"|name: "delete_intent"' extensions/qq/index.ts

rg -n 'Type\.Literal\("all"\)|Type\.Literal\("active"\)|Type\.Literal\("done"\)|Type\.Literal\("children"\)|No intent found with ID' extensions/intent/index.ts extensions/qq/index.ts

node --experimental-strip-types --test extensions/orchestrator/protocol-tools.test.ts

node --experimental-strip-types --test extensions/qq/index.test.ts --test-name-pattern 'qq intent tools can create and switch intents from the side session|/qq with a prompt creates a separate in-memory side session with repo tools plus intent tools'

npm test
npm run typecheck
```
