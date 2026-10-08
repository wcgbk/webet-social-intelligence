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

# 2b) Circa OCR runtime deps (generate-picks-circa-background only), pinned by
#     netlify/functions/lib/circa-ocr-deps/package-lock.json. Netlify drops
#     nested node_modules dirs from functions at runtime, so the pinned deps are
#     staged as the repo-root node_modules for this deploy only (bundled via
#     netlify.toml included_files; no other function requires them) and removed
#     afterwards. A pre-existing root node_modules is left untouched.
#     Non-fatal: without it Circa OCR fails loudly (contest-pdf-image-only) and
#     never falls back to sportsbook lines.
CIRCA_OCR_DEPS="netlify/functions/lib/circa-ocr-deps"
if [ -f "$CIRCA_OCR_DEPS/package-lock.json" ] && [ ! -e node_modules ]; then
  echo "→ staging Circa OCR deps ($CIRCA_OCR_DEPS → node_modules for bundling)…"
  if npm ci --prefix "$CIRCA_OCR_DEPS" --omit=dev --no-bin-links --no-audit --no-fund --loglevel=error \
     && mv "$CIRCA_OCR_DEPS/node_modules" node_modules; then
    trap 'rm -rf node_modules' EXIT
  else
    rm -rf node_modules
    echo "⚠️  Circa OCR deps install FAILED — /circa image-only PDF OCR will be unavailable in this deploy."
  fi
fi

# 3) Ship the working tree to the live site.
echo "→ deploying to webetsocial.com…"
npx netlify deploy --prod --dir . --skip-functions-cache --site 87d7bcd9-e95a-479c-bc44-6432a2ffc606  # pinned: webetsocial.com only (10/07 wrong-site incident)

echo "✅ committed + pushed + deployed — live == origin/main"
