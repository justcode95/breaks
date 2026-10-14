import { defineConfig } from "vitest/config";

// Many test files start an in-memory Postgres (PGlite), which takes seconds when all files run at once on a busy
// machine. The default 5 s test and 10 s hook limits made the suite fail now and then for no reason in the code.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
