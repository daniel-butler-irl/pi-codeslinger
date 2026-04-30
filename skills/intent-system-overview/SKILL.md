---
name: intent-system-overview
description: Use when the user asks "what tools," "how do I X with intents," or makes an ambiguous intent-system request and you need to map a phrase to the right tool, overlay, or command before acting.
---

# Intent system — phrase → action map

The intent system spans three surfaces:

- **Agent-callable tools** — what you (the agent) call directly.
- **Overlay** — the UI panel the user opens with `ctrl+i`. Some confirmations (e.g., final lock acknowledgement, manual contract editing) are human-only here.
- **Slash commands** — user-typed commands like `/gtfo:handover`.

When in doubt, prefer the tool. Overlay is for the user, not for you.

## Phrase map

| User says | Tool / Overlay / Command | Notes |
| --- | --- | --- |
| "Create an intent for X" / "new intent" | `create_intent({title, description, parentIntentId?})` | Single canonical tool. Returns `{id, phase: "defining"}`. |
| "Refine the description" / "the description is vague" | `write_intent_contract({description})` | Phase must be `defining`. See `defining-intent` skill. |
| "Add success criteria" / "fill in success criteria" | `write_intent_contract({successCriteria})` | Same constraints. |
| "Add verification" / "how do we verify this" | `write_intent_contract({verification})` | Commands or manual procedures, no LLM judgement. |
| "Lock it" / "finalize" / "freeze" / "ready to start" / "ready to implement" | `lock_intent({})` | Returns `{ok: false, missing[]}` or `{ok: true, phase, worktreePath}`. See `locking-an-intent`. |
| "What's missing on this intent?" | `read_intent` then `lock_intent` (dry signal) | The structured `missing[]` is the authoritative answer. |
| "Switch to intent X" / "make X active" | `switch_intent({intentId})` | Changes the active intent for the session/sidebar. |
| "Record what I'm doing" / "note this" / "update the understanding" | `update_understanding` | Sidebar memory only. Not the contract. |
| "Log a decision/discovery" | append to `log.md` (during implementing) | The log is durable session memory. |
| "I'm done" / "propose done" / "submit for review" | `propose_done({summary, artifacts})` | Requires verification passing. Triggers adversarial review. |
| "Ask the user / orchestrator" / blocked / contract conflicts | `ask_orchestrator({question})` | Do not guess. Ask. |
| "Review this" / "adversarial review" | `report_review({verdict, findings, nextActions?})` | Reviewer-only. See `adversarial-review`. |
| "Spawn a child intent" / "we need a prerequisite" | `spawn_child_intent({title, description})` | Use when a criterion can't be verified until prereq work lands. |
| "Delete this intent" | `delete_intent({intentId})` | Single canonical tool. |
| "Move phase manually" (rare) | `transition_phase({intentId, toPhase})` | Wraps the validator. **Do not** use to skip missing-section checks during lock — use `lock_intent` for that. |
| "Open the intent panel" / "edit in the UI" | overlay (`ctrl+i`) | Human-only. Do not try to drive this from the agent. |
| "Hand off this session" | `/gtfo:handover` (slash command) | Currently user-driven. No agent tool form. |

## Read tools (always available)

| Tool | Returns |
| --- | --- |
| `read_intent` | The current contract (`intent.md`). |
| `read_intent_log` | The implementer's journal (`log.md`). |
| `read_intent_understanding` | The sidebar understanding. |
| `read_verification_results` | `verification.json` (pass/fail per command). |
| `list_intents` | All intents with phase + title. |

## Human-only surfaces (do not call from agent)

- Overlay editor (`ctrl+i`) — manual contract editing, lock confirmation UI.
- `/gtfo:handover`, `/gtfo:enable`, `/gtfo:model`, `/gtfo:threshold` — slash commands the user types.

If the user asks you to "open the panel" or "edit in the UI," tell them
that is something they do; do not try to simulate it.

## Related skills

- `defining-intent` — refining Description / Success Criteria / Verification.
- `locking-an-intent` — the lock loop end-to-end.
- `implementing-against-intent` — work after lock.
- `adversarial-review` — reviewer disposition and procedure.
