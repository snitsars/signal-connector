import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Vite does not recognize node:sqlite as a builtin; keep all node: imports external.
    server: { deps: { external: [/^node:/] } },
  },
  ssr: { external: [/^node:/] },
});
