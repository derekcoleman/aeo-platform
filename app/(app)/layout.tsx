import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "AEO Platform",
  description: "Agentic AEO/GEO growth — measured, not asserted.",
};

/** Root layout for our own surfaces: the customer app and the ops console. */
export default function AppRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
