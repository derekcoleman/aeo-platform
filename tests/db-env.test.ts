import { describe, expect, it } from "vitest";
import { appDatabaseUrl, rendererDatabaseUrl, rendererUrlFrom, supabasePublishableKey, supabaseServiceRoleKey, supabaseUrl } from "@/lib/db/env";

const POOLED = "postgres://postgres.chutvdrkvdfdynyactmm:s3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";

describe("env resolution", () => {
  it("prefers our names, then the Vercel Supabase integration's", () => {
    expect(appDatabaseUrl({ DATABASE_URL: "a", POSTGRES_URL: "b" })).toBe("a");
    expect(appDatabaseUrl({ POSTGRES_URL: "b", POSTGRES_PRISMA_URL: "c" })).toBe("b");
    expect(appDatabaseUrl({ POSTGRES_PRISMA_URL: "c" })).toBe("c");
    expect(appDatabaseUrl({ DATABASE_URL: "  " })).toBeNull();
    expect(supabaseUrl({ SUPABASE_URL: "https://x.supabase.co" })).toBe("https://x.supabase.co");
    expect(supabasePublishableKey({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pub" })).toBe("pub");
    expect(supabasePublishableKey({ SUPABASE_ANON_KEY: "anon" })).toBe("anon");
    expect(supabaseServiceRoleKey({})).toBeNull();
  });

  it("rendererUrlFrom swaps the user for the renderer role, keeping the pooler tenant suffix, host, port, db and query", () => {
    const u = new URL(rendererUrlFrom(POOLED, "p@ss word")!);
    expect(u.username).toBe("renderer.chutvdrkvdfdynyactmm");
    expect(decodeURIComponent(u.password)).toBe("p@ss word");
    expect(u.host).toBe("aws-0-us-east-1.pooler.supabase.com:6543");
    expect(u.pathname).toBe("/postgres");
    expect(u.search).toBe("?sslmode=require&supa=base-pooler.x");
    expect(new URL(rendererUrlFrom("postgresql://postgres:x@db.ref.supabase.co:5432/postgres", "pw")!).username).toBe("renderer");
    expect(rendererUrlFrom("not a url", "pw")).toBeNull();
    expect(rendererUrlFrom("https://example.com", "pw")).toBeNull();
  });

  it("rendererDatabaseUrl: explicit wins, else derived from the app URL + password, never the service connection alone", () => {
    expect(rendererDatabaseUrl({ RENDERER_DATABASE_URL: "postgres://renderer:x@h/db", POSTGRES_URL: POOLED, RENDERER_DB_PASSWORD: "pw" })).toBe("postgres://renderer:x@h/db");
    expect(new URL(rendererDatabaseUrl({ POSTGRES_URL: POOLED, RENDERER_DB_PASSWORD: "pw" })!).username).toBe("renderer.chutvdrkvdfdynyactmm");
    expect(rendererDatabaseUrl({ POSTGRES_URL: POOLED })).toBeNull();
    expect(rendererDatabaseUrl({ DATABASE_URL: POOLED })).toBeNull();
  });
});
