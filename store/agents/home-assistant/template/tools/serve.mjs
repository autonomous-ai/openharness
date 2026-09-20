import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSource,
  readSource,
  revision,
  snapshot,
  unchanged,
  saveSource,
  savedProject,
  openProject,
  safeFile,
  json,
  sha,
  CORE_VERSION,
  runtimeRevision,
} from "./project.mjs";
import { calculate, pythonFor } from "./calculate.mjs";
import { makeDelivery } from "./delivery.mjs";

export async function createStudio(workspace, options = {}) {
  const root = await realpath(resolve(workspace)),
    token = randomBytes(32).toString("hex");
  let job = null,
    checked = null,
    lastRun = null;
  const publicFiles = new Map([
    ["/studio.mjs", ["studio.mjs", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
    ["/brand.svg", ["brand.svg", "image/svg+xml"]],
    ["/schema.mjs", ["tools/schema.mjs", "text/javascript; charset=utf-8"]],
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
    );
    const send = (code, body, type = "application/json; charset=utf-8") => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { "content-type": type });
      res.end(
        req.method === "HEAD"
          ? undefined
          : type.startsWith("application/json")
            ? json(body)
            : body,
      );
    };
    const port = server.address()?.port,
      expectedHost = "127.0.0.1:" + port,
      origin = "http://" + expectedHost;
    if (req.headers.host !== expectedHost)
      return send(403, {
        error: "Use the exact loopback address printed by this studio.",
      });
    let path;
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin)
        return send(400, { error: "Invalid request origin." });
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(400, { error: "Invalid request path." });
    }
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return send(403, { error: "Same-origin studio requests only." });
    if (path.startsWith("/api/")) {
      const supplied = req.headers["x-habitat-token"];
      if (
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return send(403, {
          error: "Open this studio before requesting project data.",
        });
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          !String(req.headers["content-type"]).startsWith("application/json"))
      )
        return send(403, { error: "Use a same-origin JSON request." });
    }
    async function body() {
      if (Number(req.headers["content-length"] || 0) > 3 * 1024 * 1024) {
        const error = new Error("Request exceeds 3 MiB.");
        error.status = 413;
        throw error;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) {
          const error = new Error("Request exceeds 3 MiB.");
          error.status = 413;
          throw error;
        }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    try {
      if (path === "/" && ["GET", "HEAD"].includes(req.method)) {
        const html = (await safeFile(root, "index.html")).toString("utf8");
        if (!html.includes("__HABITAT_TOKEN__"))
          throw new Error("Studio bootstrap marker is missing.");
        return send(
          200,
          html.replace("__HABITAT_TOKEN__", token),
          "text/html; charset=utf-8",
        );
      }
      if (publicFiles.has(path) && ["GET", "HEAD"].includes(req.method)) {
        const [name, type] = publicFiles.get(path);
        return send(200, await safeFile(root, name), type);
      }
      if (path === "/api/project" && req.method === "GET") {
        const source = await readSource(root);
        let prior = null;
        try {
          const bytes = await safeFile(
            root,
            "output/results.json",
            32 * 1024 * 1024,
          );
          const manifest = JSON.parse(
            await safeFile(root, "output/manifest.json"),
          );
          if (
            manifest.files.find((f) => f.name === "results.json")?.sha256 ===
            sha(bytes)
          ) {
            const value = JSON.parse(bytes);
            if (
              value.spec === 1 &&
              value.engine === CORE_VERSION &&
              value.sourceRevision === revision(source) &&
              value.runtimeRevision === runtimeRevision(await snapshot(root)) &&
              Array.isArray(value.results) &&
              value.results.every(
                (r) =>
                  typeof r.scenario === "string" &&
                  Array.isArray(r.calls) &&
                  Array.isArray(r.changes) &&
                  Array.isArray(r.checks) &&
                  Array.isArray(r.traces),
              )
            )
              prior = value;
          }
        } catch {}
        let runtime;
        try {
          await pythonFor(root, options.python);
          runtime = { available: true };
        } catch (e) {
          runtime = { available: false, message: e.message };
        }
        return send(200, {
          source,
          revision: revision(source),
          prior,
          runtime,
        });
      }
      if (path === "/api/open" && req.method === "POST")
        return send(200, { source: openProject(await body()) });
      if (path === "/api/save" && req.method === "POST") {
        if (job)
          return send(409, {
            error: "Wait for or cancel the current test before saving.",
          });
        const value = await body();
        return send(
          200,
          await saveSource(root, value.source, value.baseRevision),
        );
      }
      if (path === "/api/run" && req.method === "POST") {
        if (job) return send(409, { error: "A test is already running." });
        const value = await body(),
          source = checkSource(value.source);
        const runtime = await snapshot(root),
          controller = new AbortController();
        checked = null;
        const current = {
          controller,
          progress: {
            index: 0,
            total: value.scenario ? 1 : source.project.scenarios.length,
            name: "Starting Core",
          },
        };
        job = current;
        try {
          const result = await calculate(root, source, {
            ...options,
            runtime,
            scenario: value.scenario,
            signal: controller.signal,
            progress: (progress) => {
              current.progress = progress;
            },
          });
          if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
            throw new Error("Combined test evidence exceeds 32 MiB.");
          lastRun = { source, result };
          if (result.complete && result.passed)
            checked = { source, result, runtime };
          return send(200, { result });
        } finally {
          if (job === current) job = null;
        }
      }
      if (path === "/api/progress" && req.method === "GET")
        return send(200, { busy: !!job, progress: job?.progress || null });
      if (path === "/api/cancel" && req.method === "POST") {
        await body();
        job?.controller.abort();
        return send(200, { cancelled: !!job });
      }
      if (path === "/api/export" && req.method === "POST") {
        if (job)
          return send(409, {
            error: "Wait for or cancel the current test first.",
          });
        const value = await body();
        const names = [
          "project.zip",
          "automations.yaml",
          "report.html",
          "results.json",
          "entities.json",
          "INTEGRATION.md",
          "manifest.json",
        ];
        if (!names.includes(value.name))
          return send(400, { error: "Unknown export type." });
        if (!checked || checked.result.sourceRevision !== value.revision)
          return send(409, {
            error:
              "Run all scenarios for this exact draft before exporting a checked delivery.",
          });
        await unchanged(root, checked.runtime);
        const file = makeDelivery(
          checked.source,
          checked.result,
          checked.runtime,
        ).find((f) => f.name === value.name);
        res.setHeader(
          "content-disposition",
          'attachment; filename="' + file.name + '"',
        );
        return send(
          200,
          file.bytes,
          file.name.endsWith(".zip")
            ? "application/zip"
            : "application/octet-stream",
        );
      }
      if (path === "/api/trace" && req.method === "POST") {
        const value = await body();
        if (!lastRun || lastRun.result.sourceRevision !== value.revision)
          return send(409, {
            error: "Run the selected scenario before downloading its trace.",
          });
        const result = lastRun.result.results.find(
          (r) => r.scenario === value.scenario,
        );
        if (!result)
          return send(404, { error: "That scenario has not been run." });
        return send(200, result);
      }
      return send(
        path.startsWith("/api/") && !["GET", "POST"].includes(req.method)
          ? 405
          : 404,
        { error: "Not available." },
      );
    } catch (error) {
      return send(error.status || 400, {
        error:
          error.code === "ENOENT"
            ? "This workspace is missing a Habitat source/runtime file. Use a fresh workspace or restore a saved project."
            : error.message,
      });
    }
  });
  server.on("close", () => job?.controller.abort());
  server.stop = () => {
    job?.controller.abort();
    server.closeAllConnections();
    server.close();
  };
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    const workspace =
      process.env.HARNESS_WORKSPACE || process.argv[2] || process.cwd();
    const port = process.env.HARNESS_VIEWER_PORT
      ? Number(process.env.HARNESS_VIEWER_PORT)
      : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid viewer port.");
    const server = await createStudio(workspace);
    server.listen(port, "127.0.0.1", () =>
      console.log("Habitat · http://127.0.0.1:" + server.address().port + "/"),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        server.stop();
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
