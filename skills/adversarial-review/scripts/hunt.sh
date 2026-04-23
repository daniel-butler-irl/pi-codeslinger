#!/usr/bin/env bash
# Runs all adversarial review hunt checks against changed files.
# Usage:
#   scripts/hunt.sh <path> [<path> ...]
#   scripts/hunt.sh --git    # auto-detect files changed vs HEAD

set -uo pipefail

FINDINGS=0

section() { printf '\n=== Hunt: %s ===\n' "$1"; }

hunt() {
    local label="$1" pattern="$2"; shift 2
    section "$label"
    local out
    out=$(grep -rEn "$pattern" "$@" 2>/dev/null || true)
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out"
        FINDINGS=$((FINDINGS + 1))
    else
        printf '(clean)\n'
    fi
}

if [[ "${1:-}" == "--git" ]]; then
    mapfile -t TARGETS < <(git diff --name-only HEAD 2>/dev/null)
    [[ ${#TARGETS[@]} -eq 0 ]] && { printf 'No changed files found.\n'; exit 0; }
else
    [[ $# -eq 0 ]] && { printf 'Usage: %s <path> [...] or %s --git\n' "$0" "$0"; exit 1; }
    TARGETS=("$@")
fi

printf 'Targets: %s\n' "${TARGETS[*]}"

hunt "weakened tests"     '\.skip|xtest\b|xit\b|\.todo\('         "${TARGETS[@]}"
hunt "hard-coded returns" 'return (true|false|"[^"]*"|\{\})\s*;'  "${TARGETS[@]}"
hunt "swallowed errors"   'catch\s*\('                             "${TARGETS[@]}"
hunt "residue"            'TODO|FIXME|XXX|console\.log\b|debugger' "${TARGETS[@]}"

printf '\n--- Manual checks required ---\n'
printf 'Shape-only tests: read new/changed tests; flag any that assert only field\n'
printf '  existence or return type, not actual behaviour.\n'
printf 'Half-assing: for each success criterion, check the unhappy paths have coverage.\n\n'

if [[ $FINDINGS -gt 0 ]]; then
    printf 'FINDINGS: %d category(s) flagged. Investigate before passing.\n' "$FINDINGS"
    exit 1
else
    printf 'Grep hunts clean. Complete the manual checks above before passing.\n'
fi
