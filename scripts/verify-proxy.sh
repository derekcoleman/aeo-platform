#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end verification of the reverse-proxy contract against a running
# server. Unit tests cover the decision logic; this covers the wire.
#
#   npm run build && npx next start -p 3401 &
#   ./scripts/verify-proxy.sh http://localhost:3401
#
# Requires the seed fixtures (see supabase/tests/isolation.sql) and a page at
# {prefix}/sso-vs-scim.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-http://localhost:3401}"
EDGE_HOST="${2:-acme-8fj2.blogedge.aeo.app}"
PUBLIC_HOST="${3:-acme.com}"
PREFIX="${4:-/resources}"
SLUG="${5:-sso-vs-scim}"

E=(-H "Host: $EDGE_HOST")
F=(-H "X-Forwarded-Host: $PUBLIC_HOST")
pass=0; fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
  else printf '  FAIL %s\n         expected: %s\n         actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$BASE$1" "${@:2}"; }
body() { curl -s "$BASE$1" "${@:2}"; }

echo "serving"
for p in "$PREFIX/$SLUG" "$PREFIX/$SLUG.md" "$PREFIX/sitemap.xml" "$PREFIX/llms.txt" \
         "$PREFIX/feed.xml" "$PREFIX/robots.txt" "$PREFIX/aeo-health" "/llms.txt" "/llms-full.txt"; do
  check "200 $p" 200 "$(code "$p" "${E[@]}" "${F[@]}")"
done

echo "invariant 1 — no rendered byte contains our edge hostname"
for p in "$PREFIX/$SLUG" "$PREFIX/sitemap.xml" "$PREFIX/llms.txt" "$PREFIX/feed.xml" "/llms.txt"; do
  check "clean $p" 0 "$(body "$p" "${E[@]}" "${F[@]}" | grep -c "blogedge")"
done

echo "invariant 2 — an unverified public host is never indexable"
check "direct hit is noindex" "noindex,nofollow" \
  "$(body "$PREFIX/$SLUG" "${E[@]}" | grep -o 'noindex,nofollow' | head -1)"
check "forged forwarded host is noindex" "noindex,nofollow" \
  "$(body "$PREFIX/$SLUG" "${E[@]}" -H 'X-Forwarded-Host: evil.example' | grep -o 'noindex,nofollow' | head -1)"
check "forged host cannot move the canonical" "href=\"https://$PUBLIC_HOST$PREFIX/$SLUG\"" \
  "$(body "$PREFIX/$SLUG" "${E[@]}" -H 'X-Forwarded-Host: evil.example' | grep -o "href=\"https://[^\"]*$SLUG\"" | head -1)"
check "raw edge host disallows all crawlers" "User-agent: * Disallow: / " \
  "$(body "$PREFIX/robots.txt" "${E[@]}" | tr '\n' ' ')"

echo "invariant 3 — cookies never reach a handler"
check "Cookie stripped" '"sawCookie":false' \
  "$(body "$PREFIX/aeo-health" "${E[@]}" "${F[@]}" -H 'Cookie: session=secret' | grep -o '"sawCookie":[a-z]*')"
check "Authorization stripped" '"sawAuthorization":false' \
  "$(body "$PREFIX/aeo-health" "${E[@]}" "${F[@]}" -H 'Authorization: Bearer x' | grep -o '"sawAuthorization":[a-z]*')"
check "health echoes the monitor nonce" '"nonce":"n0nce"' \
  "$(body "$PREFIX/aeo-health?nonce=n0nce" "${E[@]}" "${F[@]}" | grep -o '"nonce":"[a-z0-9]*"')"
check "we never set a cookie on their domain" 0 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" "${F[@]}" | grep -ci 'set-cookie')"

echo "invariant 5 — article pages ship zero client JavaScript"
check "no scripts other than ld+json" 0 \
  "$(body "$PREFIX/$SLUG" "${E[@]}" "${F[@]}" | grep -o '<script[^>]*>' | grep -vc 'ld+json')"

echo "proxy failure modes"
check "hop limit exceeded is 508" 508 "$(code "$PREFIX/x" "${E[@]}" -H 'X-AEO-Hops: 9')"
check "a different edge host forwarded to us is 508" 508 \
  "$(code "$PREFIX/x" "${E[@]}" -H 'X-Forwarded-Host: other-9x.blogedge.aeo.app')"
check "outside the prefix passes through" 404 "$(code "/pricing" "${E[@]}")"
check "a sibling prefix is not ours" 404 "$(code "${PREFIX}-archive/x" "${E[@]}")"
check "passthrough marker present" 1 \
  "$(curl -s -D- -o /dev/null "$BASE/pricing" "${E[@]}" | grep -ci 'x-aeo-passthrough')"
check "internal route rejected from outside" 404 \
  "$(code "/render/aaaaaaaa-0000-0000-0000-000000000001$PREFIX/$SLUG" "${E[@]}")"
check "unknown edge host" 404 "$(code "$PREFIX/x" -H 'Host: nope.blogedge.aeo.app')"

echo "trailing slash"
check "301 with a root-relative Location" "location: $PREFIX/$SLUG" \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG/" "${E[@]}" "${F[@]}" | grep -i '^location' | tr -d '\r')"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
