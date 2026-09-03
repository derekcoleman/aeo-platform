import { headers } from "next/headers";
import { INTERNAL_HEADER, type PublicHostResolution } from "@/lib/tenancy";

/**
 * Recover the verified public host from the internal headers middleware set.
 *
 * Middleware has already validated `x-forwarded-host` against the site's
 * registered domains, so the render path never re-derives trust from a raw
 * request header — it reads the decision that was made once, upstream.
 */
export async function publicHostFromHeaders(
  fallbackDomain: string,
): Promise<PublicHostResolution> {
  const h = await headers();
  const domain = h.get(INTERNAL_HEADER.canonicalDomain) || fallbackDomain;
  return { canonicalDomain: domain, indexable: h.get(INTERNAL_HEADER.indexable) === "1" };
}
