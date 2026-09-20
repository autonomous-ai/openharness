import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  cp,
  writeFile,
  mkdir,
  symlink,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runAnalysis, revision } from "../template/tools/engine-node.mjs";
import { build, loadBundle } from "../template/tools/build.mjs";
import { restore } from "../template/tools/restore.mjs";
import { sha } from "../template/tools/files.mjs";
import { unzip } from "../template/tools/archive.mjs";
import "../template/core.js";
const C = globalThis.DataStudioCore,
  root = fileURLToPath(new URL("../", import.meta.url)),
  template = join(root, "template");
const clone = structuredClone;
async function bundle(where = template) {
  return (await loadBundle(where)).bundle;
}
async function workspace(prefix = "data-workflow-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await cp(template, dir, { recursive: true });
  return dir;
}
const result = (r, id) => r.results.find((r) => r.id === id);

test("report exports escape data and result row limits are enforced", async () => {
  const b = await bundle();
  b.config.title = "<img src=x onerror=alert(1)>";
  const report = runAnalysis(b),
    html = globalThis.DataStudioReport(
      b,
      report,
      "</pre><script>alert(1)</script>",
    );
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Synthetic example data"));
  assert.throws(
    () =>
      C.result(
        ["n"],
        Array.from({ length: 10001 }, () => [1]),
        { kind: "table" },
      ),
    /10,000/,
  );
  assert.throws(() => C.parseCSV("a\n" + "x".repeat(4097)), /4096/);
});

