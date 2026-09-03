import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { currentUser } from "@/lib/auth/session";
import { isAuthConfigured } from "@/lib/auth/supabase";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in — AEO Platform" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const configured = isAuthConfigured();
  if (configured) {
    const user = await currentUser().catch(() => null);
    if (user) redirect((next?.startsWith("/") ? next : "/app") as Route);
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>We email you a one-time link. No password to remember.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!configured ? (
            <Alert variant="warning">
              <AlertTitle>Auth is not configured</AlertTitle>
              <AlertDescription>Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or connect the Supabase integration on Vercel).</AlertDescription>
            </Alert>
          ) : (
            <LoginForm next={next?.startsWith("/") ? next : "/app"} initialError={error ?? null} />
          )}
          <p className="text-muted-foreground text-xs">
            By signing in you agree to publish only content you have reviewed. <Link href="/" className="underline">Back</Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
