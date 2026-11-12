import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against the TypeScript sources of every workspace package (no build needed),
// except apps/mcp, whose end-to-end test spawns the built server (npm run build first).
export default defineConfig({
  resolve: {
    alias: {
      "@glint/strategy": pkg("strategy"),
      "@glint/indicators": pkg("indicators"),
      "@glint/lighter": pkg("lighter"),
      "@glint/risk": pkg("risk"),
      "@glint/agenthub": pkg("agenthub"),
      "@glint/runner": pkg("runner"),
      "@glint/erc8004": pkg("erc8004"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
