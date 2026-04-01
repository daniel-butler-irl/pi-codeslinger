# pi-codeslinger

> **Under construction** — more extensions and skills coming soon.

A [pi](https://github.com/badlogic/pi-mono) coding agent loadout for intent-driven agentic development.

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

| Command | Description |
|---|---|
| `/readfiles` | Open the interactive file browser |
| `/review` | Code review workflow (requires `brew install agavra/tap/tuicr`) |
| `/diff` | View diffs (requires `brew install oven-sh/bun/bun`) |
