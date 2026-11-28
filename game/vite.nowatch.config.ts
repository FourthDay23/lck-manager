// Test server for one session's browser checks: same app, but no file watching or hot reload, so edits saved by
// other sessions working in this folder do not reset a draft or a match in progress. Not used by the build.
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  server: { port: 5314, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
});
