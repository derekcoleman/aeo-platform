import type { Route } from "next";
import Link from "next/link";
import { LayoutGrid, Plug, ShieldCheck, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionUser } from "@/lib/auth/session";

/** The signed-in frame: brand, primary nav, user. Server component; nothing interactive lives here. */
export function AppShell({ user, active, children }: { user: SessionUser; active: "projects" | "connectors" | "ops"; children: React.ReactNode }) {
  const nav = [
    { key: "projects" as const, href: "/app" as Route, label: "Projects", icon: LayoutGrid },
    { key: "connectors" as const, href: "/settings/connectors" as Route, label: "Connectors", icon: Plug },
    ...(user.isStaff ? [{ key: "ops" as const, href: "/ops" as Route, label: "Ops", icon: ShieldCheck }] : []),
  ];
  return (
    <div className="flex min-h-screen">
      <aside className="bg-muted/40 hidden w-56 shrink-0 flex-col border-r px-3 py-5 md:flex">
        <Link href={"/app" as Route} className="px-2 text-sm font-semibold tracking-tight">AEO Platform</Link>
        <nav className="mt-6 flex flex-col gap-1">
          {nav.map((n) => (
            <Link key={n.key} href={n.href} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${active === n.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:bg-background/60"}`}>
              <n.icon className="size-4" /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2">
          <p className="text-muted-foreground truncate text-xs" title={user.email ?? undefined}>{user.name ?? user.email}</p>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start px-0"><LogOut /> Sign out</Button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3 md:hidden">
          <Link href={"/app" as Route} className="text-sm font-semibold">AEO Platform</Link>
          <nav className="flex gap-3 text-sm">
            {nav.map((n) => <Link key={n.key} href={n.href} className={active === n.key ? "font-medium" : "text-muted-foreground"}>{n.label}</Link>)}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
