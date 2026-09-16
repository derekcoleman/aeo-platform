import { describe, expect, it } from "vitest";
import { breadcrumbs } from "@/components/app/shell";

const site = { id: "s1", name: "AEO", org_id: "o1", canonical_domain: "opus.pro", path_prefix: "/resources" };

describe("breadcrumbs", () => {
  it("is empty on the projects index and otherwise always starts at Projects", () => {
    expect(breadcrumbs(null, undefined)).toEqual([]);
    expect(breadcrumbs(null, "console")).toEqual([{ label: "Projects", href: "/app" }, { label: "Ops console" }]);
    expect(breadcrumbs(null, "settings")).toEqual([{ label: "Projects", href: "/app" }, { label: "Settings" }]);
  });

  it("links back to the project from its pages and ends on the project itself for the overview", () => {
    expect(breadcrumbs(site, "strategy")).toEqual([{ label: "Projects", href: "/app" }, { label: "AEO", href: "/app/sites/s1" }, { label: "Strategy" }]);
    expect(breadcrumbs(site, "console")).toEqual([{ label: "Projects", href: "/app" }, { label: "AEO", href: "/app/sites/s1" }, { label: "Ops console" }]);
    expect(breadcrumbs(site, "overview")).toEqual([{ label: "Projects", href: "/app" }, { label: "AEO" }]);
  });
});
