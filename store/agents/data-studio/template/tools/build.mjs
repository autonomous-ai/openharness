import {
  readFile,
  readdir,
  lstat,
  realpath,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { zip } from "./archive.mjs";
import {
  source,
  snapshot,
  unchanged,
  save,
  sha,
  json,
  publish,
  transaction,
  exists,
} from "./files.mjs";
import { revision } from "./engine-node.mjs";
import "../core.js";
import "../report.js";
const C = globalThis.DataStudioCore;
export const runtimeFiles = [
  "index.html",
  "dashboard.mjs",
  "styles.css",
  "core.js",
  "worker.js",
  "report.js",
  "proof.json",
  "vendor/sqlite3.js",
  "vendor/sqlite3.wasm",
  "vendor/NOTICE.md",
  "vendor/checksums.json",
  "vendor/EMSCRIPTEN-LICENSE.txt",
  "vendor/MUSL-COPYRIGHT.txt",
  "tools/build.mjs",
  "tools/calculate.mjs",
  "tools/engine-node.mjs",
  "tools/files.mjs",
  "tools/archive.mjs",
  "tools/restore.mjs",
  "tools/serve.mjs",
  "PROJECT.md",
  "LICENSE",
];
const decode = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export async function loadBundle(workspace) {
  const config = JSON.parse(decode(await source(workspace, "analysis.json")));
  C.validateConfig(config);
  const names = [
    "analysis.json",
    ...config.tables.map((t) => t.file),
    ...[...new Set([...config.queries, ...config.checks].map((q) => q.file))],
  ];
  if (names.some((n) => !C.path(n))) throw new Error("Unsafe source path.");
  if (await exists(join(workspace, "view.json"))) names.push("view.json");
  const files = await snapshot(workspace, names),
    data = Object.fromEntries(files.map((f) => [f.name, decode(f.bytes)]));
  // Use the snapshotted config, never a separately read copy that could change mid-build.
  if (
    data["analysis.json"] !== JSON.stringify(config) &&
    C.stable(JSON.parse(data["analysis.json"])) !== C.stable(config)
  )
    throw new Error("Analysis changed while discovering its files.");
  const bundle = {
    config,
    sources: Object.fromEntries(
      config.tables.map((t) => [t.file, data[t.file]]),
    ),
    sql: Object.fromEntries(
      [...config.queries, ...config.checks].map((q) => [q.file, data[q.file]]),
    ),
  };
  const view = data["view.json"]
    ? JSON.parse(data["view.json"])
    : {
        parameters: {},
        notes: "",
        selectedQuery:
          config.queries.find((q) => q.kind !== "metric")?.id ??
          config.queries[0].id,
      };
  C.validateView(view, config);
  return { bundle, view, files };
}
function reopened(database, bundle, report) {
  const db = new DatabaseSync(database, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Saved SQLite database did not reopen intact.");
    for (const q of bundle.config.queries) {
      const stmt = db.prepare(bundle.sql[q.file]);
      stmt.setReadBigInts(true);
      const names = C.validateSQL(bundle.sql[q.file], bundle.config),
        bind = Object.fromEntries(
          names.map((n) => [":" + n, report.parameters[n]]),
        ),
        cols = stmt.columns().map((c) => c.name),
        rows = [];
      for (const r of stmt.iterate(bind)) {
        rows.push(cols.map((c) => C.scalar(r[c])));
        if (rows.length > C.LIMITS.resultRows)
          throw new Error("Reopened query exceeds limit.");
      }
      if (
        C.stable(C.result(cols, rows, q)) !==
        C.stable(report.results.find((r) => r.id === q.id))
      )
        throw new Error("Reopened database disagrees with " + q.id);
    }
  } finally {
    db.close();
  }
}
export async function build(input) {
  const workspace = await realpath(resolve(input));
  return transaction(workspace, async ({ state, stage, verdict }) => {
    const { bundle, view, files } = await loadBundle(workspace);
    C.prepare(bundle);
    const assets = await snapshot(workspace, runtimeFiles);
    const vendor = JSON.parse(
      decode(assets.find((f) => f.name === "vendor/checksums.json").bytes),
    );
    for (const name of ["sqlite3.js", "sqlite3.wasm"])
      if (
        sha(assets.find((f) => f.name === "vendor/" + name).bytes) !==
        vendor[name]
      )
        throw new Error("SQLite vendor checksum mismatch: " + name);
    const output = join(stage, "output");
    await mkdir(output);
    await writeFile(
      join(stage, "input.json"),
      json({ bundle, parameters: view.parameters }),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=256",
        fileURLToPath(new URL("./calculate.mjs", import.meta.url)),
        join(stage, "input.json"),
        join(output, "analysis-result.json"),
        join(output, "analysis.sqlite"),
      ],
      { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        "Analysis failed: " +
          (child.error?.code === "ETIMEDOUT"
            ? "20-second query budget exceeded"
            : child.stderr.trim() || child.error?.message || "worker exited"),
      );
    const report = JSON.parse(
      await readFile(join(output, "analysis-result.json"), "utf8"),
    );
    // The independent reopen is also bounded. Never execute user SQL in the parent process.
    const verify = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=256",
        fileURLToPath(import.meta.url),
        "--reopen",
        join(output, "analysis.sqlite"),
        join(stage, "input.json"),
        join(output, "analysis-result.json"),
      ],
      { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    if (verify.error || verify.status !== 0)
      throw new Error(
        "Independent SQLite reopen failed: " +
          (verify.stderr.trim() || verify.error?.message),
      );
    report.checks.push({
      id: "reopen",
      passed: true,
      description:
        "Saved SQLite file reopened read-only; every query reproduced exactly.",
    });
    C.verifyLinks(bundle, report.results);
    report.checks.push({
      id: "source_links",
      passed: true,
      description:
        "Every declared source-record link resolves to a real input record.",
    });
    report.artifacts = {
      database: sha(await readFile(join(output, "analysis.sqlite"))),
    };
    report.runtime = Object.fromEntries(
      assets.map((f) => [f.name, sha(f.bytes)]),
    );
    await writeFile(join(output, "analysis-result.json"), json(report));
    const project = {
      format: "data-studio",
      spec: 1,
      revision: revision(bundle),
      bundle,
      view: { ...view, parameters: report.parameters },
    };
    await writeFile(join(output, "project.data-studio.json"), json(project));
    await writeFile(
      join(output, "report.html"),
      globalThis.DataStudioReport(bundle, report, view.notes),
    );
    for (const r of report.results)
      await writeFile(join(output, r.id + ".csv"), C.csv(r.columns, r.rows));
    const manifest = {
      spec: 1,
      revision: report.revision,
      parameters: report.parameters,
      inputs: Object.fromEntries(files.map((f) => [f.name, sha(f.bytes)])),
      outputs: {},
    };
    const outputFiles = [];
    for (const name of await readdir(output)) {
      const bytes = await readFile(join(output, name));
      manifest.outputs[name] = sha(bytes);
      outputFiles.push({ name: "output/" + name, bytes });
    }
    await writeFile(join(output, "manifest.json"), json(manifest));
    outputFiles.push({
      name: "output/manifest.json",
      bytes: Buffer.from(json(manifest)),
    });
    await writeFile(
      join(output, "project.zip"),
      zip([...files, ...assets, ...outputFiles]),
    );
    await unchanged(workspace, [...files, ...assets]);
    const history = await publish(workspace, state, stage, ["output"]);
    await save(join(state, "analysis-result.json"), json(report));
    await verdict({
      summary:
        "Analysis built: " +
        report.records +
        " source records, " +
        report.results.length +
        " queries, " +
        report.checks.length +
        " checks. Browser interaction proof still required.",
      artifact: "index.html",
    });
    return {
      revision: report.revision,
      records: report.records,
      queries: report.results.length,
      checks: report.checks.length,
      output: join(workspace, "output"),
      history,
    };
  });
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "--reopen") {
      const input = JSON.parse(await readFile(process.argv[4], "utf8")),
        report = JSON.parse(await readFile(process.argv[5], "utf8"));
      reopened(process.argv[3], input.bundle, report);
      console.log("Saved database queries reproduced.");
    } else
      console.log(
        JSON.stringify(await build(process.argv[2] || process.cwd()), null, 2),
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
