# AGENTS.md

Contributor guidance for extension implementers — not end users.

## Local development setup

After cloning, run these once to wire up dependencies and git hooks:

```bash
npm install
pre-commit install --hook-type pre-commit --hook-type post-merge --hook-type post-checkout
```

The `post-merge` and `post-checkout` hooks automatically re-run `npm install`
when `package-lock.json` changes, keeping `node_modules` in sync after pulls.

## Tool exposure rule

When implementers add new tools to an extension, also add programmatic access where applicable.

- Do not leave capability available only through manual scripts, path construction, overlays, or UI-only flows when tool-based access makes sense.
- Expose same capability to main sessions, side sessions, and subagents when those surfaces need it.
- Keep tests updated when new tools or programmatic entry points are added.
