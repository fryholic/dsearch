import { createServer } from "node:http";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, extname } from "node:path";

const folder = resolve(import.meta.dirname, "../docs/design/mockups");
const files = ["index.html", "ia.html", "app.js", "ia.js", "style.css", "tokens.css"];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const maxAssetBytes = 1024 * 1024;
const portText = process.env.DSEARCH_MOCKUP_PORT ?? "4173";
if (!/^(0|[1-9]\d{0,4})$/.test(portText) || Number(portText) > 65535) {
  console.error("DSEARCH_MOCKUP_PORT must be an integer between 0 and 65535.");
  process.exit(1);
}

// Serve a fixed in-memory snapshot. Request paths never reach the filesystem.
const assets = new Map();
try {
  if (await realpath(folder) !== folder) throw new Error("Linked asset directory");
  for (const file of files) {
    const path = resolve(folder, file);
    if (await realpath(path) !== path) throw new Error("Linked asset");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxAssetBytes) throw new Error("Invalid asset");
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(maxAssetBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxAssetBytes) throw new Error("Oversized asset");
      assets.set(file, { data: Buffer.from(buffer.subarray(0, size)), type: types[extname(file)] });
    } finally {
      await handle.close();
    }
  }
} catch {
  console.error("Mockup assets must be present, regular files without symlinks, and at most 1 MiB each.");
  process.exit(1);
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
const server = createServer({
  maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000,
  keepAliveTimeout: 1000, connectionsCheckingInterval: 1000
}, (req, res) => {
  const reply = (status, body, type = "text/plain; charset=utf-8", headers = {}) => {
    res.writeHead(status, { ...securityHeaders, "Content-Type": type, ...headers });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const port = server.address().port;
  if (req.headers.host !== "127.0.0.1:" + port && req.headers.host !== "localhost:" + port) {
    reply(403, "Forbidden"); return;
  }
  const origin = "http://" + req.headers.host;
  const site = req.headers["sec-fetch-site"];
  const documentNavigation = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
  if ((req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (site !== undefined && site !== "same-origin" && site !== "none" && !documentNavigation)) {
    reply(403, "Forbidden"); return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    reply(405, "Method not allowed", undefined, { Allow: "GET, HEAD" }); return;
  }
  // Accept only origin-form targets; do not parse attacker-controlled absolute URLs.
  if (!req.url?.startsWith("/") || req.url.startsWith("//") || /[\\#]/.test(req.url)) {
    reply(400, "Bad request"); return;
  }
  const pathname = req.url.split("?", 1)[0];
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const asset = assets.get(file);
  if (!asset) { reply(404, "Not found"); return; }
  reply(200, asset.data, asset.type);
});
server.maxConnections = 32;
server.maxRequestsPerSocket = 32;
server.setTimeout(10000, socket => socket.destroy());
server.on("error", () => { console.error("Unable to start the local mockup server."); process.exit(1); });
server.listen(Number(portText), "127.0.0.1", () => {
  console.log("Local design mockup: http://127.0.0.1:" + server.address().port);
});
