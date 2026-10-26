import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { API_VERSION } from "@dsearch/contracts";
export {createApplication,type ApplicationOptions} from './server.js';

/** Minimal authenticated diagnostic server; the application API is in server.ts. */
export async function createDiagnosticServer(status: () => unknown) {
  const token = randomBytes(32).toString("base64url");
  let authority = "";
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + token);
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== "http://" + authority)) {
      res.writeHead(403).end(); return;
    }
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401).end(); return; }
    if (req.method !== "GET" || req.url !== "/v1/status") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schema_version: API_VERSION, request_id: "status", ok: true, data: status() }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Invalid bind");
  authority = "127.0.0.1:" + address.port;
  return { url: "http://" + authority, token,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export { restoreBackup, reconcileRestore, type RestoreReport } from './restore.js';
