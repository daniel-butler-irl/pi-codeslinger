---
name: implementing-against-intent
description: Use when implementing code changes against a locked intent contract.
---

# Implementing against a locked intent

The intent contract is frozen. Your job is to make the code match the
contract — not to edit the contract to match the code.

Attempting to write to the intent's `intent.md` file will be blocked by
the extension with a clear error. If you believe the contract is wrong,
stop and call `ask_orchestrator` with the specific conflict — do not
try to work around the lock.

> **If a tool refuses an edit to `intent.md` (lock-edit guard), do NOT
> investigate `store.ts`, `paths.ts`, or `worktree-manager.ts` to find a
> bypass.** The guard is correct. Call `ask_orchestrator` with the specific
> conflict and wait.

## Tools available in this phase

| Tool | When to call |
| --- | --- |
| `read_intent` | Read the locked contract before doing anything else, and any time you need to re-check a criterion. |
| `read_intent_log` | Read prior decisions/discoveries from earlier sessions on this intent. |
| `read_verification_results` | Inspect the latest verification.json (pass/fail per command). |
| `update_understanding` | Sidebar memory — record problem, current state, next steps, open questions. Update as your understanding evolves. |
| `propose_done` | Submit work for adversarial review. Requires verification passing and concrete artefacts. |
| `ask_orchestrator` | Use when the contract conflicts with reality, or when blocked. Do not guess — ask. |
| `spawn_child_intent` | Use when you discover a prerequisite that must be its own contract before this one can finish. |

## Session Understanding

When you start a session with an active intent, you will receive an
`intent:active-on-start` event. **Immediately** use the `update_understanding`
tool to record your understanding of:

1. **Problem**: What needs to be done (read from the contract)
2. **Current state**: What you learned by examining the code
3. **Next steps**: Concrete actions you plan to take
4. **Open questions**: Anything unclear that needs clarification

This understanding persists across sessions and appears in the Intent
sidebar. Update it whenever your understanding evolves or you make
significant progress. This is your durable memory — use it.

Example:

```
Problem: Add JWT rotation middleware per intent contract

Current state: Found existing auth at src/auth/, UserService handles
rates, no JWT code exists yet.

Next steps:
1. Create src/auth/jwt.ts with rotation middleware
2. Add tests in src/auth/__tests__/rotation.test.ts
3. Wire into app.ts router

Open questions: None yet
```

## Workflow

### 1. Read the contract fully

Before writing any code, read the entire `intent.md`. Note every
success criterion. Note every verification command. You will be judged
by the adversarial reviewer against these exact items.

### 2. Plan in the log

Append a `decision` entry to `log.md` stating your planned approach.
This is not optional. The log is how a fresh session (after compaction
or a crash) understands what you were doing.

A decision entry looks like:

```
## [timestamp] decision

Approach: reuse the existing X middleware rather than add new Y.
Rationale: Y would duplicate logic already in X, and UserService is
already a dependency.
```

### 3. Implement the smallest change that satisfies the contract

- No drive-by refactors. If you notice unrelated code that looks wrong,
  record it in a `discovery` log entry and leave it.
- No new dependencies without the user's explicit permission.
- No speculative abstractions for "future flexibility."

### 4. Record discoveries as you go

Any fact you learn that was not obvious from the code goes in the log:

- "UserService already handles rate limiting at `rate.ts:42`; do not
  add new middleware."
- "Intent said 'email validation' but the existing `validateEmail` in
  `utils.ts` only checks syntax; actual domain resolution happens in
  `verify.ts`."

The log survives across sessions. Your in-session memory does not.

### 5. Verify before proposing done

Run every command in the intent's `## Verification` section. Capture
failures. If anything fails, fix it before calling `propose_done`. A
failed verification submitted as "done" will be bounced back by the
reviewer and increment the rework count.

### 6. Call `propose_done` with evidence

The orchestrator expects a summary and a list of artefacts (paths,
test names, commits). Be concrete:

```
summary: "Added JWT rotation middleware at src/auth/jwt.ts.
Existing tests continue to pass. New tests added in
src/auth/__tests__/rotation.test.ts cover expiry-within-grace and
invalid-signature cases."

artifacts:
- src/auth/jwt.ts
- src/auth/__tests__/rotation.test.ts
```

Do not produce further code after calling `propose_done`. Wait for the
orchestrator's next instruction.

## Failure modes you MUST actively defend against

These are the patterns the adversarial reviewer will hunt for. Do not
ship work containing any of them.

### Baby-counting

Silently dropping a requirement or deleting tests to make CI green.

Red flags in your own work:

- You deleted a failing test instead of fixing it
- You skipped a test with `.skip` without a log entry explaining why
- You commented out an assertion to "make it pass"
- A success criterion from the contract didn't actually get implemented

If any of these are true, stop. Fix the work, not the test.

### Cardboard muffin

Code that looks serious but doesn't really do the work.

Red flags:

- A function returns a hard-coded value regardless of input
- A conditional funnels every branch to the same output
- Broad `catch {}` that swallows errors
- Tests that assert only the shape of a response, not behaviour

### Half-assing

The happy path works; everything else is missing.

Red flags:

- Only one test case (the obvious one)
- No error handling beyond a single `try/catch`
- Config hard-coded where it should be injectable
- No logging around new failure paths

### Litterbug

Residue left in the codebase.

Red flags:

- `TODO` / `FIXME` comments with no issue reference
- Commented-out code
- Unused imports or dead helpers
- Debug logs (`console.log`, `print`) left behind
- Stale comments that no longer describe the code

Run a final scan before `propose_done`. Clean the residue. If any is
intentionally left (rare), log why.

## The hard rules

1. **Never modify `intent.md`.** The extension will block you; fight the
   urge to work around it.
2. **Every discovery goes in the log.** The log is the only memory that
   survives session turnover.
3. **No `propose_done` without passing verification.** Running the
   verification commands is part of finishing.
4. **When stuck, call `ask_orchestrator`.** Do not guess.
