---
name: defining-intent
description: Use when a user wants to create or refine an intent's Description, Success Criteria, or Verification section, or when an intent is vague, unmeasurable, or cannot be verified without consulting an AI.
---

# Defining an intent

An intent is a contract the user and the AI share about what is being
changed and what "done" looks like. A vague intent produces vague work.

Your job during defining is to help the user write a contract that is
**specific**, **outcome-oriented**, and **independently verifiable**. Not
to write code yet. Not to start work.

## Session Understanding

As you work with the user to define the intent, use the `update_understanding`
tool to capture:

1. **Current problem**: What the user is trying to achieve
2. **Clarifications needed**: Gaps in the description, criteria, or verification
3. **Next steps**: What sections still need work
4. **Decisions made**: Key choices that shaped the intent

This understanding appears in the Intent sidebar and persists across
sessions. Update it as you make progress refining the intent.

Example:

```
Problem: User wants to add JWT auth but description is vague

Clarifications needed:
- Why JWT vs current session tokens?
- What compliance requirement?
- Which tests need to pass?

Next steps:
- Refine Description with specific compliance requirement
- Add concrete success criteria for test names
- Define verification commands
```

## The three required sections

The intent file already contains section headings. Your job is to help
fill them in with real content.

### Description

What is being changed and why. One paragraph. Anchored in outcomes, not
activities.

| Weak                       | Strong                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "Refactor the auth module" | "Switch auth from session tokens to JWTs because the current tokens don't meet the compliance requirement from legal filed in INC-1872" |
| "Improve performance"      | "Reduce median API latency on /search from 800ms to under 200ms so we stop paging the on-call during peak hours"                        |

If the user gives you a weak description, ask specifically what
observable state will be different when the work is done.

### Success Criteria

Specific outcomes that distinguish "done" from "not done." Each one is
either true or false — there is no partial credit.

Rules:

- Each criterion is a single concrete thing.
- Each criterion is verifiable without consulting you or any other LLM.
- "Works correctly" is not a criterion. "Passes the integration test
  `auth/test_jwt_rotation` without skips" is a criterion.
- If the user proposes "all tests pass," push back: _which_ tests?
  Tests that exist today, or tests that need to be written? If the
  latter, the prerequisite is writing those tests — flag this.

### Verification

The literal commands, tools, or manual procedures that will be used to
check each success criterion. **No LLM judgement allowed.** If the check
requires "asking the AI," it doesn't count.

Good verification:

```bash
npm test -- --grep "jwt rotation"
tsc --noEmit
curl -f http://localhost:3000/healthz
```

Acceptable manual steps: "open the login page in Firefox, confirm a
failed login shows the new error text." — but prefer automated.

Bad verification: "review the code," "AI confirms correctness."

## Failure modes to defend against during defining

These are the named failure modes you are actively preventing. If you
see any of them while defining the intent, pause and rewrite.

| Failure mode     | What it looks like in an intent                                                   | How to fix                                                                       |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Baby-counting    | Criteria that can be satisfied by deleting or skipping tests                      | Add criteria that name what must continue passing                                |
| Cardboard muffin | Criteria that check shape, not behaviour (e.g., "a `handleAuth` function exists") | Rewrite as behavioural assertion ("given expired token X, endpoint returns 401") |
| Half-assing      | Missing operational criteria (logging, config, error paths)                       | Add criteria for non-happy paths and observability                               |
| Litterbug        | No cleanup criterion                                                              | Add: "no new TODOs, no commented-out code, no unused imports added"              |

## When to spawn a child intent

If a success criterion cannot be verified today (because the test
doesn't exist, the feature flag isn't wired, the observability doesn't
exist), you have discovered a prerequisite. Propose a child intent for
the prerequisite work and lock THIS intent only after the child is done.

Signals that a prerequisite is missing:

- Verification command refers to a test that does not yet exist
- Verification requires a tool that isn't installed
- Verification depends on an endpoint/feature that hasn't been built

When you see this, do not hide it — tell the user and propose the child
intent explicitly.

## Rule of thumb

If you cannot, standing alone, read the locked contract a week from now
and independently tell whether the work is done, the contract isn't
tight enough yet. Keep refining.