test("a source edited during the real calculation cannot publish stale results", async () => {
  const w = await workspace();
  await build(w);
  const before = sha(await readFile(join(w, "output/project.zip")));
  const calculate = join(w, "tools/calculate.mjs");
  await writeFile(
    calculate,
    "await new Promise(r=>setTimeout(r,350));\n" +
      (await readFile(calculate, "utf8")),
  );
  const child = spawn(process.execPath, [join(w, "tools/build.mjs"), w], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.resume();
  const closed = once(child, "close");
  let inputReady = false;
  for (let i = 0; i < 150; i++) {
    for (const name of await readdir(join(w, ".harness"))) {
      if (!name.startsWith("data-") || name.endsWith(".lock")) continue;
      try {
        await readFile(join(w, ".harness", name, "input.json"));
        inputReady = true;
      } catch {}
    }
    if (inputReady) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(inputReady, true);
  const products = join(w, "sources/products.csv");
  await writeFile(
    products,
    (await readFile(products, "utf8")) + "099,New item,Creative\n",
  );
  assert.equal((await closed)[0], 1, stderr);
  assert.match(stderr, /Source changed during build/);
  assert.equal(sha(await readFile(join(w, "output/project.zip"))), before);
});

test("CSV preserves text IDs, multiline records, quotes and BOM; rejects damaged records", () => {
  const p = C.parseCSV(
    '\uFEFFid,label,value\r\n001,"North, coast",-2.50\r\n002,"A ""quoted""\nteam",0\r\n',
  );
  assert.deepEqual(p.headers, ["id", "label", "value"]);
  assert.deepEqual(p.records, [
    ["001", "North, coast", "-2.50"],
    ["002", 'A "quoted"\nteam', "0"],
  ]);
  for (const csv of [
    "",
    "a,a\n1,2",
    "a,b\n1",
    "a,b\n1,2,3",
    'a\n"unclosed',
    'a\n"closed"x',
    "a\n\n",
    "a\n1\n\n",
    " a\nx",
    "a\nx\0",
  ])
    assert.throws(() => C.parseCSV(csv), undefined, csv);
});
test("explicit number/date rules retain missing and reject coercion or hidden rounding", () => {
  const money = { type: "decimal", scale: 2, nullable: false };
  assert.equal(C.convert("12.30", money, "USD"), 1230);
  assert.equal(C.convert("-0.01", money, "USD"), -1);
  for (const raw of [
    "0x10",
    "1e2",
    "12.301",
    " 12.3",
    "NaN",
    "Infinity",
    "1,000.00",
    "",
  ])
    assert.throws(() => C.convert(raw, money, "USD"));
  assert.equal(C.convert("", { type: "real", nullable: true }, "x"), null);
  assert.equal(C.convert("0", { type: "integer" }, "x"), 0);
  assert.equal(C.convert("001", { type: "text" }, "id"), "001");
  assert.equal(C.convert("2024-02-29", { type: "date" }, "date"), "2024-02-29");
  assert.throws(() => C.convert("2026-02-30", { type: "date" }, "date"));
  assert.throws(() => C.convert("9007199254740992", { type: "integer" }, "x"));
  assert.throws(() => C.scalar(9007199254740992n));
});
test("SQL lexer allows quoted separators but blocks writes, multiple statements and undeclared parameters", () => {
  const c = { parameters: [{ id: "region" }] };
  assert.deepEqual(
    C.validateSQL(
      "WITH t AS (SELECT ';--' AS x) SELECT * FROM t WHERE :region='West'; -- done",
      c,
    ),
    ["region"],
  );
  for (const sql of [
    "SELECT 1; SELECT 2",
    "PRAGMA query_only=OFF",
    "ATTACH 'secret' AS x",
    "WITH x AS (SELECT 1) DELETE FROM t",
    "SELECT load_extension('x')",
    "SELECT \"readfile\"('x')",
    "SELECT * FROM pragma_database_list",
    "SELECT :unknown",
    "SELECT ?",
    "SELECT 1 /*",
    "SELECT 'unterminated",
  ])
    assert.throws(() => C.validateSQL(sql, c), undefined, sql);
});
test("actual sales example reconciles exact money and trace rows; no inferred ID/year measures", async () => {
  const b = await bundle(),
    r = runAnalysis(b);
  assert.deepEqual(result(r, "headline").rows[0], [
    460450,
    436650,
    -23800,
    -23800 / 460450,
    24,
  ]);
  const categories = result(r, "contribution").rows;
  assert.deepEqual(categories, [
    ["Creative", 123200, 196800, 73600],
    ["Home", 165350, 127550, -37800],
    ["Outdoor", 171900, 112300, -59600],
  ]);
  assert.equal(
    categories.reduce((n, row) => n + row[3], 0),
    -23800,
  );
  const traced = runAnalysis(b, { category: "Outdoor" });
  assert.equal(result(traced, "transactions_detail").rows.length, 8);
  C.verifyLinks(b, traced.results);
  assert.equal(result(traced, "transactions_detail").rows[0][2], "00005");
  assert.equal(C.prepare(b).tables[1].rows[0][1], "001");
  const noSales = runAnalysis(b, {
    baseline: "2027-01-01",
    comparison: "2027-02-01",
  });
  assert.deepEqual(result(noSales, "headline").rows[0], [0, 0, 0, null, 0]);
  assert.deepEqual(result(noSales, "contribution").rows, []);
});
test("duplicate keys, unmatched joins, missing prices and malformed rules fail before analysis", async () => {
  const b = await bundle();
  for (const mutate of [
    (b) => (b.sources["sources/products.csv"] += "001,Duplicate,Home\r\n"),
    (b) =>
      (b.sources["sources/transactions.csv"] = b.sources[
        "sources/transactions.csv"
      ].replace(",001,", ",999,")),
    (b) =>
      (b.sources["sources/transactions.csv"] = b.sources[
        "sources/transactions.csv"
      ].replace(",38.00,", ",,")),
    (b) => (b.config.tables[0].columns[0].type = "integer"),
    (b) => (b.config.relationships[0].to.column = "category"),
    (b) => (b.config.tables[0].file = "../outside.csv"),
    (b) => (b.config.unrecognized = true),
  ]) {
    const c = clone(b);
    mutate(c);
    assert.throws(() => runAnalysis(c));
  }
  assert.throws(
    () => runAnalysis(b, { baseline: "2026-01-02" }),
    /first-of-month/,
  );
  assert.throws(() => runAnalysis(b, { region: "unknown" }), /allowed choices/);
});
test("delivery workflow uses the correct denominator and retains missing outcomes", async () => {
  const b = await bundle(join(root, "test/fixtures/delivery")),
    r = runAnalysis(b);
  assert.deepEqual(result(r, "headline").rows[0], [18, 15, 3, 7 / 15]);
  const routes = result(r, "routes_summary").rows;
  assert.deepEqual(routes, [
    ["Metro", 6, 5, 1, 1],
    ["Coastal", 6, 5, 1, 0.4],
    ["Highlands", 6, 5, 1, 0],
  ]);
  const early = runAnalysis(b, { as_of: "2026-04-01" });
  assert.deepEqual(result(early, "headline").rows[0], [18, 0, 18, null]);
  assert.ok(result(early, "routes_summary").rows.every((r) => r[4] === null));
  const revised = clone(b);
  revised.sources["sources/shipments.csv"] = revised.sources[
    "sources/shipments.csv"
  ].replace("0017,02,2026-04-19,,1", "0017,02,2026-04-19,2026-04-19,1");
  const after = runAnalysis(revised);
  assert.deepEqual(result(after, "headline").rows[0], [18, 16, 2, 0.5]);
  assert.notEqual(revision(revised), revision(b));
});
test("query shape, missing chart values, duplicate aliases, large results and checks are validated", async () => {
  const b = await bundle();
  for (const [sql, pattern] of [
    ["SELECT 1 AS x, 2 AS x", /Duplicate/],
    ["SELECT 9223372036854775807 AS x", /exact range/],
    ["SELECT randomblob(10) AS x", /Unsupported/],
  ]) {
    const c = clone(b);
    c.sql[c.config.queries[0].file] = sql;
    assert.throws(() => runAnalysis(c), pattern);
  }
  assert.throws(
    () => C.result(["a"], [[1], [2]], { kind: "metric" }),
    /exactly one/,
  );
  assert.throws(
    () =>
      C.result(["x", "y"], [["a", "not a number"]], {
        kind: "bar",
        x: "x",
        y: "y",
      }),
    /numeric or null/,
  );
  assert.equal(
    C.result(["x", "y"], [["a", null]], { kind: "bar", x: "x", y: "y" })
      .rows[0][1],
    null,
  );
  const c = clone(b);
  c.sql[c.config.checks[0].file] = "SELECT 1 AS violations";
  assert.throws(() => runAnalysis(c), /violations=0/);
});
test("spreadsheet-safe CSV protects formula-like text while JSON retains exact null/text", () => {
  const rows = [
    ["001", '=HYPERLINK("https://invalid")', null, -2],
    ["002", " +SUM(1,2)", "", 0],
  ];
  const csv = C.csv(["id", "note", "missing", "amount"], rows),
    p = C.parseCSV(csv);
  assert.match(p.records[0][1], /^'=/);
  assert.match(p.records[1][1], /^' /);
  assert.equal(p.records[0][3], "-2");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);
});
test("real build reopens SQLite, excludes undeclared files, restores portable project and preserves good outputs on errors", async () => {
  const w = await workspace(),
    r = await build(w);
  assert.equal(r.checks, 9);
  const first = await readFile(join(w, "output/analysis-result.json")),
    report = JSON.parse(first),
    database = new DatabaseSync(join(w, "output/analysis.sqlite"), {
      readOnly: true,
    });
  assert.equal(
    database.prepare("SELECT line_id FROM transactions WHERE _record=2").get()
      .line_id,
    "00001",
  );
  database.close();
  await writeFile(join(w, "private-note.txt"), "not part of this analysis");
  await build(w);
  const archive = unzip(await readFile(join(w, "output/project.zip")));
  assert.equal(archive.has("private-note.txt"), false);
  assert.equal(archive.has(".harness/verdict.json"), false);
  assert.ok(archive.has("vendor/sqlite3.wasm"));
  const extracted = await mkdtemp(join(tmpdir(), "data-portable-"));
  for (const [name, bytes] of archive) {
    await mkdir(dirname(join(extracted, name)), { recursive: true });
    await writeFile(join(extracted, name), bytes);
  }
  const rebuilt = await build(extracted);
  assert.equal(rebuilt.revision, r.revision);
  assert.deepEqual(
    JSON.parse(await readFile(join(extracted, "output/analysis-result.json")))
      .results,
    report.results,
  );
  const restored = await mkdtemp(join(tmpdir(), "data-restored-"));
  await restore(join(w, "output/project.data-studio.json"), restored);
  assert.equal((await build(restored)).revision, r.revision);
  await assert.rejects(
    restore(join(w, "output/project.data-studio.json"), restored),
    /empty/,
  );
  const before = sha(await readFile(join(w, "output/project.zip"))),
    csv = await readFile(join(w, "sources/products.csv"), "utf8");
  await writeFile(
    join(w, "sources/products.csv"),
    csv + "001,duplicate,Home\n",
  );
  await assert.rejects(build(w), /duplicate key/);
  assert.equal(sha(await readFile(join(w, "output/project.zip"))), before);
  assert.equal(
    JSON.parse(await readFile(join(w, ".harness/verdict.json"))).ready,
    false,
  );
  await writeFile(join(w, "sources/products.csv"), csv);
  await mkdir(join(w, ".harness/data-build.lock"));
  await assert.rejects(build(w), /Another build/);
});
test("saved project tampering, source symlinks and runtime tampering are rejected", async () => {
  const w = await workspace();
  await build(w);
  const p = JSON.parse(
    await readFile(join(w, "output/project.data-studio.json")),
  );
  p.bundle.config.title = "Tampered";
  const path = join(w, "tampered.json");
  await writeFile(path, JSON.stringify(p));
  await assert.rejects(restore(path, join(w, "new")), /checksum/);
  const links = await workspace();
  const c = JSON.parse(await readFile(join(links, "analysis.json")));
  c.tables[0].file = "linked.csv";
  await writeFile(join(links, "analysis.json"), JSON.stringify(c));
  await symlink(
    join(links, "sources/transactions.csv"),
    join(links, "linked.csv"),
  );
  await assert.rejects(build(links), /symlinks/);
  const changed = await workspace();
  await writeFile(join(changed, "vendor/sqlite3.js"), "tampered");
  await assert.rejects(build(changed), /checksum mismatch/);
});
test("a nonterminating read-only query times out without replacing the last good project", async () => {
  const w = await workspace();
  await build(w);
  const before = sha(await readFile(join(w, "output/project.zip")));
  await writeFile(
    join(w, "queries/monthly.sql"),
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) AS total FROM n",
  );
  await assert.rejects(build(w), /20-second query budget/);
  assert.equal(sha(await readFile(join(w, "output/project.zip"))), before);
  assert.equal(
    JSON.parse(await readFile(join(w, ".harness/verdict.json"))).ready,
    false,
  );
});
