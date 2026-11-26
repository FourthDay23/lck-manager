// Run a TypeScript file from this project through Vite's SSR loader (same resolution as the app).
import { createServer } from "vite";

const file = process.argv[2];
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  await server.ssrLoadModule("/" + file.replace(/\\/g, "/"));
} finally {
  await server.close();
}
