// Read-only loopback preview for an extracted portable project. No upload/SQL endpoint.
import { createServer } from "node:http";
import { readFile, realpath, lstat } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".sqlite": "application/vnd.sqlite3",
};
export async function createPreview(workspace) {
  const root = await realpath(workspace),
    token = randomBytes(24).toString("hex"),
    prefix = "/" + token + "/";
  const allowed = new Set([
    "index.html",
    "dashboard.mjs",
    "styles.css",
    "core.js",
    "worker.js",
    "report.js",
    "vendor/sqlite3.js",
    "vendor/sqlite3.wasm",
    "vendor/checksums.json",
    "output/project.data-studio.json",
    "output/analysis-result.json",
    "output/analysis.sqlite",
    "output/report.html",
    "output/project.zip",
    "output/manifest.json",
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src blob:; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const end = (status, body) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? ""))
      return end(403, "Loopback only.");
    if (!["GET", "HEAD"].includes(req.method)) return end(405, "Read only.");
    let name;
    try {
      const path = decodeURIComponent(
        new URL(req.url, "http://127.0.0.1").pathname,
      );
      if (!path.startsWith(prefix)) return end(404, "Not found.");
      name = path.slice(prefix.length) || "index.html";
    } catch {
      return end(400, "Invalid path.");
    }
    if (!allowed.has(name)) return end(404, "Not found.");
    try {
      let file = root;
      for (const part of name.split("/")) {
        file = join(file, part);
        if ((await lstat(file)).isSymbolicLink()) return end(404, "Not found.");
      }
      if (!(await realpath(file)).startsWith(root + sep))
        return end(404, "Not found.");
      const st = await lstat(file);
      if (!st.isFile() || st.size > 32 * 1024 * 1024)
        return end(413, "File limit.");
      const bytes = await readFile(file);
      res.writeHead(200, {
        "content-type": mime[extname(name)] ?? "application/octet-stream",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      return end(404, "Not built yet. Run node tools/build.mjs.");
    }
  });
  server.previewPrefix = prefix;
  return server;
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.argv[3] || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port.");
  const server = await createPreview(resolve(process.argv[2] || process.cwd()));
  server.listen(port, "127.0.0.1", () =>
    console.log(
      "Data Studio: http://127.0.0.1:" +
        server.address().port +
        server.previewPrefix,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
