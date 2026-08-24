#!/usr/bin/env bash
set -euo pipefail

current_root="$(git rev-parse --show-toplevel)"
project_root="$(git -C "$current_root" worktree list --porcelain | sed -n '1{s/^worktree //p;}')"
status="$(git -C "$current_root" status --short --untracked-files=all)"

if [[ -n "$status" ]]; then
  {
    echo "NO-GO worker guard: hay cambios pendientes sin commitear antes de delegar la task."
    echo "El orchestrator debe commitearlos antes de que el worker corra context, take o cree worktree."
    echo
    echo "git status --short --untracked-files=all:"
    echo "$status"
  } >&2
  exit 2
fi

printf '%s\n' "$project_root"
