#!/usr/bin/env bash
# =============================================================================
# Brand-literal audit. Run this after a rebrand to verify nothing was missed.
#
# USAGE:
#   bash walok/scripts/check-brand-literals.sh
#
# Exits 0 if every match is in an APPROVED file (defined below). Exits 1 (and
# prints the offending lines) if a brand literal sneaks into a non-approved
# file — that's where you've forgotten a hand-edit.
#
# Requires: ripgrep (rg). Falls back to grep -r if rg is missing.
# =============================================================================

set -euo pipefail

# Run from repo root (script lives at walok/scripts/, repo root is two up).
cd "$(dirname "$0")/../.."

# The ONLY brand to audit. After rebrand, change to the slug you JUST replaced
# (so this script catches stragglers from BEFORE the rebrand).
OLD_SLUG="example-cafe"
OLD_DISPLAY="EXAMPLE CAFE"

# Approved files — brand literals here are intentional and documented.
# Each line is an exact path relative to repo root.
APPROVED=(
  "walok/electron/brand.js"
  "walok/server/electron/brand.js"
  "walok/electron/installer.nsh"
  "walok/electron/splash.html"
  "walok/index.html"
  "walok/server/src/dashboard.html"
  "walok/server/electron/auth.js"
  "walok/package.json"
  "walok/package-lock.json"
  "walok/server/package.json"
  "walok/server/package-lock.json"
  "walok/src/main.jsx"
  "walok/src/App.jsx"
  "walok/src/store/useStore.js"
  "walok/src/components/SaveLoadModal.jsx"
  "walok/src/components/TitleBar.jsx"
  "walok/src/components/AdminPanel.jsx"
  "walok/src/components/FeaturedBanner.jsx"
  "walok/src/components/UpdateModal.jsx"
  "walok/electron/main.js"
  "walok/scripts/publish-update.js"
  "walok/scripts/check-brand-literals.sh"
  "walok/build-customer.bat"
  "walok/replit.md"
  "replit.md"
)

# Build ripgrep command.
TOOL="rg"
if ! command -v rg >/dev/null 2>&1; then
  echo "WARN: ripgrep (rg) not found; falling back to grep -r (slower)."
  TOOL="grep"
fi

PATTERN="${OLD_SLUG}|${OLD_DISPLAY}"

# Collect all matches, excluding generated/binary/asset directories.
if [ "$TOOL" = "rg" ]; then
  ALL_MATCHES=$(rg -l "$PATTERN" walok/ \
    -g '!node_modules' \
    -g '!dist' \
    -g '!releases' \
    -g '!customers' \
    -g '!branding' \
    -g '!.build-jobs' \
    -g '!*.png' \
    -g '!*.ico' \
    -g '!*.icns' \
    2>/dev/null | sort -u || true)
else
  ALL_MATCHES=$(grep -rl --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.html' --include='*.bat' --include='*.sh' --include='*.nsh' --include='*.md' -E "$PATTERN" walok/ 2>/dev/null \
    | grep -v 'node_modules' \
    | grep -v '/dist/' \
    | grep -v '/releases/' \
    | grep -v '/customers/' \
    | grep -v '/branding/' \
    | grep -v '/.build-jobs/' \
    | sort -u || true)
fi

# Diff against approved list.
EXIT=0
echo "=== Brand-literal audit (looking for '$OLD_SLUG' or '$OLD_DISPLAY') ==="
echo ""

if [ -z "$ALL_MATCHES" ]; then
  echo "No matches found anywhere — clean."
  exit 0
fi

UNAPPROVED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  is_approved=0
  for a in "${APPROVED[@]}"; do
    if [ "$f" = "$a" ]; then
      is_approved=1
      break
    fi
  done
  if [ "$is_approved" -eq 0 ]; then
    UNAPPROVED="${UNAPPROVED}${f}"$'\n'
    EXIT=1
  fi
done <<< "$ALL_MATCHES"

if [ "$EXIT" -eq 0 ]; then
  echo "All brand literals are confined to approved files. Clean."
  echo ""
  echo "Approved files containing the brand:"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    count=$(grep -c -E "$PATTERN" "$f" 2>/dev/null || echo "?")
    printf "  %-55s  %s match(es)\n" "$f" "$count"
  done <<< "$ALL_MATCHES"
else
  echo "FOUND brand literals in UNAPPROVED files:"
  echo ""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "--- $f ---"
    grep -n -E "$PATTERN" "$f" | head -10
    echo ""
  done <<< "$UNAPPROVED"
  echo ""
  echo "Either replace these literals with brand-derived constants, OR add the"
  echo "file path to the APPROVED array at the top of this script."
fi

exit $EXIT
