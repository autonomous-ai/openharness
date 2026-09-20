import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStudio } from "./serve.mjs";
import { unzip } from "./archive.mjs";
import {
  readSource,
  revision,
  runtimeRevision,
  snapshot,
  unchanged,
  savedProject,
  openProject,
  json,
  sha,
  metadata,
  atomic,
  verdict,
  safeFile,
  lock,
} from "./project.mjs";

export async function browserProof(workspace, options = {}) {
  const root = await realpath(resolve(workspace));
  return lock(root, async () => {
    const dir = await metadata(root);
    const receipt = {
      spec: 1,
      passed: false,
      at: new Date().toISOString(),
      errors: [],
      checks: [],
    };
    let server, browser;
    await verdict(
      root,
      "Checking the actual studio, interactions and downloads in Chromium.",
    );
    try {
      const source = await readSource(root),
        runtime = await snapshot(root),
        inputs = await snapshot(root, ["project.json", "automations.yaml"]);
      const built = JSON.parse(
        await safeFile(root, "output/results.json", 32 * 1024 * 1024),
      );
      const manifestBytes = await safeFile(root, "output/manifest.json");
      const manifest = JSON.parse(manifestBytes);
      assert.ok(
        built.passed && built.complete,
        "Build all scenarios before browser verification.",
      );
      assert.equal(built.sourceRevision, revision(source));
      assert.equal(built.runtimeRevision, runtimeRevision(runtime));
      for (const entry of manifest.files)
        assert.equal(
          sha(await safeFile(root, "output/" + entry.name, 32 * 1024 * 1024)),
          entry.sha256,
        );
      receipt.sourceRevision = built.sourceRevision;
      receipt.runtimeRevision = built.runtimeRevision;
      const modulePath =
        options.playwright ||
        process.env.PLAYWRIGHT_MODULE ||
        (process.env.HA_DSH_DIR &&
          join(
            process.env.HA_DSH_DIR,
            "node_modules/playwright-core/index.mjs",
          ));
      const { chromium } = await import(
        modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright-core"
      );
      server = await createStudio(root, options);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      browser = await chromium.launch({
        headless: true,
        ...(process.env.BROWSER_EXECUTABLE
          ? { executablePath: process.env.BROWSER_EXECUTABLE }
          : {}),
      });
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        acceptDownloads: true,
      });
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => receipt.errors.push(e.message));
      page.on("console", (e) => {
        if (e.type() === "error") receipt.errors.push(e.text());
      });
      page.on("dialog", (d) => d.accept());
      const base = "http://127.0.0.1:" + server.address().port;
      page.on("request", (r) => {
        if (!r.url().startsWith(base + "/") && !r.url().startsWith("blob:"))
          receipt.errors.push("Unexpected browser network request: " + r.url());
      });
      await page.goto(base);
      await page.waitForFunction(
        () =>
          document.querySelector("#source-status").textContent ===
          "Saved to this workspace",
      );
      assert.equal(await page.locator("#yaml").inputValue(), source.yaml);
      assert.equal(await page.locator("#export-zip").isDisabled(), true);
      await page
        .locator("#notes")
        .fill(
          (source.project.notes || "") + "\nBrowser check: draft round trip.",
        );
      await page.waitForFunction(
        () =>
          document.body.dataset.dirty === "true" &&
          document.querySelector("#source-revision").textContent.length > 12,
      );
      const draftDownload = page.waitForEvent("download");
      await page.locator("#download-project").click();
      const draft = JSON.parse(
        await readFile(await (await draftDownload).path()),
      );
      assert.equal(
        openProject(draft).project.notes,
        (source.project.notes || "") + "\nBrowser check: draft round trip.",
      );
      assert.notEqual(draft.revision, built.sourceRevision);
      await page.locator("#open-project").setInputFiles({
        name: "original.habitat.json",
        mimeType: "application/json",
        buffer: Buffer.from(json(savedProject(source))),
      });
      await page.waitForFunction(() => document.body.dataset.dirty === "false");
      assert.equal(await page.locator("#yaml").inputValue(), source.yaml);
      receipt.checks.push(
        "Edited notes, downloaded a checksummed draft and reopened the exact original source without saving.",
      );
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
      const positive = source.project.scenarios.find(
        (c) => c.expect.calls.length,
      );
      assert.ok(positive, "A meaningful delivery needs a positive scenario.");
      await page.locator('[data-scenario="' + positive.id + '"]').click();
      assert.equal(await page.locator("#result-badge").textContent(), "Passed");
      assert.ok(await page.locator(".actual-event.call").count());
      assert.ok(await page.locator(".trace-step").count());
      const traceDownload = page.waitForEvent("download");
      await page.locator("#download-trace").click();
      const trace = JSON.parse(
        await readFile(await (await traceDownload).path()),
      );
      assert.equal(trace.scenario, positive.id);
      assert.ok(trace.passed && trace.traces.length);
      receipt.checks.push(
        "Ran all cases through the browser; inspected actual calls and downloaded a native execution trace.",
      );
      const archiveDownload = page.waitForEvent("download");
      await page.locator("#export-zip").click();
      const bytes = await readFile(await (await archiveDownload).path());
      const files = unzip(bytes),
        entry = (name) => files.get(name);
      assert.equal(entry("automations.yaml")?.toString(), source.yaml);
      assert.equal(
        openProject(JSON.parse(entry("output/project.habitat.json"))).yaml,
        source.yaml,
      );
      assert.equal(
        JSON.parse(entry("output/results.json")).sourceRevision,
        built.sourceRevision,
      );
      assert.ok(
        entry("tools/engine.py") &&
          entry("tools/uv.lock") &&
          entry("PROJECT.md"),
      );
      receipt.download = {
        bytes: bytes.length,
        sha256: sha(bytes),
        files: files.size,
      };
      receipt.checks.push(
        "Downloaded and verified the real portable ZIP, editable source and source-bound evidence.",
      );
      receipt.screenshots = [];
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
          name + " has horizontal overflow",
        );
        const png = await page.screenshot({ fullPage: true });
        await atomic(join(dir, "browser-" + name + ".png"), png);
        receipt.screenshots.push({
          file: ".harness/browser-" + name + ".png",
          sha256: sha(png),
          width,
          height,
        });
      }
      await page
        .locator("#notes")
        .fill((source.project.notes || "") + "\nInvalidate this result.");
      await page.waitForFunction(() => document.body.dataset.ready === "false");
      assert.equal(await page.locator("#export-zip").isDisabled(), true);
      receipt.checks.push(
        "Desktop/mobile layout fits; a new edit invalidates checked exports.",
      );
      await unchanged(root, inputs);
      await unchanged(root, runtime);
      assert.equal(
        sha(await safeFile(root, "output/manifest.json")),
        sha(manifestBytes),
        "Delivery changed during browser proof.",
      );
      assert.deepEqual(receipt.errors, []);
      receipt.passed = true;
      await verdict(
        root,
        "Core scenarios, editable draft, native traces and portable download verified in Chromium. Hardware remains unverified.",
        {
          ready: true,
          sourceRevision: built.sourceRevision,
          runtimeRevision: built.runtimeRevision,
          findings: [{ severity: "info", kind: "scope", message: built.scope }],
        },
      );
    } catch (error) {
      receipt.errors.push(error.message);
      await verdict(
        root,
        "Browser verification failed; prior delivery preserved.",
        {
          findings: [
            { severity: "error", kind: "browser", message: error.message },
          ],
        },
      );
    } finally {
      if (browser) await browser.close();
      if (server) server.stop();
      await atomic(join(dir, "browser-proof.json"), json(receipt));
    }
    if (!receipt.passed) throw new Error(receipt.errors.join("\n"));
    return receipt;
  });
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    const receipt = await browserProof(process.argv[2] || process.cwd());
    console.log(
      "ok   " +
        receipt.checks.length +
        " browser workflow checks · .harness/browser-proof.json",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
