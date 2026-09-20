// Real-browser acceptance, not a DOM mock. Run with PLAYWRIGHT_MODULE pointing to
// playwright/index.mjs or playwright-core/index.mjs. All evidence stays outside source.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { build } from "../template/tools/build.mjs";
import { unzip } from "../template/tools/archive.mjs";
import { createPreview } from "../template/tools/serve.mjs";
import { createHtmlViewer } from "../../../viewers/isolated-web-viewer/viewer.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
    : "playwright"
);
const root = fileURLToPath(new URL("../", import.meta.url)),
  evidence = process.env.DATA_EVIDENCE_DIR
    ? resolve(process.env.DATA_EVIDENCE_DIR)
    : await mkdtemp(join(tmpdir(), "data-browser-"));
await mkdir(evidence, { recursive: true });
const sales = join(evidence, "sales"),
  delivery = join(evidence, "delivery");
await cp(join(root, "template"), sales, { recursive: true });
await cp(join(root, "template"), delivery, { recursive: true });
await cp(join(root, "test/fixtures/delivery"), delivery, { recursive: true });
for (const w of [sales, delivery]) await build(w);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : {}),
});
const receipts = [];
async function context(workspace, direct, run) {
  const server = await (direct
    ? createPreview(workspace)
    : createHtmlViewer(workspace));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url =
    "http://127.0.0.1:" +
    server.address().port +
    (direct ? server.previewPrefix : "/");
  const page = await browser.newPage({
      viewport: { width: 1560, height: 1100 },
      acceptDownloads: true,
    }),
    errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith("http://127.0.0.1:"))
      external.push(r.url());
  });
  try {
    await page.goto(url);
    const f = direct ? page : page.frameLocator("#preview");
    await f.locator("body[data-ready=true]").waitFor({ timeout: 30000 });
    try {
      await run(page, f);
    } catch (error) {
      console.error(
        "Browser status:",
        await f.locator("#status").textContent(),
      );
      throw error;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    receipts.push({ workspace, direct, errors, external });
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
async function download(page, locator, name) {
  const wait = page.waitForEvent("download");
  await locator.click();
  const file = await wait,
    path = join(evidence, name);
  await file.saveAs(path);
  return path;
}
async function settled(f) {
  await f.locator("body[data-busy=false]").waitFor({ timeout: 30000 });
}
try {
  await context(sales, false, async (page, f) => {
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$238.00",
    );
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "sales-initial.png") });
    await f.locator('[data-category="Outdoor"]').focus();
    await page.keyboard.press("Enter");
    await f.locator('#row-count[data-count="8"]').waitFor();
    await f.locator('.source-link[data-table="transactions"]').first().click();
    assert.match(await f.locator("#raw-record").textContent(), /00005/);
    const rawCsv = await download(
      page,
      f.locator("#download-source"),
      "sales-original-transactions.csv",
    );
    assert.deepEqual(
      await readFile(rawCsv),
      await readFile(join(sales, "sources/transactions.csv")),
    );
    await f.locator("#close-source").click();
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "sales-evidence.png") });
    await f.locator("#reset-trace").click();
    await f.locator('#row-count[data-count="24"]').waitFor();
    await f.locator("#param-region").selectOption("West");
    await f.locator("#apply-controls").click();
    await settled(f);
    assert.equal(
      await f.locator('[data-metric="baseline_sales"] strong').textContent(),
      "$2,583.50",
    );
    assert.equal(
      await f.locator("#row-count").getAttribute("data-count"),
      "12",
    );
    await f.locator("#param-region").selectOption("");
    await f.locator("#apply-controls").click();
    await settled(f);
    await f.locator('[data-query="monthly"]').click();
    await f.locator("#calculation summary").click();
    const original = await f.locator("#sql").inputValue();
    await f
      .locator("#sql")
      .fill(
        original.replace(
          "WHERE status='completed'",
          "WHERE status='completed' AND quantity>=15",
        ),
      );
    await f.locator("#run-sql").click();
    await settled(f);
    assert.match(
      await f.locator("#query-explanation").textContent(),
      /Edited query/,
    );
    const revised = await download(
      page,
      f.locator("#export-json"),
      "sales-revised-query.json",
    );
    const revisedRows = JSON.parse(await readFile(revised)).rows;
    assert.equal(revisedRows.length, 2);
    await f.locator("#sql").fill("DROP TABLE transactions");
    await f.locator("#run-sql").click();
    await settled(f);
    assert.match(
      await f.locator("#status").textContent(),
      /Last good analysis/,
    );
    await f.locator('[data-source="transactions"]').click();
    const input = await readFile(
      join(sales, "sources/transactions.csv"),
      "utf8",
    );
    const changed = join(evidence, "revised-transactions.csv");
    await writeFile(changed, input.replace(",12,38.00,", ",12,40.00,"));
    await f.locator("#replace-source").setInputFiles(changed);
    await settled(f);
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$262.00",
    );
    await f.locator("#close-source").click();
    await f.locator('[data-source="products"]').click();
    const duplicate = join(evidence, "bad-products.csv");
    await writeFile(
      duplicate,
      (await readFile(join(sales, "sources/products.csv"), "utf8")) +
        "001,Duplicate,Home\n",
    );
    await f.locator("#replace-source").setInputFiles(duplicate);
    await settled(f);
    assert.match(await f.locator("#status").textContent(), /duplicate key/);
    await f.locator("#close-source").click();
    await f
      .locator("#notes")
      .fill(
        "Synthetic acceptance review: changed the first unit price and restricted the monthly query to lines with at least 15 units.",
      );
    const saved = await download(
      page,
      f.locator("#save-project"),
      "sales-saved.data-studio.json",
    );
    await download(page, f.locator("#export-db"), "sales-browser.sqlite");
    await download(page, f.locator("#export-report"), "sales-report.html");
    await download(page, f.locator("#export-csv"), "sales-revised-query.csv");
    await download(page, f.locator("#export-json"), "sales-current-query.json");
    await download(page, f.locator("#portable"), "sales-original.zip");
    await f.locator("#notes").fill("not saved");
    await f.locator("#open-project").setInputFiles(saved);
    await settled(f);
    assert.match(
      await f.locator("#notes").inputValue(),
      /restricted the monthly/,
    );
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$262.00",
    );
    const p = JSON.parse(await readFile(saved));
    p.revision = "0".repeat(64);
    const corrupt = join(evidence, "corrupt.json");
    await writeFile(corrupt, JSON.stringify(p));
    await f.locator("#open-project").setInputFiles(corrupt);
    await f
      .locator("#status")
      .filter({ hasText: "checksum mismatch" })
      .waitFor();
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$262.00",
    );
    await f.locator("#param-baseline").fill("2027-01-01");
    // Long SQL must neither freeze the page nor replace the last good result.
    if (!(await f.locator("#sql").isVisible()))
      await f.locator("#calculation summary").click();
    await f
      .locator("#sql")
      .fill(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) AS total FROM n",
      );
    await f.locator("#run-sql").click();
    await f.locator("#cancel-run").waitFor();
    const frames = await f.locator("body").evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const start = performance.now();
          const tick = () => {
            if (++n === 5)
              resolve({ frames: n, ms: performance.now() - start });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    assert.equal(frames.frames, 5);
    assert.ok(frames.ms < 2000);
    await f.locator("#cancel-run").click();
    await settled(f);
    assert.match(await f.locator("#status").textContent(), /cancelled/);
    await f.locator("#run-sql").click();
    await settled(f);
    assert.match(
      await f.locator("#status").textContent(),
      /20-second query budget/,
    );
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$262.00",
    );
    await f.locator("#param-comparison").fill("2027-02-01");
    await f.locator("#apply-controls").click();
    await settled(f);
    await f.locator('[data-query="contribution"]').click();
    assert.equal(await f.locator("#row-count").getAttribute("data-count"), "0");
    assert.equal(
      await f.locator('[data-metric="growth"] strong').textContent(),
      "Missing",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await f
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "sales-mobile.png") });
  });
  const downloaded = JSON.parse(
      await readFile(join(evidence, "sales-saved.data-studio.json")),
    ),
    db = new DatabaseSync(join(evidence, "sales-browser.sqlite"), {
      readOnly: true,
    });
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(
    db
      .prepare("SELECT unit_price_cents FROM transactions WHERE _record=2")
      .get().unit_price_cents,
    4000,
  );
  const stmt = db.prepare(downloaded.bundle.sql["queries/monthly.sql"]);
  assert.deepEqual(
    stmt.all({ ":region": "" }).map((row) => Object.values(row)),
    JSON.parse(await readFile(join(evidence, "sales-current-query.json"))).rows,
  );
  db.close();
  const restored = join(evidence, "restored-browser-project");
  const restore = spawnSync(
    process.execPath,
    [
      join(sales, "tools/restore.mjs"),
      join(evidence, "sales-saved.data-studio.json"),
      restored,
    ],
    { encoding: "utf8" },
  );
  assert.equal(restore.status, 0, restore.stderr);
  const rebuilt = await build(restored);
  assert.equal(rebuilt.revision, downloaded.revision);
  await context(restored, true, async (page, f) => {
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$262.00",
    );
    assert.match(
      await f.locator("#notes").inputValue(),
      /restricted the monthly/,
    );
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "restored-browser-project.png") });
  });
  const extracted = join(evidence, "extracted-zip");
  for (const [name, bytes] of unzip(
    await readFile(join(evidence, "sales-original.zip")),
  )) {
    await mkdir(dirname(join(extracted, name)), { recursive: true });
    await writeFile(join(extracted, name), bytes);
  }
  await build(extracted);
  await context(extracted, true, async (page, f) => {
    assert.equal(
      await f.locator('[data-metric="change"] strong').textContent(),
      "-$238.00",
    );
    await f.locator('[data-category="Creative"]').click();
    await f.locator('#row-count[data-count="8"]').waitFor();
    await download(page, f.locator("#export-db"), "portable.sqlite");
  });
  await context(delivery, false, async (page, f) => {
    assert.equal(
      await f.locator('[data-metric="on_time_rate"] strong').textContent(),
      "46.7%",
    );
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "delivery-initial.png") });
    await f.locator('[data-category="Highlands"]').click();
    await f.locator('#row-count[data-count="6"]').waitFor();
    assert.match(await f.locator("#result-table").textContent(), /Missing/);
    await f.locator('[data-source="shipments"]').click();
    const revised = join(evidence, "revised-shipments.csv");
    await writeFile(
      revised,
      (await readFile(join(delivery, "sources/shipments.csv"), "utf8")).replace(
        "0017,02,2026-04-19,,1",
        "0017,02,2026-04-19,2026-04-19,1",
      ),
    );
    await f.locator("#replace-source").setInputFiles(revised);
    await settled(f);
    await f.locator("#close-source").click();
    assert.equal(
      await f.locator('[data-metric="on_time_rate"] strong').textContent(),
      "50.0%",
    );
    await download(
      page,
      f.locator("#save-project"),
      "delivery-saved.data-studio.json",
    );
    await download(page, f.locator("#export-db"), "delivery-browser.sqlite");
    await download(page, f.locator("#export-report"), "delivery-report.html");
    await f.locator("#param-as_of").fill("2026-04-01");
    await f.locator("#apply-controls").click();
    await settled(f);
    assert.equal(
      await f.locator('[data-metric="on_time_rate"] strong').textContent(),
      "Missing",
    );
    await f.locator('[data-query="routes_summary"]').click();
    assert.equal(await f.locator(".null-bar").count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await f
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await f
      .locator("body")
      .screenshot({ path: join(evidence, "delivery-mobile.png") });
  });
  await writeFile(
    join(evidence, "browser-receipt.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        contexts: receipts,
        checks: [
          "native/browser equality",
          "keyboard drilldown",
          "raw CSV download is byte-identical",
          "cancel and timeout preserve good results",
          "page remains responsive during long SQL",
          "raw source records",
          "controls",
          "SQL revision",
          "invalid SQL preserves good result",
          "valid CSV revision",
          "duplicate CSV rejection",
          "all downloads",
          "project reopen",
          "checksum rejection",
          "empty/missing states",
          "390px layout",
          "native reopen of browser SQLite",
          "JSON restore + rebuild",
          "ZIP extraction + rebuild",
          "standalone CSP",
          "second independent schema + revision",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ evidence, contexts: receipts.length, passed: true }),
  );
} finally {
  await browser.close();
}
