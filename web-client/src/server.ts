import { join, resolve } from "node:path";
import { WEB_CLIENT_PORT } from "../../shared/constants.ts";
import { BlackboxHttpError, BlackboxQuery } from "../../server/src/blackbox/index.ts";

const CLIENT_ROOT = resolve(import.meta.dir, "..");
const RESOURCES_ROOT = resolve(import.meta.dir, "../../resources");
const PUBLIC_DIR = process.env.FMS_WEB_PUBLIC_DIR || join(CLIENT_ROOT, "public");
const INDEX = join(CLIENT_ROOT, "index.html");
const STYLES = join(import.meta.dir, "styles.css");
const BUNDLE = join(PUBLIC_DIR, "app.js");
const portOffset = Number(process.env.FMS_PORT_OFFSET ?? 0);
const blackbox = new BlackboxQuery();

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

function queryNumber(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function jsonError(error: unknown): Response {
  if (error instanceof BlackboxHttpError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "cache-control": "no-store" } });
  console.error("[blackbox] request failed", error);
  return Response.json({ error: { code: "blackbox_unavailable", message: "blackbox data is unavailable" } }, { status: 503, headers: { "cache-control": "no-store" } });
}

async function blackboxEndpoint(req: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/blackbox/")) return undefined;
  if (url.pathname === "/api/blackbox/reset") {
    if (req.method !== "POST") return Response.json({ error: { code: "method_not_allowed", message: "POST is required" } }, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
    let body: unknown;
    try { body = await req.json(); } catch { return Response.json({ error: { code: "invalid_body", message: "JSON body is required" } }, { status: 400, headers: { "cache-control": "no-store" } }); }
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (value.confirmationToken !== "BLACKBOX_RESET" || value.scope !== "blackbox") return Response.json({ error: { code: "confirmation_required", message: "explicit blackbox confirmation is required" } }, { status: 400, headers: { "cache-control": "no-store" } });
    try {
      const result = await blackbox.reset({ confirmationToken: "BLACKBOX_RESET", scope: "blackbox" });
      return Response.json(result, { status: result.cleanupComplete ? 200 : 207, headers: { "cache-control": "no-store" } });
    } catch (error) { return jsonError(error); }
  }
  if (req.method !== "GET") return Response.json({ error: { code: "method_not_allowed", message: "GET is required" } }, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
  try {
    if (url.pathname === "/api/blackbox/generation") {
      return Response.json(await blackbox.generation(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/blackbox/catalog") {
      const mapId = url.searchParams.get("mapId") || "";
      return Response.json(await blackbox.catalog({ mapId, asOf: queryNumber(url, "asOf") }), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/blackbox/window") {
      const mapId = url.searchParams.get("mapId") || "";
      return Response.json(await blackbox.window({ mapId, fromMs: queryNumber(url, "fromMs"), toMs: queryNumber(url, "toMs"), asOf: queryNumber(url, "asOf"), cursor: url.searchParams.get("cursor") || undefined, limit: queryNumber(url, "limit") }), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/blackbox/events") {
      const mapId = url.searchParams.get("mapId") || "";
      return Response.json(await blackbox.listMeaningful({ mapId, asOf: queryNumber(url, "asOf"), cursor: url.searchParams.get("cursor") || undefined, limit: queryNumber(url, "limit") }), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/blackbox/replay") {
      const mapId = url.searchParams.get("mapId") || "";
      const startEventId = url.searchParams.get("startEventId") || "";
      const endEventId = url.searchParams.get("endEventId") || "";
      return Response.json(await blackbox.replay({ mapId, startEventId, endEventId, asOf: queryNumber(url, "asOf") }), { headers: { "cache-control": "no-store" } });
    }
    const operationMatch = /^\/api\/blackbox\/operations\/([^/]+)$/.exec(url.pathname);
    if (operationMatch) return Response.json(await blackbox.operation(decodeURIComponent(operationMatch[1]), { mapId: url.searchParams.get("mapId") || undefined, fromMs: queryNumber(url, "fromMs"), toMs: queryNumber(url, "toMs"), asOf: queryNumber(url, "asOf"), cursor: url.searchParams.get("cursor") || undefined, limit: queryNumber(url, "limit") }), { headers: { "cache-control": "no-store" } });
    const assetMatch = /^\/api\/blackbox\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (assetMatch) {
      const path = await blackbox.assetPath(decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2]));
      return new Response(Bun.file(path), { headers: { "content-type": mime(path), "cache-control": "public, max-age=31536000, immutable" } });
    }
    throw new BlackboxHttpError(404, "not_found", "blackbox endpoint not found");
  } catch (error) {
    return jsonError(error);
  }
}

const server = Bun.serve({
  port: WEB_CLIENT_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    const blackboxResponse = await blackboxEndpoint(req, url);
    if (blackboxResponse) return blackboxResponse;

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

    if (path === "/runtime-config.json") {
      return Response.json({ portOffset: Number.isInteger(portOffset) ? portOffset : 0 });
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
