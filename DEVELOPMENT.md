# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or later (v23 recommended — required for `--experimental-strip-types`)
- [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) installed globally: `npm install -g @mariozechner/pi-coding-agent`
- [pre-commit](https://pre-commit.com/) for git hooks: `pip install pre-commit` or `brew install pre-commit`

## Setup

```bash
npm install
pre-commit install
```

`npm install` brings in TypeScript and type definitions. `pre-commit install` wires `.pre-commit-config.yaml` into your local `.git/hooks/` so checks run automatically on every commit.

## Running Pi

Launch Pi from the repo root:

```bash
pi
```

Pi reads `package.json → pi` to discover extensions, skills, prompts, and themes. This package is registered as a Pi package via `~/.pi/agent/settings.json`.

## Development Workflow

Pi does not watch files. After editing extension code, reload within a running Pi session:

```
/reload
```

This re-runs all extension factory functions and re-registers tools, commands, and event handlers. Session history is preserved.

## Testing

```bash
npm test          # run all *.test.ts files
npm run typecheck # type-check all extension source files (no emit)
```

Tests use Node's built-in `node:test` runner with `--experimental-strip-types` so TypeScript runs directly — no build step. Write test files next to the source they cover: `store.test.ts` alongside `store.ts`.

## Pre-commit Checks

Every commit runs automatically:

| Hook                        | What it catches                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| `trailing-whitespace`       | Stray whitespace                                                  |
| `end-of-file-fixer`         | Missing newline at end of file                                    |
| `check-yaml` / `check-json` | Malformed config files                                            |
| `check-merge-conflict`      | Unresolved merge markers                                          |
| `mixed-line-ending`         | CRLF line endings (normalises to LF)                              |
| `detect-secrets`            | Credentials and tokens accidentally committed                     |
| `prettier`                  | Code formatting (TypeScript, JSON, YAML, Markdown)                |
| `typecheck`                 | TypeScript type errors (catches undefined variables, wrong types) |
| `tests`                     | Unit test failures                                                |

To run all checks manually without committing:

```bash
pre-commit run --all-files
```

To update hook versions:

```bash
pre-commit autoupdate
```

### Secrets baseline

`detect-secrets` compares against `.secrets.baseline`. The baseline must be generated using pre-commit's own isolated binary (not the system-installed one) to avoid version mismatches:

```bash
# Regenerate baseline (run from repo root)
$(find ~/.cache/pre-commit -path "*/bin/detect-secrets" -not -name "detect-secrets-hook" | head -1) \
  scan --exclude-files 'package-lock\.json' $(git ls-files) > .secrets.baseline
```

If you add something that looks like a secret but isn't (e.g. a test fixture), audit it:

```bash
$(find ~/.cache/pre-commit -name "detect-secrets" -not -name "detect-secrets-hook" | head -1) \
  audit .secrets.baseline
```

Then commit the updated baseline.

## Project Structure

```
extensions/
  ask/
    index.ts      # ask_user tool — interactive question dialog for the LLM to use
    dialog.ts     # TUI component for the ask dialog
  intent/
    index.ts      # intent bar extension entry point
    panel.ts      # TUI widget rendered above the input editor
    store.ts      # file-based persistence (.pi/intents.json + .pi/intents/<id>.md)
    store.test.ts # unit tests for store logic
themes/
  monokai.json    # terminal colour theme
```

Runtime data written to the repo (not source-controlled by default):

```
.pi/
  intents.json        # active intent id + intent metadata
  intents/<id>.md     # intent content (description, goals, tasks, etc.)
```

## Pi Framework Notes

**Type resolution:** `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` are installed by `npm install` as transitive dependencies of `@tmustier/pi-files-widget`. This is how `tsc` finds the types locally even though Pi itself is a global install.

**Extension loading:** Pi bundles extensions with esbuild at runtime. Import paths use `.js` extensions (standard ESM convention) even though the source files are `.ts` — the bundler handles the remapping. Do not use `.ts` extensions in extension source imports.

**Test imports:** Test files are run directly by Node with `--experimental-strip-types`, which does _not_ do bundler-style `.js`→`.ts` remapping. Test files therefore import with `.ts` extensions. This is the only place `.ts` extensions appear in imports.

**No hot reload:** There is no file watcher. Use `/reload` inside Pi after changing extension code.

**Widget placement:** The intent panel uses `placement: "aboveEditor"`. The only other option is `"belowEditor"`. There is no sidebar concept in Pi's terminal UI.
