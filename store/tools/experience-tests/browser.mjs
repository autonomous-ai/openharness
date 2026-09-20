// Real browser checks through the branch viewer, using manifests and materialized workspaces.
// npm install in this directory, then npm run browser. See README.md for system Chrome options.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHtmlViewer } from "../../viewers/web-viewer/viewer.mjs";
import { experiences } from "../build-experiences.mjs";
import { musicBrowser } from "./music-browser.mjs";
import { brandBrowser } from "../../agents/creative-direction/test/browser.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(
  process.env.EXPERIENCE_OUTPUT || join(repo, "work/experience-evidence"),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
  headless: true,
  args:
    process.env.SOFTWARE_WEBGL === "1"
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : [],
});
const results = [];
async function serverFor(workspace) {
  const server = await createHtmlViewer(workspace);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
async function download(page, click, name) {
  const pending = page.waitForEvent("download");
  await click();
  const d = await pending;
  assert.equal(await d.failure(), null);
  const path = join(output, name || d.suggestedFilename());
  await d.saveAs(path);
  return readFile(path);
}
const frameOf = (page) =>
  page.frames().find((f) => f.url().includes("/files/"));
async function waitReady(page) {
  await page
    .frameLocator("#preview")
    .locator('body[data-ready="true"]')
    .waitFor();
  return frameOf(page);
}
async function visibleScreenshot(page, name) {
  const f = frameOf(page);
  if (f) await f.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(output, name + ".png"), fullPage: true });
}

async function shellRegression() {
  const ws = await mkdtemp(join(tmpdir(), "experience-shell-"));
  await mkdir(join(ws, "nested"));
  await writeFile(
    join(ws, "nested/data.json"),
    JSON.stringify({ message: "FETCH-OK" }),
  );
  await writeFile(
    join(ws, "nested/module.js"),
    'document.querySelector("#module").textContent="MODULE-OK";',
  );
  await writeFile(
    join(ws, "nested/index.html"),
    `<!doctype html><title>Regression</title><p id="fetch"></p><p id="storage"></p><p id="module"></p><script>fetch('data.json').then(r=>r.json()).then(d=>document.querySelector('#fetch').textContent=d.message);localStorage.setItem('viewer-check','STORAGE-OK');document.querySelector('#storage').textContent=localStorage.getItem('viewer-check');</script><script type="module" src="module.js"></script>`,
  );
  const { server, base } = await serverFor(ws),
    page = await browser.newPage();
  try {
    await page.goto(base + "/?file=nested/index.html");
    const f = page.frameLocator("#preview");
    await f.getByText("FETCH-OK").waitFor();
    await f.getByText("STORAGE-OK").waitFor();
    await f.getByText("MODULE-OK").waitFor();
    await page.goto(base + "/?file=later.html");
    await page.getByText("Waiting for your artifact").waitFor();
    await writeFile(join(ws, "later.html"), "<h1>Now created</h1>");
    await page.frameLocator("#preview").getByText("Now created").waitFor();
    results.push({
      name: "viewer-regressions",
      ok: true,
      checks: [
        "sibling fetch",
        "localStorage",
        "ES module",
        "missing artifact recovery",
      ],
    });
  } finally {
    await page.close();
    await closeServer(server);
    await rm(ws, { recursive: true, force: true });
  }
}

