#!/usr/bin/env bash
# Adversarial review gates.
# Discovers and runs the repo's declared validation tools.
# Exits 1 if any gate fails or a required tool is missing.
#
# Usage: scripts/gate.sh
#
# Discovery hierarchy:
#   1. Pre-commit  — if configured, runs all repo-declared hooks as a single gate
#   2. Secrets     — always runs independently; too critical to rely on pre-commit alone
#   3. Type check  — per language (TypeScript, Python, Go, Rust)
#   4. Tests       — per ecosystem (npm, pytest, go test, cargo, make)
#   5. Linters     — per ecosystem (eslint, ruff, golangci-lint, rubocop)
#
# When pre-commit runs, steps 3-5 are skipped for tools it covers.
# Missing required tools are recorded as failures with install instructions.

set -uo pipefail

FAILURES=0
SKIPPED=()
PRE_COMMIT_RAN=false

# ── Helpers ────────────────────────────────────────────────────────────────────

section() {
    printf '\n\n══════════════════════════════════\n  %s\n══════════════════════════════════\n\n' "$1"
}

pass() { printf '✓ PASS  %s\n' "$1"; }
fail() { printf '✗ FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
skip() { printf '─ SKIP  %s\n' "$1"; SKIPPED+=("$1"); }

# Check a tool is installed. On failure, prints an actionable install hint
# and records a failure so the reviewer knows what they need to set up.
need() {
    local tool="$1" hint="${2:-}"
    if ! command -v "$tool" &>/dev/null; then
        printf '✗ MISSING  %s is required but not installed.\n' "$tool"
        [[ -n "$hint" ]] && printf '  Install: %s\n' "$hint"
        FAILURES=$((FAILURES + 1))
        return 1
    fi
    return 0
}

# Run a named gate. Streams full tool output so failures are actionable.
gate() {
    local label="$1"; shift
    printf 'Running: %s\n\n' "$*"
    if "$@"; then
        pass "$label"
    else
        fail "$label"
    fi
}

# ── 1. Pre-commit ──────────────────────────────────────────────────────────────
#
# Pre-commit is the repo's declared standard. When it is configured it typically
# covers secrets, formatting, type checking, and tests in a single call.
# If .pre-commit-config.yaml exists but pre-commit is not installed, that is a
# failure — the reviewer cannot properly review without the declared tooling.

section "Pre-commit hooks"
if [[ -f .pre-commit-config.yaml ]]; then
    if need pre-commit "https://pre-commit.com/#installation"; then
        gate "pre-commit" pre-commit run --all-files
        # Mark as ran regardless of pass/fail — output already shows what failed.
        # Individual checks below will be skipped to avoid duplicate reporting.
        PRE_COMMIT_RAN=true
    fi
else
    skip "pre-commit (.pre-commit-config.yaml not found)"
fi

# ── 2. Secrets ─────────────────────────────────────────────────────────────────
#
# Always runs independently, even if pre-commit is configured. A leaked credential
# is high enough severity that belt-and-suspenders is warranted. Checks for
# detect-secrets (Python ecosystem) and gitleaks (Go ecosystem / language-agnostic).

section "Secrets scanning"
if [[ -f .secrets.baseline ]]; then
    need detect-secrets "pip install detect-secrets" && \
        gate "detect-secrets" detect-secrets scan --baseline .secrets.baseline
elif [[ -f .gitleaks.toml || -f .gitleaks.yml ]]; then
    cfg=".gitleaks.toml"; [[ -f .gitleaks.yml ]] && cfg=".gitleaks.yml"
    need gitleaks "https://github.com/gitleaks/gitleaks#installing" && \
        gate "gitleaks" gitleaks detect --config "$cfg"
else
    skip "secrets scanning (no .secrets.baseline or gitleaks config found)"
fi

# ── 3. Type checking ───────────────────────────────────────────────────────────
#
# Type errors that slip past review often surface as runtime crashes. Each
# language ecosystem is detected by its config file. If pre-commit already ran
# these checks, they are skipped here to avoid redundant output.

section "Type checking"

# TypeScript: prefer a project-defined typecheck script over raw tsc
if [[ -f tsconfig.json ]]; then
    if $PRE_COMMIT_RAN; then
        skip "TypeScript (covered by pre-commit)"
    elif [[ -f package.json ]] && grep -q '"typecheck"' package.json; then
        gate "TypeScript" npm run typecheck
    else
        need npx && gate "TypeScript" npx tsc --noEmit
    fi
fi

# Python mypy: detected via mypy.ini or [mypy] section in pyproject.toml / setup.cfg
if [[ -f mypy.ini ]] || grep -qs '\[mypy\]' pyproject.toml setup.cfg 2>/dev/null; then
    if $PRE_COMMIT_RAN; then
        skip "mypy (covered by pre-commit)"
    else
        need mypy "pip install mypy" && gate "mypy" mypy .
    fi
fi

# Go: go vet is lightweight and catches correctness issues beyond compilation
if [[ -f go.mod ]]; then
    if $PRE_COMMIT_RAN; then
        skip "go vet (covered by pre-commit)"
    else
        need go "https://go.dev/dl/" && gate "go vet" go vet ./...
    fi
fi

# Rust: clippy with -D warnings treats warnings as errors, matching CI behaviour
if [[ -f Cargo.toml ]]; then
    if $PRE_COMMIT_RAN; then
        skip "cargo clippy (covered by pre-commit)"
    else
        need cargo "https://rustup.rs" && gate "cargo clippy" cargo clippy -- -D warnings
    fi
fi

# ── 4. Tests ───────────────────────────────────────────────────────────────────
#
# Runs the test suite for whatever ecosystem the repo uses. Makefile is the
# catch-all for repos that do not use a standard package manager.

section "Tests"

# JavaScript / TypeScript
if [[ -f package.json ]] && grep -q '"test"' package.json; then
    if $PRE_COMMIT_RAN; then
        skip "npm test (covered by pre-commit)"
    else
        gate "npm test" npm test
    fi
fi

# Python pytest: detected via pytest.ini or tool config in pyproject.toml / setup.cfg
if [[ -f pytest.ini ]] || \
   grep -qs '\[tool:pytest\]' setup.cfg 2>/dev/null || \
   grep -qs '\[tool\.pytest' pyproject.toml 2>/dev/null; then
    if $PRE_COMMIT_RAN; then
        skip "pytest (covered by pre-commit)"
    else
        need pytest "pip install pytest" && gate "pytest" pytest
    fi
fi

# Go
if [[ -f go.mod ]]; then
    if $PRE_COMMIT_RAN; then
        skip "go test (covered by pre-commit)"
    else
        need go "https://go.dev/dl/" && gate "go test" go test ./...
    fi
fi

# Rust
if [[ -f Cargo.toml ]]; then
    if $PRE_COMMIT_RAN; then
        skip "cargo test (covered by pre-commit)"
    else
        need cargo "https://rustup.rs" && gate "cargo test" cargo test
    fi
fi

# Makefile catch-all: covers any repo with a declared test target
if [[ -f Makefile ]] && grep -qE '^test:' Makefile; then
    if $PRE_COMMIT_RAN; then
        skip "make test (covered by pre-commit)"
    else
        need make && gate "make test" make test
    fi
fi

# ── 5. Linters ─────────────────────────────────────────────────────────────────
#
# Style and correctness linters. Each is detected by its config file.
# Checks the most common per-ecosystem linter; projects using multiple linters
# should add them to pre-commit so they are covered by section 1.

section "Linters"

# ESLint: check for any recognised config filename
eslint_cfg=""
for f in eslint.config.js eslint.config.cjs eslint.config.mjs eslint.config.ts \
          .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintrc.yaml; do
    [[ -f "$f" ]] && { eslint_cfg="$f"; break; }
done
if [[ -n "$eslint_cfg" ]]; then
    if $PRE_COMMIT_RAN; then
        skip "eslint (covered by pre-commit)"
    else
        need npx && gate "eslint" npx eslint .
    fi
fi

# Ruff (Python): faster replacement for flake8/isort
if grep -qs '\[tool\.ruff\]' pyproject.toml 2>/dev/null || [[ -f ruff.toml ]]; then
    if $PRE_COMMIT_RAN; then
        skip "ruff (covered by pre-commit)"
    else
        need ruff "pip install ruff" && gate "ruff" ruff check .
    fi
fi

# golangci-lint: meta-linter for Go projects
if [[ -f .golangci.yml || -f .golangci.yaml || -f .golangci.toml ]]; then
    if $PRE_COMMIT_RAN; then
        skip "golangci-lint (covered by pre-commit)"
    else
        need golangci-lint "https://golangci-lint.run/usage/install/" && \
            gate "golangci-lint" golangci-lint run
    fi
fi

# RuboCop: linter and formatter for Ruby projects
if [[ -f .rubocop.yml || -f .rubocop.yaml ]]; then
    if $PRE_COMMIT_RAN; then
        skip "rubocop (covered by pre-commit)"
    else
        need bundle "https://bundler.io" && gate "rubocop" bundle exec rubocop
    fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────

section "Summary"

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
    printf 'Skipped (%d):\n' "${#SKIPPED[@]}"
    printf '  ─ %s\n' "${SKIPPED[@]}"
    printf '\n'
fi

if [[ $FAILURES -gt 0 ]]; then
    printf '✗  %d gate(s) FAILED. Address all failures before passing.\n' "$FAILURES"
    exit 1
else
    printf '✓  All gates passed.\n'
fi
