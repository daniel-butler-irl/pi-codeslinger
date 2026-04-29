# Intent

## Description
Each intent gets its own git worktree automatically. When the intent is marked done, the code merges to main and the worktree is cleaned up.

Intents.json and intent definitions are the single source of truth on the main branch. Creating, reading, or updating intents from any worktree writes back to the main repo's `.pi/` — never to the worktree branch.

## Success Criteria
- Creating an intent from any worktree persists to main repo's `.pi/intents.json` (not the current worktree branch).
- A worktree is auto-created for an intent (timing TBD — eager vs lazy).
- Switching active intent switches working directory / context to that intent's worktree.
- Marking an intent `done` triggers a merge of the worktree branch into main.
- On `done`, user is prompted: "delete worktree? [y/N]". Default keep. Confirm removes worktree + branch.
- `done` transition is blocked if the worktree has uncommitted changes.
- Concurrent intent edits from multiple worktrees do not corrupt `intents.json`.
- `defining → implementing` does NOT auto-start the implementer. User is prompted "Ready to start implementation? [y/N]" first. Only on confirm does worktree spawn + implementer run.
- Every phase transition starts a fresh session (already partially implemented in commit `338e481`; verify still applies after worktree changes).

## Verification
- Manual: create intent from worktree A; verify `.pi/intents.json` on main reflects it; verify worktree B sees it.
- Manual: mark intent done with clean tree; confirm merge to main and prompt appears.
- Manual: mark intent done with dirty tree; confirm transition blocked with clear error.
- Automated: unit tests for path resolution (worktree → main repo `.pi/`).
- Automated: unit tests for phase-transition guard on dirty worktree.

## Open Questions
1. ✅ Storage: Hybrid. `intents.json` + `intent.md` contract → main repo (committed on main). `log.md`/`understanding.md`/`verification.json`/`review-result.json` → feature worktree, committed there as audit trail / proof of work, merged to main on `done`.
2. ✅ Active intent: Per-worktree. Each worktree tracks its own active intent locally (not in shared intents.json). Allows parallel work.
3. ✅ Worktree timing: Lazy. Created on `defining → implementing` transition. Defining phase stays in current worktree.
4. ✅ Branch name: `intent/<slug>-<short-id>` (e.g. `intent/intents-should-each-have-worktrees-e609fe06`). Slug from title at creation; short-id = first 8 chars of UUID. Slug frozen at creation (does not chase title edits).
5. ✅ Worktree location: Configurable. Default = `~/.pi/repos/<repo-name>/<slug>-<short-id>/` (mirrors supacode pattern: namespace dir outside repo, mirrors `repos/<name>/`, branch-named subdir). User can override via config.
6. ✅ Merge: Squash merge into main (single commit per intent). Audit trail preserved via committed `.pi/<id>/log.md`. Conflicts: abort merge, leave worktree intact, surface conflict summary to user; user resolves and re-runs `done`.
7. ✅ Concurrency: File lock on `intents.json` (advisory lockfile, e.g. `proper-lockfile`). Shared lock for reads, exclusive for writes. Stale-lock handling: auto-reclaim if PID dead OR lock older than threshold (~60s); also expose `/intent unlock` manual override command.
8. ✅ Cross-tree writes: Direct filesystem write to main worktree's `.pi/`. No auto-commit. User commits intent metadata when they want.
9. ✅ Migration: `.pi/intents.json` + `.pi/intents/*/intent.md` committed on main only. Gitignored on feature/intent branches. Note: `.pi/intents/<id>/log.md`, `understanding.md`, `verification.json`, `review-result.json` ARE committed on the feature branch (audit trail) and merge to main on `done`.
10. ✅ Abandoned intents: Confirm prompt before delete. If worktree dirty, prompt warns about uncommitted changes. On confirm: force-remove worktree + delete branch. Default = cancel.
11. ✅ Per-worktree active intent stored in `.git/pi-active-intent` (each worktree has its own linked git dir; file is naturally per-worktree, never committed).
12. ✅ Worktree base: branch off `main` HEAD (latest). Predictable starting point.
13. ✅ Parallel implementing: yes — one intent per worktree, multiple worktrees run implementer loops independently.
14. ✅ Prompt UI: reuse existing `ask` extension overlay for all confirms (ready-to-start, delete-worktree, abandon).
15. ✅ Cwd-inside-worktree on remove: auto-cd to main repo, then remove. Best-effort (emit cd instruction / OSC sequence). Document fallback if shell doesn't honor.
