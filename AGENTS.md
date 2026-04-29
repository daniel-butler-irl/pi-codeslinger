# AGENTS.md

Contributor guidance for extension implementers — not end users.

## Tool exposure rule

When implementers add new tools to an extension, also add programmatic access where applicable.

- Do not leave capability available only through manual scripts, path construction, overlays, or UI-only flows when tool-based access makes sense.
- Expose same capability to main sessions, side sessions, and subagents when those surfaces need it.
- Keep tests updated when new tools or programmatic entry points are added.
