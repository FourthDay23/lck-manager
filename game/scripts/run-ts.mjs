// Run a TypeScript file from this project through Vite's SSR loader (same resolution as the app).
import { createServer } from "vite";

const file = process.argv[2];
// ws: false: no HMR socket (port 24678), so several runs at once (scripts/par.mjs) do not fight over the port
const server = await createServer({ server: { middlewareMode: true, ws: false }, appType: "custom", logLevel: "error" });
try {
  await server.ssrLoadModule("/" + file.replace(/\\/g, "/"));
} finally {
  await server.close();
}
