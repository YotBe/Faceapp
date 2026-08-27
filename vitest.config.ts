import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for the server-side libraries.
 *
 * Vitest rather than `node --test` because it resolves modules the way the
 * bundler does — extensionless relative imports and the `@/` alias — so the
 * tests import exactly what Next.js imports, rather than a copy adjusted to
 * satisfy a different resolver.
 *
 * These cover pure logic: signed URLs, result ranking, slug generation,
 * threshold loading. Anything needing a database or the model is covered by
 * supabase/tests and ml/tests instead.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
