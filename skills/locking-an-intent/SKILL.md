---
name: locking-an-intent
description: Use when the user says "lock," "finalize," "freeze," "ready to implement," "start work on this intent," or asks to move an intent from defining to implementing.
---

# Locking an intent

Locking freezes the contract and transitions the intent from `defining`
to `implementing`. The lock validator refuses to proceed unless
`Description`, `Success Criteria`, and `Verification` are all populated.
On success, a worktree is created and the intent is ready for
implementation.

Your job here is mechanical: collect what's missing from the user, write
it through the right tool, and let the validator decide when it's done.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_intent` | See which sections are present/empty. |
| `write_intent_contract` | Write Description / Success Criteria / Verification to `intent.md`. The only correct path. |
| `lock_intent` | Validate + transition + create worktree. Returns `{ok: false, missing: string[]}` or `{ok: true, phase, worktreePath, worktreeBranch}`. |

## Procedure

1. `read_intent` — note which of `Description`, `Success Criteria`, `Verification` are missing or weak.
2. For each missing section, **ask the user** for content. Do not write content the user did not say. If a section needs work (vague description, untestable criteria, LLM-judgement verification), see `defining-intent` for what "good" looks like and push back.
3. `write_intent_contract({description?, successCriteria?, verification?})` with everything you collected in this round.
4. `lock_intent({})`.
5. Branch on the result:
   - `{ok: false, missing: [...]}` → return to step 2 for the listed sections. Loop.
   - `{ok: true, phase: "implementing", worktreePath, worktreeBranch}` → confirm the worktree path with the user (path + branch name) and stop. Implementation begins in a new session.

## Anti-patterns

- **Do not** use generic `Edit` or `Write` on `intent.md`. The lock-edit guard will block it. Even when it appears to "work" in a worktree directory, you will write to a path that is not the source-of-truth, and the lock will still fail because the main-repo file is empty.
- **Do not** read `extensions/intent/store.ts`, `paths.ts`, or `worktree-manager.ts` looking for a code-level bypass. The tools listed above are the only correct surface.
- **Do not** call `transition_phase` to skip the lock validator. `transition_phase` exists for legitimate phase moves; using it to dodge missing-section validation produces an orphan intent with no worktree and no contract.
- **Do not** invent contract content the user did not provide. If the user says "just lock it," and sections are missing, the right move is to refuse and ask for the missing content — not to fabricate it.

## Related skills

- `defining-intent` — for what good Description / Success Criteria / Verification look like, and the failure modes to defend against while filling them in.
- `implementing-against-intent` — what happens after a successful lock.
