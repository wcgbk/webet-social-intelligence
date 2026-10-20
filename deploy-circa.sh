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
cd /workspace/circa-1020

# 0) Bundle deps must exist (get-circa-standings 500 on 2026-10-20: pdf-parse missing).
for m in pdf-parse @netlify/blobs; do
  [ -d "node_modules/$m" ] || { echo "node_modules/$m missing - run npm ci first"; exit 1; }
done

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
git -c credential.https://github.com.helper= -c "credential.https://github.com.helper=!/usr/local/bin/gh auth git-credential" push origin HEAD:main

# 3) Ship the working tree to the live site.
echo "→ deploying to webetsocial.com…"
npx netlify deploy --prod --dir . --skip-functions-cache --site 87d7bcd9-e95a-479c-bc44-6432a2ffc606

echo "✅ committed + pushed + deployed — live == origin/main"