async function one(exp) {
  if (exp.id === 'voxel-worlds') {
    const result = execFileSync(process.execPath, [join(repo, 'store/agents/voxel-worlds/test/browser.mjs')], { env: { ...process.env, VOXEL_QA_ROOT: join(output, 'tidelands-browser') }, encoding: 'utf8', timeout: 180000 });
    results.push({ id: exp.id, ...JSON.parse(result.trim()) });
    return;
  }
  if (exp.id === 'creative-direction') {
    results.push(await brandBrowser({ browser, output }));
    return;
  }
  const root = join(repo, "store/agents", exp.id),
    manifest = JSON.parse(await readFile(join(root, "harness.json"), "utf8"));
  const ws = await mkdtemp(join(tmpdir(), "experience-" + exp.id + "-"));
  await cp(join(root, "template"), ws, { recursive: true });
  execFileSync(join(root, manifest.workspace.init), {
    cwd: ws,
    env: {
      ...process.env,
      HARNESS_DSH: manifest.id,
      HARNESS_DSH_DIR: root,
      HARNESS_WORKSPACE: ws,
    },
  });
  const { server, base } = await serverFor(ws),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      reducedMotion: "reduce",
      acceptDownloads: true,
    }),
    page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const checks = [];
  const artifact = exp.path + "/index.html";
  const url =
    manifest.viewer.url
      .replace("${port}", new URL(base).port)
      .replace(
        "${artifact}",
        artifact.split("/").map(encodeURIComponent).join("/"),
      ) + "&seed=42";
  try {
    await page.goto(url);
    let f = await waitReady(page);
    checks.push("manifest launch");
    await visibleScreenshot(page, exp.id + "-initial");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await f.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const showcase = join(repo, "store/showcase", exp.id);
    await mkdir(showcase, { recursive: true });
    await page.screenshot({
      path: join(showcase, "starter.jpg"),
      type: "jpeg",
      quality: 80,
    });
    await page.setViewportSize({ width: 1440, height: 1050 });

    assert.equal(await page.locator("#empty").isHidden(), true);
    if (exp.id === "generative-art") {
      const original = await f.evaluate(() => fieldwork.getSVG());
      await f.locator("#next-seed").click();
      await f.waitForFunction(before => fieldwork.getSVG() !== before, original);
      await f.locator("#seed").fill("42");
      await f.locator("#seed-form button[type=submit]").click();
      await f.waitForFunction(before => fieldwork.getSVG() === before, original);
      await f.locator("#control-headline").fill("USER & STUDIO");
      await f.waitForFunction(() => fieldwork.getSVG().includes('USER &amp;'));
      await f.locator("#undo").click();
      await f.waitForFunction(before => fieldwork.getSVG() === before, original);
      await f.locator("#redo").click();
      await f.waitForFunction(() => fieldwork.getSVG().includes('USER &amp;'));
      await f.locator('#formats button').nth(2).click();
      await f.waitForFunction(() => fieldwork.getSVG().includes('width="1920" height="800"'));
      const bytes = await download(page, () => f.locator("#export-png").click(), "fieldwork-banner.png");
      assert.equal(bytes.readUInt32BE(16), 1920); assert.equal(bytes.readUInt32BE(20), 800);
      await f.locator('input[type=file][aria-label="Your logo (optional)"]').setInputFiles(join(root, 'brand/icon.png'));
      await f.waitForFunction(() => fieldwork.getSVG().includes('data:image/png;base64,'));
      const saved = JSON.parse((await download(page, () => f.locator('#save-project').click(), 'fieldwork-project.json')).toString());
      assert.equal(saved.controls.find(c => c.key === 'headline').value, 'USER & STUDIO');
      assert.ok(saved.assets[0].data.startsWith('data:image/png;base64,'));
      await download(page, () => f.locator('#export-kit').click(), 'fieldwork-kit.zip');
      const kit = JSON.parse(execFileSync('python3', ['-c', `import sys,json,zipfile,struct
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert len([n for n in z.namelist() if n.endswith('.svg')])==3
 assert len([n for n in z.namelist() if n.endswith('.png')])==3
 assert b'USER &amp;' in z.read('03-Banner.svg')
 assert struct.unpack('>II',z.read('03-Banner.png')[16:24])==(1920,800)
 print(json.dumps(z.namelist()))`, join(output, 'fieldwork-kit.zip')], {encoding:'utf8'}));
      assert.ok(kit.includes('source/artwork.js'));
      await download(page, () => f.locator('#export-html').click(), 'fieldwork-portable.html');
      const portable = await context.newPage();
      await portable.goto(new URL('file://' + join(output, 'fieldwork-portable.html')).href);
      await portable.locator('body[data-ready=true]').waitFor();
      assert.equal(await portable.locator('#control-headline').inputValue(), 'USER & STUDIO');
      await portable.close();
      await f.locator('#reset-project').click();
      await f.waitForFunction(before => fieldwork.getSVG() === before, original);
      await f.locator('#project-file').setInputFiles(join(output, 'fieldwork-project.json'));
      await f.waitForFunction(() => fieldwork.getSVG().includes('USER &amp;'));
      assert.equal(await f.locator('#width').inputValue(), '1920');
      // A user-approved draft and a new agent revision must both remain recoverable.
      const projectPath = join(ws, 'sketch/project.json');
      const revision = JSON.parse(await readFile(projectPath, 'utf8'));
      revision.controls.find(c => c.key === 'headline').value = 'AGENT REVISION';
      await writeFile(projectPath, JSON.stringify(revision));
      execFileSync(process.execPath, [join(ws, 'tools/build.mjs')]);
      await page.frameLocator('#preview').locator('#revision-notice:not([hidden])').waitFor();
      f = frameOf(page);
      await f.locator('#keep-draft').click();
      await f.waitForFunction(() => fieldwork.getSVG().includes('USER &amp;'));
      await f.locator('#reset-project').click();
      await f.waitForFunction(() => fieldwork.getSVG().includes('AGENT'));
      checks.push('same-seed geometry', 'original editable text', 'undo/redo', 'adaptive formats', 'own image import', 'editable SVG/PNG kit reopened by Python', 'portable HTML reopened', 'project roundtrip', 'agent revision preserves user draft');
    } else if (exp.id === "lab-bench") {
      assert.equal(await f.locator("#sample-count").textContent(), "120");
      await f.locator("#control").click();
      assert.equal(await f.locator("#sample-count").textContent(), "60");
      const csv = (
        await download(
          page,
          () => f.locator("#export-csv").click(),
          "signal-observations.csv",
        )
      ).toString();
      assert.equal(csv.trim().split("\n").length, 61);
      await f.locator("#control").click();
      await f.locator("#effect").fill("-20");
      await f.locator("#effect").dispatchEvent("input");
      assert.match(await f.locator("#conclusion").textContent(), /reduces/);
      await f.locator("#effect").fill("12");
      await f.locator("#effect").dispatchEvent("input");
      await f.locator("#run").click();
      await f.waitForFunction(
        () => document.querySelector("#sample-count").textContent === "120",
      );
      checks.push(
        "cohort filters",
        "statistics respond to effect",
        "collection replay",
        "filtered CSV",
      );
    } else if (exp.id === "music-studio") {
      f = await musicBrowser({ page, context, f, ws, output, download, frameOf, checks });
    } else if (exp.id === "game-master") {
      await f.locator("#step").click();
      assert.match(await f.locator("#turn").textContent(), /01/);
      await f.locator("#timeline").fill("72");
      await f.locator("#timeline").dispatchEvent("input");
      assert.match(await f.locator("#match-state").textContent(), /WINS|DRAW/);
      await f.locator("#rewind").click();
      assert.match(await f.locator("#turn").textContent(), /00/);
      await f.locator("#tournament").click();
      await f.waitForFunction(() =>
        document
          .querySelector("#tournament-result")
          .textContent.includes("Mean Ember margin"),
      );
      const replay = JSON.parse(
        (
          await download(
            page,
            () => f.locator("#export-replay").click(),
            "relay-replay.json",
          )
        ).toString(),
      );
      assert.equal(replay.history.length, 73);
      checks.push(
        "step/rewind/scrub",
        "finite outcome",
        "32-match tournament",
        "replay export",
      );
    } else if (exp.id === "drone-pilot") {
      await f.locator("#start-flight").click();
      await f.waitForFunction(() => state.z > 8);
      await f.locator("#manual").click();
      const before = await f.evaluate(() => state.x);
      await f.locator("#flight").focus();
      await page.keyboard.down("d");
      await f.waitForFunction((x) => state.x > x + 2, before);
      await page.keyboard.up("d");
      await f.locator("#start-flight").click();
      const telemetry = JSON.parse(
        (
          await download(
            page,
            () => f.locator("#export-flight").click(),
            "vector-telemetry.json",
          )
        ).toString(),
      );
      assert.ok(telemetry.telemetry.length > 1);
      await f.locator("#reset-flight").click();
      assert.equal(await f.evaluate(() => state.z), 0);
      checks.push(
        "autopilot motion",
        "manual steering",
        "telemetry export",
        "reset",
      );
    } else if (exp.id === "voxel-worlds") {
      await f.locator("#world").click();
      await f.waitForFunction(
        () => document.pointerLockElement?.id === "world",
      );
      await f.evaluate(() => document.exitPointerLock());
      const before = await f.evaluate(() => ({ x: player.x, z: player.z }));
      await f.locator("#world").focus();
      await page.keyboard.down("w");
      await f.waitForFunction(
        (p) => Math.hypot(player.x - p.x, player.z - p.z) > 1,
        before,
      );
      await page.keyboard.up("w");
      // Look at the actual ground from the player camera, then exercise the user buttons.
      await f.evaluate(() => {
        player.pitch = -0.65;
        drawWorld();
      });
      await f.waitForFunction(() => targetBlock && targetBlock.y > 0);
      const edits = await f.evaluate(() => edited);
      await f.locator("#place").click();
      assert.equal(await f.evaluate(() => edited), edits + 1);
      await f.locator("#break").click();
      assert.equal(await f.evaluate(() => edited), edits + 2);
      const bytes = await download(
        page,
        () => f.locator("#export-world").click(),
        "tidelands-world.json",
      );
      assert.equal(JSON.parse(bytes.toString()).blocks.length, 48 * 28 * 48);
      await f.locator("#world-file").setInputFiles({
        name: "saved-world.json",
        mimeType: "application/json",
        buffer: bytes,
      });
      await f.getByText("Your world is restored.").waitFor();
      await f.locator("#home").click();
      await f.locator("#overview").click();
      await visibleScreenshot(page, "voxel-worlds-overview");
      await f.locator("#overview").click();
      checks.push(
        "pointer lock",
        "walk and collide",
        "break/place blocks",
        "world save/restore",
        "overview",
      );
    }
    await visibleScreenshot(page, exp.id + "-desktop");
    if (exp.id !== "music-studio") {
    // Seed changes propagate to the shell and survive a real reload.
    await f.locator("#seed").fill("73");
    await f.locator("#seed-form button[type=submit]").click();
    await page.waitForFunction(
      () => new URL(location.href).searchParams.get("seed") === "73",
    );
    const before = await page.locator("#preview").getAttribute("src");
    await page.locator("#reload").click();
    await page.waitForFunction(
      (src) => document.querySelector("#preview").src !== src,
      new URL(before, base).href,
    );
    f = await waitReady(page);
    assert.equal(await f.locator("#seed").inputValue(), "73");
    checks.push("seed survives reload");
    } else {
      await page.locator("#reload").click();
      f = await waitReady(page);
      assert.equal(await f.locator("#title").textContent(), "NEW AGENT SCORE");
      checks.push("edited score survives shell reload");
    }
    // Watcher integration: pause holds the active document, resume applies the saved change.
    await page.locator("#auto").click();
    const held = await page.locator("#preview").getAttribute("src");
    await writeFile(
      join(ws, artifact),
      (await readFile(join(ws, artifact), "utf8")) +
        "\n<!-- browser change -->\n",
    );
    await page.getByText("Changes pending", { exact: true }).waitFor();
    assert.equal(await page.locator("#preview").getAttribute("src"), held);
    await page.locator("#auto").click();
    await page.waitForFunction(
      (src) => document.querySelector("#preview").src !== src,
      new URL(held, base).href,
    );
    f = await waitReady(page);
    checks.push("pause/resume file reload");
    await page.setViewportSize({ width: 390, height: 844 });
    await f.waitForFunction(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    );
    await visibleScreenshot(page, exp.id + "-mobile");
    checks.push("390px layout");
    assert.deepEqual(errors, [], "browser runtime errors");
    checks.push("no runtime errors");
    results.push({ name: exp.id, ok: true, checks });
    console.log("PASS " + exp.id + " — " + checks.join(", "));
  } catch (error) {
    await page
      .screenshot({ path: join(output, exp.id + "-FAIL.png"), fullPage: true })
      .catch(() => {});
    results.push({
      name: exp.id,
      ok: false,
      checks,
      error: error.stack,
      errors,
    });
    console.error("FAIL " + exp.id + " — " + error.message.slice(0, 1000));
  } finally {
    await context.close();
    await closeServer(server);
    await rm(ws, { recursive: true, force: true });
  }
}
try {
  await shellRegression();
  for (const exp of experiences.filter(
    (exp) =>
      !process.env.EXPERIENCE_IDS ||
      process.env.EXPERIENCE_IDS.split(",").includes(exp.id),
  ))
    await one(exp);
} finally {
  await browser.close();
  await writeFile(
    join(output, "browser-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
