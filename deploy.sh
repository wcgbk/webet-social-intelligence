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

# 0) Netlify bundles functions with nft, which does NOT follow a symlinked
#    node_modules: the zip gets a dangling "node_modules" link, deps are missing
#    and Netlify fails with 500 "Failed to wait for function to become active"
#    (11/15: four failed deploys from worktrees whose node_modules was a symlink).
#    Materialize a real copy so ./deploy.sh works from any worktree.
if [ -L node_modules ]; then
  NM_REAL="$(readlink -f node_modules)"
  if [ ! -d "$NM_REAL" ]; then echo "✋ node_modules symlink is dangling ($NM_REAL) — run npm ci first."; exit 1; fi
  echo "→ node_modules is a symlink; replacing it with a real copy for nft bundling…"
  rm node_modules
  cp -a "$NM_REAL" node_modules
fi
if [ ! -f node_modules/@netlify/blobs/package.json ]; then
  echo "✋ node_modules missing or incomplete — run npm ci first. Not deploying."
  exit 1
fi

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

# 1b) Omega v2 pre-deploy gate (card checks + math gate replay). Any failure stops here: no push, no deploy.
echo "→ running omega-v2 gate…"
if ! npm run -s omega-v2:gate; then
  echo "✋ omega-v2 gate failed — not pushing, not deploying."
  exit 1
fi

# 2) Sync GitHub BEFORE going live, so origin/main always == what users get.
echo "→ pushing to origin/main…"
git push origin HEAD:main

# 3) Ship the working tree to the live site.
echo "→ deploying to webetsocial.com…"
npx netlify deploy --prod --dir . --skip-functions-cache

echo "✅ committed + pushed + deployed — live == origin/main"
