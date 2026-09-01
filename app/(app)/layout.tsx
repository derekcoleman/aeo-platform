import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AEO Platform",
  description: "Agentic AEO/GEO growth — measured, not asserted.",
};

/** Root layout for our own surfaces: the customer app and the ops console. */
export default function AppRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
