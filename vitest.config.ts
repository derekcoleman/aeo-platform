import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Unit tests run on fake SQL whatever the shell exports: a database URL
    // would switch defaults that read process.env (the spend governor) onto
    // a real connection. tests/db reads AEO_TEST_DATABASE_URL, which stays.
    env: { DATABASE_URL: "", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "" },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
