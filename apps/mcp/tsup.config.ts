import { defineConfig } from "tsup";

// One self-contained dist/index.js with a shebang; runtime dependencies (MCP SDK, zod) stay in node_modules.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
