#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end verification of the reverse-proxy contract against a running
# server. Unit tests cover the decision logic; this covers the wire.
#
#   npm run build && npx next start -p 3401 &
#   ./scripts/verify-proxy.sh http://localhost:3401
#
# Requires the seed fixtures (supabase/seed.sql): a page at {prefix}/sso-vs-scim,
# and the taken-down pages {prefix}/noindex-example and {prefix}/retired-example.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${1:-http://localhost:3401}"
EDGE_HOST="${2:-acme-8fj2.blogedge.aeo.app}"
PUBLIC_HOST="${3:-acme.com}"
PREFIX="${4:-/resources}"
SLUG="${5:-sso-vs-scim}"
SITE_ID="${6:-aaaaaaaa-0000-0000-0000-000000000001}"
NOINDEX_SLUG="${7:-noindex-example}"
RETIRED_SLUG="${8:-retired-example}"

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

echo "own hostname — bypasses site resolution entirely"
check "a request on a non-edge host reaches the app, never the site store" 0 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" -H 'Host: app.example.test' | grep -c '^50[03]$')"

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
check "a noindex response is never stored by a shared cache" "cache-control: private, no-store" \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" | grep -i '^cache-control' | tr -d '\r' | tr 'A-Z' 'a-z')"
check "render responses vary on the forwarded host" 1 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" "${F[@]}" | grep -i '^vary' | grep -ci 'x-forwarded-host')"

echo "internal headers cannot be forged by a client"
R=(-H 'X-AEO-Internal-Redirect: https://evil.example/')
check "forged redirect header still renders the page" 200 "$(code "$PREFIX/$SLUG" "${E[@]}" "${F[@]}" "${R[@]}")"
check "forged redirect header sets no Location" 0 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" "${F[@]}" "${R[@]}" | grep -ci '^location')"
check "forged indexable header without a forwarded host is still noindex" "noindex,nofollow" \
  "$(body "$PREFIX/$SLUG" "${E[@]}" -H 'X-AEO-Internal-Indexable: 1' | grep -o 'noindex,nofollow' | head -1)"
check "forged canonical header cannot move the canonical" "href=\"https://$PUBLIC_HOST$PREFIX/$SLUG\"" \
  "$(body "$PREFIX/$SLUG" "${E[@]}" "${F[@]}" -H 'X-AEO-Internal-Canonical-Domain: evil.example' | grep -o "href=\"https://[^\"]*$SLUG\"" | head -1)"

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

echo "takedown — status is read on every request"
check "a retired page is 410" 410 "$(code "$PREFIX/$RETIRED_SLUG" "${E[@]}" "${F[@]}")"
check "a retired .md is 410" 410 "$(code "$PREFIX/$RETIRED_SLUG.md" "${E[@]}" "${F[@]}")"
check "a retired page carries no passthrough marker" 0 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$RETIRED_SLUG" "${E[@]}" "${F[@]}" | grep -ci 'x-aeo-passthrough')"
check "a noindex page still serves" 200 "$(code "$PREFIX/$NOINDEX_SLUG" "${E[@]}" "${F[@]}")"
check "a noindex page sends X-Robots-Tag on a verified host" "x-robots-tag: noindex" \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$NOINDEX_SLUG" "${E[@]}" "${F[@]}" | grep -i '^x-robots-tag' | tr -d '\r' | tr 'A-Z' 'a-z')"
check "a noindex page is noindex on a verified host" "noindex,nofollow" \
  "$(body "$PREFIX/$NOINDEX_SLUG" "${E[@]}" "${F[@]}" | grep -o 'noindex,nofollow' | head -1)"
check "a noindex .md sends X-Robots-Tag" 1 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$NOINDEX_SLUG.md" "${E[@]}" "${F[@]}" | grep -ci '^x-robots-tag: noindex')"
check "a live page sends no X-Robots-Tag" 0 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" "${F[@]}" | grep -ci '^x-robots-tag')"
# The stored etag predates the takedown; a cache must not 304 the indexable copy against it.
check "a noindex page has an ETag of its own" 1 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$NOINDEX_SLUG" "${E[@]}" "${F[@]}" | grep -ci '^etag: "[^"]*-noindex"')"
check "a live page's ETag is not a noindex one" 0 \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG" "${E[@]}" "${F[@]}" | grep -ci '^etag: "[^"]*-noindex')"
for p in "$PREFIX/sitemap.xml" "$PREFIX/feed.xml" "$PREFIX/llms.txt" "/llms-full.txt"; do
  check "$p lists neither taken-down page" 0 \
    "$(body "$p" "${E[@]}" "${F[@]}" | grep -c -e "$NOINDEX_SLUG" -e "$RETIRED_SLUG")"
done
check "the sitemap still lists the live page" 1 \
  "$(body "$PREFIX/sitemap.xml" "${E[@]}" "${F[@]}" | grep -c "$PREFIX/$SLUG<")"

echo "proxy failure modes"
check "hop limit exceeded is 508" 508 "$(code "$PREFIX/x" "${E[@]}" -H 'X-AEO-Hops: 9')"
check "a different edge host forwarded to us is 508" 508 \
  "$(code "$PREFIX/x" "${E[@]}" -H 'X-Forwarded-Host: other-9x.blogedge.aeo.app')"
check "outside the prefix passes through" 404 "$(code "/pricing" "${E[@]}")"
check "a sibling prefix is not ours" 404 "$(code "${PREFIX}-archive/x" "${E[@]}")"
check "passthrough marker present" 1 \
  "$(curl -s -D- -o /dev/null "$BASE/pricing" "${E[@]}" | grep -ci 'x-aeo-passthrough')"
check "internal route rejected from outside" 404 \
  "$(code "/render/$SITE_ID$PREFIX/$SLUG" "${E[@]}")"
check "internal route rejected on our own host" 404 \
  "$(code "/render/$SITE_ID$PREFIX/$SLUG" -H 'Host: app.example.test' -H 'X-AEO-Internal-Indexable: 1')"
check "internal route rejected on our own host, however it is spelled" 404 \
  "$(code "/%72ender/$SITE_ID$PREFIX/$SLUG" -H 'Host: app.example.test')"
check "unknown edge host" 404 "$(code "$PREFIX/x" -H 'Host: nope.blogedge.aeo.app')"

echo "trailing slash"
check "301 with a root-relative Location" "location: $PREFIX/$SLUG" \
  "$(curl -s -D- -o /dev/null "$BASE$PREFIX/$SLUG/" "${E[@]}" "${F[@]}" | grep -i '^location' | tr -d '\r')"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
