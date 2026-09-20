// Actual native-engine/browser acceptance. Generated evidence stays outside source.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./helpers.mjs";
import { createStudio } from "../template/tools/serve.mjs";
import { build } from "../template/tools/build.mjs";
import { browserProof } from "../template/tools/proof.mjs";
import { restore } from "../template/tools/restore.mjs";
import { unzip } from "../template/tools/archive.mjs";
import {
  readSource,
  savedProject,
  openProject,
  revision,
  json,
  sha,
  SOURCE_NAMES,
  RUNTIME_NAMES,
} from "../template/tools/project.mjs";

const parent = process.env.HA_EVIDENCE_DIR
  ? resolve(process.env.HA_EVIDENCE_DIR)
  : tmpdir();
await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(join(parent, "habitat-acceptance-"));
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
    : "playwright-core"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : {}),
});
const receipts = [];
function revised(source, fixture) {
  const value = structuredClone(source);
  if (fixture === "hallway") {
    value.yaml = value.yaml
      .replace("seconds: 120", "seconds: 180")
      .replace("two-minute vacancy", "three-minute vacancy");
    value.project.brief = value.project.brief.replace(
      "two clear minutes",
      "three clear minutes",
    );
    for (const c of value.project.scenarios) {
      c.why = c.why.replace("two minutes", "three minutes");
      c.until += 60;
      for (const call of c.expect.calls)
        if (call.service === "light.turn_off")
          call.between = call.between.map((n) => n + 60);
    }
    value.project.notes +=
      "\nRevision: allow three minutes of clear hallway before switching off; manual hold still wins.";
  } else {
    value.yaml = value.yaml
      .replace("seconds: 300", "seconds: 180")
      .replace("five minutes", "three minutes");
    value.project.brief = value.project.brief
      .replaceAll("five minutes", "three minutes")
      .replaceAll("five-minute", "three-minute");
    for (const c of value.project.scenarios)
      for (const call of c.expect.calls) {
        if (call.service !== "input_boolean.turn_on")
          call.between = call.between.map((n) => n - 120);
        if (call.data?.message)
          call.data.message = call.data.message.replace(
            "five minutes",
            "three minutes",
          );
      }
    value.project.notes +=
      "\nRevision: require three sustained low-power minutes; ignore the two-minute wash pause.";
  }
  return value;
}
async function download(page, selector, name) {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const file = await pending,
    path = join(evidence, name);
  await file.saveAs(path);
  return path;
}
async function testAll(page) {
  await page.locator("#run-all").click();
  await page.waitForFunction(() => document.body.dataset.busy === "true");
  await page.waitForFunction(
    () => document.body.dataset.busy === "false",
    null,
    { timeout: 195000 },
  );
  assert.equal(
    await page.locator("body").getAttribute("data-ready"),
    "true",
    await page.locator("#status").textContent(),
  );
}
try {
  for (const fixture of ["hallway", "laundry"]) {
    console.log("workflow " + fixture);
    const root = join(evidence, fixture);
    await cp(join(packageRoot, "template"), root, { recursive: true });
    if (fixture === "laundry")
      await cp(join(packageRoot, "test/fixtures/laundry"), root, {
        recursive: true,
      });
    await writeFile(
      join(root, "secrets.yaml"),
      "EXAMPLE PRIVATE FILE — not an export input",
    );
    const original = await readSource(root),
      changed = revised(original, fixture);
    const originalBuild = await build(root);
    const server = await createStudio(root);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        acceptDownloads: true,
      }),
      errors = [],
      external = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    page.on("request", (r) => {
      if (/^https?:/.test(r.url()) && !r.url().startsWith("http://127.0.0.1:"))
        external.push(r.url());
    });
    const base = "http://127.0.0.1:" + server.address().port;
    try {
      await page.goto(base);
      await page.waitForFunction(
        () =>
          document.querySelector("#source-status").textContent ===
          "Saved to this workspace",
      );
      await testAll(page);
      if (fixture === "hallway") {
        await page.locator('[data-scenario="normal-evening"]').focus();
        await page.keyboard.press("ArrowDown");
        assert.equal(
          await page.evaluate(() => document.activeElement.dataset.scenario),
          "quiet-hours",
        );
        await page.keyboard.press("ArrowUp");
        assert.equal(
          await page.evaluate(() => document.activeElement.dataset.scenario),
          "normal-evening",
        );
        await page.locator('[data-scenario="quiet-hours"]').click();
        assert.match(
          await page.locator("#actual-timeline").textContent(),
          /brightness_pct.*12/,
        );
        await page.locator('[data-scenario="normal-evening"]').click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: join(evidence, "hallway-starter.jpg"),
          type: "jpeg",
          quality: 85,
        });
      }
      // A malformed model is rejected before replacing any part of the draft.
      await page
        .locator("#project-json")
        .evaluate((el) => (el.closest("details").open = true));
      const bad = structuredClone(original.project);
      bad.entities[0] = null;
      await page.locator("#project-json").fill(json(bad));
      assert.equal(await page.locator("#notes").isDisabled(), true);
      assert.equal(await page.locator("#yaml").isDisabled(), true);
      await page.locator("#apply-project").click();
      assert.match(
        await page.locator("#status").textContent(),
        /Declare 1–100 entities/,
      );
      assert.equal(
        await page.locator("#title").textContent(),
        original.project.title,
      );
      await page.locator("#discard-project").click();
      const hostile = structuredClone(original.project);
      hostile.title = '<img src=x onerror="window.pwned=1">';
      await page.locator("#project-json").fill(json(hostile));
      await page.locator("#apply-project").click();
      assert.equal(await page.locator("#title").textContent(), hostile.title);
      assert.equal(await page.evaluate(() => window.pwned), undefined);
      assert.equal(await page.locator("img").count(), 1);
      await page.locator("#project-json").fill(json(original.project));
      await page.locator("#apply-project").click();
      // Revision semantics are fixed above from the new brief. Old assertions
      // must fail first; only then apply the matching new test plan.
      await page.locator("#yaml").fill(changed.yaml);
      await page.locator("#run-case").click();
      await page.waitForFunction(() => document.body.dataset.busy === "true");
      await page.waitForFunction(
        () => document.body.dataset.busy === "false",
        null,
        { timeout: 35000 },
      );
      assert.equal(
        await page.locator("#result-badge").textContent(),
        "Needs attention",
      );
      assert.equal(await page.locator("#export-zip").isDisabled(), true);
      await page.locator("#project-json").fill(json(changed.project));
      await page.locator("#apply-project").click();
      await testAll(page);
      await page.locator("#save").click();
      await page.waitForFunction(() => document.body.dataset.dirty === "false");
      assert.deepEqual(await readSource(root), changed);
      const draft = await download(
        page,
        "#download-project",
        fixture + "-revised.habitat.json",
      );
      assert.deepEqual(openProject(JSON.parse(await readFile(draft))), changed);
      const archivePath = await download(
        page,
        "#export-zip",
        fixture + "-revised.zip",
      );
      const archive = unzip(await readFile(archivePath));
      assert.equal(archive.has("secrets.yaml"), false);
      assert.ok(
        ![...archive.keys()].some(
          (n) =>
            n.includes(".harness/") ||
            n.includes("node_modules") ||
            n.includes(".runtime/"),
        ),
      );
      assert.equal(archive.get("automations.yaml").toString(), changed.yaml);
      const manifest = JSON.parse(archive.get("output/manifest.json"));
      for (const file of manifest.files)
        assert.equal(sha(archive.get("output/" + file.name)), file.sha256);
      await download(
        page,
        '[data-export="report.html"]',
        fixture + "-report.html",
      );
      await download(
        page,
        '[data-export="results.json"]',
        fixture + "-results.json",
      );
      const tracePath = await download(
        page,
        "#download-trace",
        fixture + "-trace.json",
      );
      assert.ok(JSON.parse(await readFile(tracePath)).traces.length);
      for (const [name, width, height] of [
        ["desktop", 1600, 1000],
        ["mobile", 390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: join(evidence, fixture + "-" + name + ".png"),
          fullPage: true,
        });
      }
      // Reopen the actual browser downloads, never a manually reconstructed copy.
      const jsonRoot = join(evidence, fixture + "-json-reopened");
      await restore(draft, jsonRoot, root);
      const jsonResult = await build(jsonRoot);
      assert.ok(jsonResult.passed);
      assert.deepEqual(await readSource(jsonRoot), changed);
      const zipRoot = join(evidence, fixture + "-zip-reopened");
      await mkdir(zipRoot);
      const allowed = new Set([
        ...SOURCE_NAMES,
        ...RUNTIME_NAMES,
        ...manifest.files.map((f) => "output/" + f.name),
        "output/manifest.json",
      ]);
      for (const [name, bytes] of archive) {
        assert.ok(allowed.has(name), "Unplanned ZIP file " + name);
        const path = join(zipRoot, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { flag: "wx" });
      }
      const zipResult = await build(zipRoot);
      assert.ok(zipResult.passed);
      assert.deepEqual(await readSource(zipRoot), changed);
      const reopenedServer = await createStudio(zipRoot);
      reopenedServer.listen(0, "127.0.0.1");
      await once(reopenedServer, "listening");
      const reopenedPage = await browser.newPage();
      try {
        await reopenedPage.goto(
          "http://127.0.0.1:" + reopenedServer.address().port,
        );
        await reopenedPage.waitForFunction(
          () =>
            document.querySelector("#source-status").textContent ===
            "Saved to this workspace",
        );
        assert.equal(
          await reopenedPage.locator("#yaml").inputValue(),
          changed.yaml,
        );
        assert.equal(
          await reopenedPage.locator("#export-zip").isDisabled(),
          true,
          "Reopened evidence is not a fresh export authorization",
        );
      } finally {
        await reopenedPage.close();
        reopenedServer.stop();
      }
      const revisedBuild = await build(root);
      receipts.push({
        fixture,
        originalRevision: originalBuild.sourceRevision,
        revisedRevision: revisedBuild.sourceRevision,
        scenarios: revisedBuild.results.length,
        originalPassed: originalBuild.passed,
        revisedPassed: revisedBuild.passed,
        savedJSON: draft,
        zip: archivePath,
        source: root,
        jsonReopened: jsonRoot,
        zipReopened: zipRoot,
        checks: [
          "native original",
          "stale assertions fail",
          "native revision",
          "browser edit/save/download",
          "exact ZIP manifest",
          "JSON restore/rebuild",
          "ZIP restore/rebuild",
          "fresh browser reopen",
          "desktop/mobile",
        ],
        errors,
        external,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await page.close();
      server.stop();
    }
    console.log(
      "verified " +
        fixture +
        " original → revision → browser downloads → fresh JSON/ZIP rebuilds",
    );
  }
  // Exercise the user-facing ready verdict path on the final hallway revision.
  const proof = await browserProof(receipts[0].source);
  await writeFile(
    join(evidence, "acceptance.json"),
    json({
      spec: 1,
      at: new Date().toISOString(),
      core: "2026.9.3",
      fixtures: receipts,
      browserProof: proof,
    }),
  );
  console.log("EVIDENCE " + evidence);
} finally {
  await browser.close();
}
