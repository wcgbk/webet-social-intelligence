#!/usr/bin/env bash
#
# deploy.sh — the blessed way to ship webetsocial.com.
#
# WHY THIS EXISTS: Netlify deploys ship the WORKING TREE straight to the live
# site (`--dir .`); there is no git CI/CD on this project. So a raw
# `netlify deploy` can put code live that was never pushed — GitHub silently
# falls behind live, and the next deploy from a fresh checkout (a cloud session,
# the nightly product loop) REVERTS it. That happened on 2026-06-18.
#
# This wrapper makes the desync impossible: it refuses to deploy uncommitted
# tracked changes, pushes origin/main FIRST, then deploys. After every run,
# live == origin/main, guaranteed.
#
# Usage:  commit your changes, then:  ./deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# 1) Refuse to deploy uncommitted tracked changes.
#    (Untracked experiment dirs — the many `??` entries — are intentionally ignored.)
DIRTY="$(git status --porcelain | grep -vE '^\?\?' || true)"
if [ -n "$DIRTY" ]; then
  echo "✋ Commit your tracked changes first — Netlify ships the working tree, so GitHub must match it:"
  echo "$DIRTY"
  echo
  echo "   git add -A && git commit -m \"…\"   then re-run ./deploy.sh"
  exit 1
fi

# 2) Sync GitHub BEFORE going live, so origin/main always == what users get.
echo "→ pushing to origin/main…"
git push origin main

# 3) Ship the working tree to the live site.
echo "→ deploying to webetsocial.com…"
npx netlify deploy --prod --dir . --skip-functions-cache

echo "✅ committed + pushed + deployed — live == origin/main"
