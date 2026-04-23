# pi-codeslinger

> **Under construction** — more extensions and skills coming soon.

A [pi](https://pi.dev/) coding agent loadout for intent-driven agentic development.

## Install

```bash
pi install git:github.com/daniel-butler-irl/pi-codeslinger
```

## Prerequisites

The following CLI tools are required by included extensions:

```bash
brew install bat git-delta glow
```

## What's included

### files-widget

In-terminal file browser and viewer. Navigate your project tree, view files with syntax highlighting, inspect git diffs, and send inline comments to the agent.

| Command      | Description                                                     |
| ------------ | --------------------------------------------------------------- |
| `/readfiles` | Open the interactive file browser                               |
| `/review`    | Code review workflow (requires `brew install agavra/tap/tuicr`) |
| `/diff`      | View diffs (requires `brew install oven-sh/bun/bun`)            |

### ask_user

A blocking question dialog. When the agent needs clarification or a decision, it calls `ask_user` with a list of typed questions. A centered dialog overlay appears in the terminal — navigate with arrow keys, toggle multi-select with space, or type a custom answer. The agent waits until all questions are answered or the dialog is dismissed (`esc`).

**Question types:**

| Type     | Behaviour                                   |
| -------- | ------------------------------------------- |
| `single` | Select one option from a list               |
| `multi`  | Toggle multiple options with space          |
| `text`   | Free-text input (with optional suggestions) |

## Intent-Driven Workflow

This loadout uses `.pi/intents/` for tracked, structured work:

- **Intent contracts** define goals, success criteria, and verification
- **Orchestrator** manages phases: defining → implementing → reviewing → done
- **Version controlled**: `.pi/` is committed so teams share intent history

### Conventions

- Commit `.pi/intents/` with code changes
- Each intent has: `intent.md`, `log.md`, `understanding.md`, verification results
- Use `/intent` overlay (Ctrl+I) to create, list, and switch intents
