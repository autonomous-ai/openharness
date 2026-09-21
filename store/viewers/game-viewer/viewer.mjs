import { createServer } from "node:http";
import {
  watch,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  cpSync,
} from "node:fs";
import { dirname, join, resolve, relative, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
};
const PHASES = [
  ["concept", "Imagine"],
  ["world", "Build"],
  ["play", "Play"],
  ["polish", "Polish"],
  ["check", "Check"],
];
const clean = (value) =>
  String(value ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .slice(0, 4000);
const inside = (root, path) => path === root || path.startsWith(root + sep);
function jsonFile(path, fallback) {
  try {
    if (statSync(path).size > 65536) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function fileWithin(root, path) {
  try {
    const full = realpathSync(resolve(root, path));
    return inside(realpathSync(root), full) && statSync(full).isFile()
      ? full
      : null;
  } catch {
    return null;
  }
}
function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

/** The package owns the studio. Its consumer owns the pinned Vite/game dependencies. */
export async function startGameViewer({
  workspace,
  toolchain = workspace,
  port = 0,
  build: suppliedBuild,
} = {}) {
  workspace = realpathSync(workspace);
  mkdirSync(join(workspace, ".harness"), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "openharness-game-"));
  const token = randomBytes(24).toString("hex");
  const clients = new Set();
  const revisions = new Map();
  const leases = new Map();
  let stopped = false,
    timer,
    watching,
    building = false,
    dirty = false,
    sequence = 0,
    sourceVersion = 0;
  let base = "";
  const state = {
    status: "opening",
    connected: true,
    project: {},
    progress: {},
    candidate: null,
    latest: null,
    history: [],
    activity: [],
    error: null,
  };
  const build =
    suppliedBuild ??
    (
      await import(
        pathToFileURL(
          join(
            dirname(
              createRequire(join(toolchain, "package.json")).resolve(
                "vite/package.json",
              ),
            ),
            "dist/node/index.js",
          ),
        ).href
      )
    ).build;
  const guard = readFileSync(join(HERE, "web/bridge.js"), "utf8");

  function facts() {
    const project = jsonFile(join(workspace, "studio.json"), {});
    state.project = {
      title: clean(project.title || "Your world").slice(0, 80),
      description: clean(project.description).slice(0, 180),
      controls: clean(project.controls).slice(0, 220),
    };
    const progress = jsonFile(join(workspace, ".harness/progress.json"), {});
    state.progress = {
      phase: PHASES.some(([id]) => id === progress.phase)
        ? progress.phase
        : "world",
      message: clean(progress.message).slice(0, 180),
    };
  }
  function record(kind, message) {
    state.activity.unshift({
      id: randomBytes(5).toString("hex"),
      kind,
      message: clean(message).slice(0, 240),
      at: new Date().toISOString(),
    });
    state.activity.length = Math.min(state.activity.length, 60);
  }
  function publish() {
    facts();
    const phase = PHASES.findIndex(([id]) => id === state.progress.phase);
    const ready = state.status === "ready" && !state.error && !dirty;
    const verdict = {
      spec: 1,
      ready,
      artifact: "index.html",
      summary: state.error
        ? "Update needs a fix"
        : building
          ? "Building the next version"
          : ready
            ? `Playable preview · version ${state.latest?.number}`
            : "Waiting for the game to render",
      findings: state.error
        ? [
            {
              severity: "error",
              kind: state.error.kind,
              message: state.error.message,
            },
          ]
        : [],
      phases: PHASES.map(([id, name], i) => ({
        id,
        name,
        state:
          i < phase
            ? "done"
            : i === phase
              ? state.error
                ? "failed"
                : "active"
              : "pending",
      })),
      updatedAt: new Date().toISOString(),
    };
    const file = join(workspace, ".harness/verdict.json");
    writeFileSync(file + ".tmp", JSON.stringify(verdict));
    renameSync(file + ".tmp", file);
    const runtime = {
      url: base,
      pid: process.pid,
      status: state.status,
      latest: state.latest,
      error: state.error,
      updatedAt: verdict.updatedAt,
    };
    writeFileSync(
      join(workspace, ".harness/studio-runtime.json"),
      JSON.stringify(runtime),
    );
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) client.write(event);
  }
  async function rebuild() {
    if (stopped) return;
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    dirty = false;
    const revision = {
      id: randomBytes(7).toString("hex"),
      number: ++sequence,
      sourceVersion,
      at: new Date().toISOString(),
      label: state.progress.message || state.project.title,
      ready: false,
    };
    revision.url = `/__game/${revision.id}/index.html`;
    revision.dir = join(scratch, revision.id);
    state.status = "building";
    state.error = null;
    record("build", `Building version ${revision.number}`);
    publish();
    try {
      await build({
        root: workspace,
        configFile: false,
        base: "./",
        logLevel: "silent",
        publicDir: "public",
        plugins: [
          {
            name: "openharness-game-bridge",
            transformIndexHtml: {
              order: "pre",
              handler: () => [
                {
                  tag: "script",
                  children: `window.__studioRevision=${JSON.stringify(revision.id)};\n${guard}`,
                  injectTo: "head-prepend",
                },
              ],
            },
          },
        ],
        build: {
          outDir: revision.dir,
          emptyOutDir: true,
          sourcemap: false,
          minify: false,
          chunkSizeWarningLimit: 10000,
          reportCompressedSize: false,
        },
      });
      if (stopped) return;
      revisions.set(revision.id, revision);
      state.candidate = publicRevision(revision);
      state.status = dirty ? "building" : "preview";
      record(
        "compiled",
        `Version ${revision.number} compiled · checking the live game`,
      );
    } catch (error) {
      rmSync(revision.dir, { recursive: true, force: true });
      state.error = {
        kind: "build",
        message: clean(error.message).replaceAll(workspace + sep, ""),
        file: clean(error.loc?.file || error.id).replaceAll(
          workspace + sep,
          "",
        ),
        line: error.loc?.line || null,
        frame: clean(error.frame),
      };
      state.status = "error";
      state.candidate = null;
      record("error", state.error.message);
    } finally {
      building = false;
      if (!stopped) {
        prune();
        publish();
        if (dirty) schedule(50);
      }
    }
  }
  function publicRevision(item) {
    const { dir, sourceVersion: _, ...publicItem } = item;
    return publicItem;
  }
  function prune() {
    const keep = new Set([
      state.candidate?.id,
      state.latest?.id,
      ...state.history.map((item) => item.id),
    ]);
    for (const [client, lease] of leases) {
      if (lease.until < Date.now()) {
        leases.delete(client);
        continue;
      }
      for (const id of lease.ids) keep.add(id);
    }
    for (const [id, item] of revisions)
      if (!keep.has(id)) {
        rmSync(item.dir, { recursive: true, force: true });
        revisions.delete(id);
      }
  }
  function schedule(delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(rebuild, delay);
  }
  function report(body) {
    const item = revisions.get(body.id);
    if (!item) return false;
    if (body.type === "ready" && !item.failed) {
      if (!item.ready) {
        item.ready = true;
        state.history.unshift(publicRevision(item));
        state.history.sort((a, b) => b.number - a.number);
        record("ready", `Version ${item.number} is ready to explore`);
      }
      if (!state.latest || item.number > state.latest.number)
        state.latest = publicRevision(item);
      if (
        state.candidate?.id === item.id &&
        !building &&
        !dirty &&
        item.sourceVersion === sourceVersion
      ) {
        state.status = "ready";
        state.error = null;
      }
      state.history.length = Math.min(state.history.length, 10);
    } else if (body.type === "error") {
      item.failed = true;
      item.ready = false;
      state.history = state.history.filter((entry) => entry.id !== item.id);
      if (state.latest?.id === item.id) state.latest = state.history[0] || null;
      if (state.candidate?.id === item.id) {
        state.candidate = null;
        state.status = "error";
        state.error = {
          kind: "runtime",
          message: clean(body.message),
          file: clean(body.file),
          line: Number(body.line) || null,
        };
      }
      record("error", `Version ${item.number}: ${clean(body.message)}`);
    }
    prune();
    publish();
    return true;
  }
  function assets() {
    const files = [];
    function scan(dir) {
      if (!existsSync(dir) || files.length >= 120) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name.startsWith(".") ||
          entry.isSymbolicLink() ||
          files.length >= 120
        )
          continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile())
          files.push({
            name: entry.name,
            path: relative(workspace, path).split(sep).join("/"),
            size: statSync(path).size,
            type: extname(path).slice(1),
          });
      }
    }
    scan(join(workspace, "src/assets"));
    scan(join(workspace, "public"));
    return files;
  }
  async function bodyOf(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) throw new Error("Request too large");
    }
    return JSON.parse(body || "{}");
  }
  function serveFile(req, res, file) {
    if (!file || statSync(file).size > 64 * 1024 * 1024)
      return send(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  }
  const server = createServer(async (req, res) => {
    try {
      if (
        !["127.0.0.1", "localhost"].includes(
          (req.headers.host || "").split(":")[0],
        )
      )
        return send(res, 403, { error: "Loopback host required" });
      const url = new URL(req.url, base);
      if (req.method === "POST") {
        if (
          req.headers["x-studio-token"] !== token ||
          (req.headers.origin && req.headers.origin !== base)
        )
          return send(res, 403, { error: "Invalid studio request" });
        const body = await bodyOf(req);
        if (url.pathname === "/api/report") {
          const accepted = report(body);
          return send(res, accepted ? 200 : 404, { ok: accepted });
        }
        if (url.pathname === "/api/retain") {
          if (
            !/^[a-z0-9-]{1,80}$/i.test(body.client) ||
            !Array.isArray(body.ids) ||
            body.ids.length > 4
          )
            return send(res, 400, { error: "Invalid preview lease" });
          if (leases.size >= 64 && !leases.has(body.client))
            return send(res, 429, { error: "Too many preview clients" });
          leases.set(body.client, {
            ids: body.ids.filter(
              (id) => typeof id === "string" && revisions.has(id),
            ),
            until: Date.now() + 90_000,
          });
          prune();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/api/export") {
          const item = revisions.get(body.id);
          if (!item?.ready || item.failed)
            return send(res, 409, { error: "Choose a working version first" });
          const out = join(workspace, "out");
          mkdirSync(out, { recursive: true });
          if (!inside(workspace, realpathSync(out)))
            return send(res, 403, {
              error: "Export folder must stay in the project",
            });
          let folder = `game-${item.number}`,
            suffix = 1;
          while (existsSync(join(out, folder)))
            folder = `game-${item.number}-${++suffix}`;
          cpSync(item.dir, join(out, folder), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          // The proof bridge is a spectator outside the studio; exports are otherwise standalone.
          record("export", `Saved playable game to out/${folder}`);
          publish();
          return send(res, 200, { path: `out/${folder}` });
        }
        return send(res, 404, { error: "Not found" });
      }
      if (!["GET", "HEAD"].includes(req.method))
        return send(res, 405, { error: "Method not allowed" });
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/api/state") return send(res, 200, state);
      if (url.pathname === "/api/assets") return send(res, 200, assets());
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/") {
        const html = readFileSync(join(HERE, "web/index.html"), "utf8").replace(
          "__STUDIO_TOKEN__",
          token,
        );
        return send(res, 200, html, "text/html; charset=utf-8");
      }
      if (url.pathname.startsWith("/__game/")) {
        const [id, ...path] = decodeURIComponent(url.pathname.slice(8)).split(
          "/",
        );
        const item = revisions.get(id);
        return serveFile(
          req,
          res,
          item && fileWithin(item.dir, path.join("/") || "index.html"),
        );
      }
      if (url.pathname === "/api/asset") {
        const path = url.searchParams.get("path") || "";
        if (!assets().some((file) => file.path === path))
          return send(res, 404, { error: "Not found" });
        return serveFile(req, res, fileWithin(workspace, path));
      }
      if (["/studio.css", "/studio.js"].includes(url.pathname))
        return serveFile(
          req,
          res,
          fileWithin(join(HERE, "web"), url.pathname.slice(1)),
        );
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: clean(error.message) });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  facts();
  record("open", "Studio opened");
  publish();
  watching = watch(workspace, { recursive: true }, (_, file) => {
    if (!file) return;
    const name = String(file).split(sep).join("/");
    if (name === ".harness/progress.json" || name === "studio.json") {
      facts();
      publish();
      // Studio labels and progress are metadata, not game source. Rebuilding here also turns
      // delayed startup file events into a second, unnecessary game build on macOS.
      return;
    }
    if (
      /^(node_modules|\.git|\.harness|dist|out)(\/|$)/.test(name) ||
      name.startsWith(".") ||
      /(^|\/)\./.test(name)
    )
      return;
    if (
      !/\.(tsx?|jsx?|mjs|cjs|html|css|json|glsl|vert|frag|glb|gltf|png|jpe?g|webp|svg|mp3|wav|ogg|bin|wasm)$/i.test(
        name,
      )
    )
      return;
    sourceVersion++;
    if (building) dirty = true;
    record("edit", name);
    schedule();
  });
  const heartbeat = setInterval(() => {
    prune();
    for (const client of clients) client.write(": connected\n\n");
  }, 15000);
  heartbeat.unref();
  schedule(0);
  return {
    url: base,
    state,
    token,
    rebuild,
    async close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      watching.close();
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      while (building) await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const workspace = process.env.HARNESS_WORKSPACE;
  const port = Number(process.env.HARNESS_VIEWER_PORT);
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      "HARNESS_WORKSPACE and a valid HARNESS_VIEWER_PORT are required",
    );
  const viewer = await startGameViewer({
    workspace,
    toolchain: process.env.HARNESS_DSH_DIR || workspace,
    port,
  });
  console.log(`Game Viewer listening on ${viewer.url}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => viewer.close().then(() => process.exit(0)));
}
