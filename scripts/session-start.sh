#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SessionStart hook for cloud sessions (.claude/settings.json, matcher
# "startup"). Installs dependencies so `npm run check` and `npx vitest run
# tests/db` work from the first command. Local sessions are left alone: a
# developer's node_modules is theirs to manage.
#
#   CLAUDE_CODE_REMOTE=true ./scripts/session-start.sh
#
# Idempotent. After a successful install it stamps node_modules with the
# sha256 of package-lock.json; the next start skips the install while the stamp
# matches. `npm ci` deletes node_modules first, so a stale stamp can never
# survive a failed install.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

STAMP=node_modules/.session-start-lock.sha256
want="$(sha256sum package-lock.json | cut -d' ' -f1)"

if [ -d node_modules/.bin ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$want" ]; then
  echo "session-start: node_modules matches package-lock.json; skipping npm ci"
  exit 0
fi

echo "session-start: installing dependencies (npm ci)"
npm ci --no-audit --no-fund
printf '%s\n' "$want" > "$STAMP"
echo "session-start: done"
