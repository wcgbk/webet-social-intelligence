#!/bin/sh
# Fail when the worktree has uncommitted changes. Run before leaving a session.
# Does not commit, push, or install a git hook.
set -eu
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "PROCESS GUARD: uncommitted work"
  git status --porcelain
  exit 1
fi
echo "PROCESS GUARD: clean worktree on $(git rev-parse --abbrev-ref HEAD)"
exit 0
