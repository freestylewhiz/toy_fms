import { join, resolve } from "node:path";
import { WEB_CLIENT_PORT } from "../../shared/constants.ts";

const CLIENT_ROOT = resolve(import.meta.dir, "..");
const RESOURCES_ROOT = resolve(import.meta.dir, "../../resources");
const PUBLIC_DIR = join(CLIENT_ROOT, "public");
const INDEX = join(CLIENT_ROOT, "index.html");
const STYLES = join(import.meta.dir, "styles.css");
const BUNDLE = join(PUBLIC_DIR, "app.js");

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "main.ts")],
  outdir: PUBLIC_DIR,
  target: "browser",
  format: "esm",
  naming: "app.js",
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

function mime(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".bin")) return "application/octet-stream";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

function safeResource(rel: string): string | null {
  const decoded = decodeURIComponent(rel);
  if (!decoded || decoded.includes("\0")) return null;
  const full = resolve(RESOURCES_ROOT, decoded);
  const root = RESOURCES_ROOT.endsWith("/") ? RESOURCES_ROOT : `${RESOURCES_ROOT}/`;
  if (full !== RESOURCES_ROOT && !full.startsWith(root)) return null;
  return full;
}

const server = Bun.serve({
  port: WEB_CLIENT_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(INDEX), {
        headers: { "content-type": mime(".html"), "cache-control": "no-store" },
      });
    }

    if (path === "/styles.css") {
      return new Response(Bun.file(STYLES), {
        headers: { "content-type": mime(".css"), "cache-control": "no-store" },
      });
    }

    if (path === "/app.js") {
      return new Response(Bun.file(BUNDLE), {
        headers: { "content-type": mime(".js"), "cache-control": "no-store" },
      });
    }

    if (path === "/app.js.map") {
      const map = Bun.file(`${BUNDLE}.map`);
      if (await map.exists()) {
        return new Response(map, { headers: { "content-type": mime(".map") } });
      }
    }

    if (path.startsWith("/resources/")) {
      const filePath = safeResource(path.slice("/resources/".length));
      if (!filePath) return new Response("bad path", { status: 400 });
      const file = Bun.file(filePath);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "content-type": mime(filePath) } });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`bg_fms web-client  http://localhost:${server.port}`);
