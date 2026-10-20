import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, mkdir, copyFile, writeFile, symlink, unlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const script = resolve(import.meta.dirname, "../../scripts/serve-mockup.mjs");
const fileNames = ["index.html", "ia.html", "app.js", "ia.js", "style.css", "tokens.css"];
const marker = "SYNTHETIC_OUTSIDE_ASSET_MARKER";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "dsearch-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "docs/design/mockups");
  await mkdir(folder, { recursive: true });
  await mkdir(join(root, "scripts"));
  await copyFile(script, join(root, "scripts/serve-mockup.mjs"));
  for (const file of fileNames) await writeFile(join(folder, file), "fixture: " + file);
  await writeFile(join(root, "outside.txt"), marker);
  return { root, folder };
}

async function start(t, root) {
  const child = spawn(process.execPath, ["scripts/serve-mockup.mjs"], {
    cwd: root, env: { DSEARCH_MOCKUP_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(); await once(child, "exit");
    }
  });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 5000);
    const fail = () => { clearTimeout(timer); reject(new Error("Server exited before starting")); };
    child.once("exit", fail);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", data => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); child.off("exit", fail); resolvePort(Number(match[1])); }
    });
  });
  return { port, child };
}

async function request(port, path = "/", { method = "GET", host, headers = [] } = {}) {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(3000, () => socket.destroy(new Error("Request timed out")));
  const chunks = [];
  socket.on("data", data => chunks.push(data));
  const done = once(socket, "end");
  await once(socket, "connect");
  socket.write([method + " " + path + " HTTP/1.1", "Host: " + (host ?? "127.0.0.1:" + port),
    ...headers, "Connection: close", "", ""].join("\r\n"));
  await done;
  const text = Buffer.concat(chunks).toString();
  return { status: Number(text.match(/^HTTP\/1\.1 (\d+)/)?.[1]), text };
}

test("serves only the six assets, with security headers and a bodyless HEAD", async t => {
  const { root } = await fixture(t);
  const { port } = await start(t, root);
  for (const path of ["/", ...fileNames.map(file => "/" + file)]) {
    const result = await request(port, path);
    assert.equal(result.status, 200, path);
    assert.match(result.text, /Content-Security-Policy: .*form-action 'none'/i);
    assert.match(result.text, /Cross-Origin-Resource-Policy: same-origin/i);
    assert.match(result.text, /X-Content-Type-Options: nosniff/i);
    assert.doesNotMatch(result.text, /Access-Control-Allow-Origin/i);
  }
  const head = await request(port, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text.split("\r\n\r\n")[1], "");
});

test("malformed URL targets cannot terminate the server", async t => {
  const { root } = await fixture(t);
  const { port, child } = await start(t, root);
  for (const target of ["http://[", "//[", "/\\[", "/index.html#fragment"]) {
    assert.equal((await request(port, target)).status, 400, target);
    assert.equal((await request(port)).status, 200);
    assert.equal(child.exitCode, null);
  }
});

test("rejects traversal, private paths, foreign hosts, and cross-origin requests", async t => {
  const { root } = await fixture(t);
  const { port } = await start(t, root);
  for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/%2e%2e%2foutside.txt", "/.git/config", "/package.json", "/%61pp.js"]) {
    const result = await request(port, path);
    assert.equal(result.status, 404, path);
    assert.ok(!result.text.includes(marker));
  }
  assert.equal((await request(port, "/", { host: "attacker.invalid" })).status, 403);
  for (const headers of [["Origin: https://attacker.invalid"], ["Origin: null"],
    ["Sec-Fetch-Site: cross-site"], ["Sec-Fetch-Site: same-site"]]) {
    assert.equal((await request(port, "/", { headers })).status, 403);
  }
  assert.equal((await request(port, "/", { headers: ["Origin: http://127.0.0.1:" + port, "Sec-Fetch-Site: same-origin"] })).status, 200);
  assert.equal((await request(port, "/", { host: "localhost:" + port })).status, 200);
  assert.equal((await request(port, "/", { method: "POST" })).status, 405);
  assert.equal((await request(port, "/", { method: "OPTIONS" })).status, 405);
});

test("rejects linked files, linked asset directories, and oversized assets before listening", async t => {
  for (const kind of ["file-link", "directory-link", "oversized", "non-regular", "missing"]) {
    const { root, folder } = await fixture(t);
    const asset = join(folder, "app.js");
    if (kind === "file-link") { await unlink(asset); await symlink(join(root, "outside.txt"), asset); }
    if (kind === "directory-link") {
      const target = join(root, "linked-assets");
      await mkdir(target);
      await rm(folder, { recursive: true }); await symlink(target, folder);
    }
    if (kind === "oversized") await writeFile(asset, Buffer.alloc(1024 * 1024 + 1));
    if (kind === "non-regular") { await unlink(asset); await mkdir(asset); }
    if (kind === "missing") await unlink(asset);
    const result = spawnSync(process.execPath, ["scripts/serve-mockup.mjs"], {
      cwd: root, env: { DSEARCH_MOCKUP_PORT: "0" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1, kind);
    assert.match(result.stderr, /Mockup assets must be/);
    assert.doesNotMatch(result.stdout, /Local design mockup:/);
  }
});

test("requests use the validated startup snapshot after local assets are replaced", async t => {
  const { root, folder } = await fixture(t);
  const { port } = await start(t, root);
  await unlink(join(folder, "app.js"));
  await symlink(join(root, "outside.txt"), join(folder, "app.js"));
  const result = await request(port, "/app.js");
  assert.equal(result.status, 200);
  assert.match(result.text, /fixture: app\.js/);
  assert.ok(!result.text.includes(marker));
});

test("rejects invalid configured ports without listening", async t => {
  const { root } = await fixture(t);
  for (const port of ["-1", "65536", "1.5", "NaN", "", "004173"]) {
    const result = spawnSync(process.execPath, ["scripts/serve-mockup.mjs"], {
      cwd: root, env: { DSEARCH_MOCKUP_PORT: port }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1, port);
    assert.match(result.stderr, /DSEARCH_MOCKUP_PORT must be/);
  }
});
