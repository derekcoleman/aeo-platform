/**
 * Root layout for the public render path.
 *
 * There are two root layouts in this app — this one and `(app)` — which is why
 * there is no `app/layout.tsx`. They have genuinely different jobs: the
 * dashboard is a normal React application, while a published article is a
 * self-contained document served on someone else's domain.
 *
 * This layout is deliberately minimal. The per-site <html lang>, theme CSS and
 * JSON-LD all depend on data the page loads, so they are emitted there; putting
 * them here would force a second query on every request just to fill in the
 * shell.
 */
export default function RenderRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
