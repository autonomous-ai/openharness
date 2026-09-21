import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewer =
  process.env.FILM_VIEWER_DIR || resolve(root, "../../viewers/film-viewer");
const workspace = mkdtempSync(join(tmpdir(), "film-studio-test-"));
const artifacts = process.env.FILM_TEST_ARTIFACTS || join(root, "test-results");
mkdirSync(artifacts, { recursive: true });
cpSync(join(root, "template"), workspace, { recursive: true });
const env = {
  ...process.env,
  HARNESS_WORKSPACE: workspace,
  HARNESS_DSH_DIR: root,
};
execFileSync("bash", [join(root, "toolchain/init-workspace.sh")], {
  cwd: workspace,
  env,
});
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn("bash", [join(viewer, "viewer.sh")], {
  cwd: workspace,
  env: { ...env, HARNESS_VIEWER_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (b) => (serverLog += b));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(120);
  }
  throw Error(`Timed out: ${message}\n${serverLog.slice(-1500)}`);
}
const production = join(workspace, "projects/afterglow");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2));
const checkpoint = (message) => console.log(`PASS ${message}`);
let browser, page, render;
function renderFilm(label) {
  render = spawn(
    "bash",
    [join(root, "toolchain/montage"), "render", "--scale", "0.5"],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  for (const stream of [render.stdout, render.stderr])
    stream.on("data", (b) => (log += b));
  return new Promise((resolve) =>
    render.once("close", (code) => {
      writeFileSync(join(artifacts, `${label}.log`), log);
      render = null;
      resolve(code);
    }),
  );
}
try {
  await until(async () => {
    try {
      return (await fetch(url + "/api/studio")).ok;
    } catch {
      return false;
    }
  }, "viewer startup");
  const useWebKit = process.env.FILM_BROWSER === "webkit";
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await (useWebKit ? webkit : chromium).launch({
    headless: true,
    ...(!useWebKit && existsSync(chrome)
      ? {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chrome,
        }
      : {}),
  });
  page = await browser.newPage({
    viewport: { width: 1120, height: 1040 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.goto(url + "/studio");
  await page.waitForFunction(
    () => document.querySelector("#film").readyState >= 1,
  );
  const api = async () => (await page.request.get(url + "/api/studio")).json();
  const state = await api(),
    original = state.renders[0];
  assert.equal(state.storyboard.scenes.length, 4);
  assert.ok(Math.abs(original.duration - 18) < 0.1);
  assert.equal(original.width, 1280);
  assert.equal(original.audio, true);
  assert.equal(await page.locator(".shot img").count(), 4);
  await page.locator("#big-play").click();
  await page.waitForFunction(
    () => document.querySelector("#film").currentTime > 0.5,
  );
  await page.locator("#play").click();
  assert.ok(
    await page
      .locator("#film")
      .evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames > 0),
  );
  assert.equal(await page.locator("#film").evaluate((v) => v.paused), true);
  await page.locator(".shot").nth(2).click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#film").seeking &&
      document.querySelector("#film").readyState >= 2,
  );
  assert.ok(
    Math.abs((await page.locator("#film").evaluate((v) => v.currentTime)) - 9) <
      0.1,
  );
  await page.locator("#seek").evaluate((input) => {
    input.value = "4.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.ok(
    Math.abs(
      (await page.locator("#film").evaluate((v) => v.currentTime)) - 4.5,
    ) < 0.1,
  );
  await page.locator("#mute").click();
  assert.equal(await page.locator("#film").evaluate((v) => v.muted), true);
  await page.locator("#full").click();
  await delay(150);
  // Headless WebKit may not expose fullscreen; the in-pane fallback stays usable.
  if (await page.evaluate(() => !!document.fullscreenElement))
    await page.evaluate(() => document.exitFullscreen());
  await page.screenshot({
    path: join(artifacts, "film-storyboard.png"),
    fullPage: true,
  });
  checkpoint(
    "real 18-second film: playback, pause, scene jump, seek, mute, expansion",
  );

  await page.locator("#tab-script").click();
  assert.equal(await page.locator(".script-section").count(), 4);
  const scriptFile = join(production, "artifacts/script.json"),
    script = json(scriptFile);
  script.sections[0].text =
    "A golden sun rises over the valley. Live revision.";
  write(scriptFile, script);
  await page.getByText(script.sections[0].text, { exact: true }).waitFor();
  const beforeBroken = await page.locator("#film").getAttribute("src");
  writeFileSync(scriptFile, '{"sections":');
  await delay(2800);
  assert.equal(await page.locator("#film").getAttribute("src"), beforeBroken);
  write(scriptFile, script);
  await page.getByText(script.sections[0].text, { exact: true }).waitFor();
  checkpoint(
    "live screenplay updates and recovery from a partially written artifact",
  );

  await page.locator("#tab-notes").click();
  const feedback =
    'Hold this shot longer. <img src=x onerror="window.noteXss=true">';
  await page.getByRole("textbox", { name: "Review note" }).fill(feedback);
  await page.getByRole("button", { name: "Save note" }).click();
  await page.locator(".note p").filter({ hasText: feedback }).waitFor();
  const notes = json(join(production, "review-notes.json"));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].seconds, 4.5);
  assert.equal(notes[0].revision, original.revision);
  assert.equal(await page.evaluate(() => window.noteXss), undefined);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#film").readyState >= 1,
  );
  await page.locator("#tab-notes").click();
  await page.getByRole("button", { name: "Go to note at 00:04" }).click();
  assert.ok(
    Math.abs(
      (await page.locator("#film").evaluate((v) => v.currentTime)) - 4.5,
    ) < 0.1,
  );
  await page.locator("#export").click();
  await page.getByRole("link", { name: "Download", exact: true }).waitFor();
  const exports = readdirSync(join(workspace, "exports"));
  assert.equal(exports.length, 1);
  const bytes = readFileSync(join(workspace, "exports", exports[0]));
  assert.deepEqual(bytes, readFileSync(join(production, original.path)));
  const download = await page.request.get(
    url +
      (await page
        .getByRole("link", { name: "Download", exact: true })
        .getAttribute("href")),
  );
  assert.deepEqual(await download.body(), bytes);
  await page.screenshot({
    path: join(artifacts, "film-review.png"),
    fullPage: true,
  });
  checkpoint(
    "timed notes persist against the exact cut; exported and downloaded bytes match",
  );

  const body = {
    project: "afterglow",
    path: original.path,
    revision: original.revision,
    seconds: 2,
    text: "Test",
  };
  const headers = { "x-film-token": state.token };
  assert.equal(
    (
      await page.request.post(url + "/api/studio/notes", { data: body })
    ).status(),
    403,
  );
  assert.equal(
    (
      await page.request.post(url + "/api/studio/notes", {
        data: { ...body, revision: "old" },
        headers,
      })
    ).status(),
    409,
  );
  assert.equal(
    (
      await page.request.post(url + "/api/studio/notes", {
        data: { ...body, seconds: 100 },
        headers,
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await page.request.get(url + "/api/studio", {
        headers: { host: "attacker.example" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await page.request.get(url + "/api/studio", {
        headers: { origin: "https://attacker.example" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (await page.request.get(url + "/media/afterglow/project.json")).status(),
    403,
  );
  symlinkSync(tmpdir(), join(workspace, "projects/escape"), "dir");
  symlinkSync(
    join(workspace, "film.json"),
    join(production, "assets/escape.jpg"),
  );
  assert.equal(
    (await page.request.get(url + "/media/escape/film.mp4")).status(),
    403,
  );
  // A symlink to another file in the workspace is still outside this production.
  assert.equal(
    (
      await page.request.get(url + "/media/afterglow/assets/escape.jpg")
    ).status(),
    403,
  );
  const library = await (await page.request.get(url + "/api/projects")).json();
  assert.ok(!library.some((p) => p.project_id === "escape"));
  rmSync(join(workspace, "projects/escape"));
  rmSync(join(production, "assets/escape.jpg"));
  renameSync(join(workspace, "exports"), join(workspace, "saved-exports"));
  symlinkSync(tmpdir(), join(workspace, "exports"), "dir");
  assert.equal(
    (await page.request.get(url + "/export/example.mp4")).status(),
    403,
  );
  rmSync(join(workspace, "exports"));
  renameSync(join(workspace, "saved-exports"), join(workspace, "exports"));
  writeFileSync(join(production, "renders/broken.mp4"), "not video");
  cpSync(
    join(production, original.path),
    join(production, "renders/.unfinished.partial.mp4"),
  );
  assert.equal((await api()).renders.length, 1);
  checkpoint(
    "stale-cut, cross-origin, file traversal, symlink, and incomplete-render checks",
  );

  await page.locator("#tab-shots").click();
  const source = join(production, "composition/index.tsx"),
    originalSource = readFileSync(source, "utf8");
  writeFileSync(
    source,
    originalSource + "\nTHIS IS AN INTENTIONAL SYNTAX ERROR {\n",
  );
  assert.notEqual(await renderFilm("intentional-failure"), 0);
  await page.waitForFunction(() =>
    document.querySelector("#production-status").textContent.includes("failed"),
  );
  assert.equal((await api()).renders.length, 1);
  assert.equal(await page.locator("#film").getAttribute("src"), beforeBroken);
  assert.equal(json(join(workspace, ".harness/verdict.json")).ready, false);
  checkpoint(
    "a real compiler failure preserves the previous playable cut and reports failure",
  );

  writeFileSync(source, originalSource);
  write(join(production, "composition/props.json"), {
    title: "Golden Hour",
    subtitle: "An edited second cut",
  });
  await page.locator("#film").evaluate((v) => {
    v.currentTime = 1;
    v.loop = true;
  });
  await page.locator("#play").click();
  const oldStill = readFileSync(join(production, "snapshots/01.jpg"));
  const recovering = renderFilm("recovery-render");
  await page.waitForFunction(() =>
    document
      .querySelector("#production-status")
      .textContent.includes("Rendering"),
  );
  assert.equal(await page.locator("#film").evaluate((v) => v.paused), false);
  assert.equal(json(join(workspace, ".harness/verdict.json")).ready, false);
  assert.equal(await recovering, 0);
  assert.notDeepEqual(
    readFileSync(join(production, "snapshots/01.jpg")),
    oldStill,
  );
  assert.deepEqual(
    json(join(production, "artifacts/render_report.json")).warnings,
    [],
  );
  await page.locator("#new-cut").waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await page.locator("#film").getAttribute("src"), beforeBroken);
  assert.equal(await page.locator("#film").evaluate((v) => v.paused), false);
  assert.equal((await api()).renders.length, 2);
  await page.locator("#new-cut").click();
  await page.waitForFunction(
    () => document.querySelector("#film").readyState >= 1,
  );
  assert.notEqual(
    await page.locator("#film").getAttribute("src"),
    beforeBroken,
  );
  assert.equal((await api()).renders[0].width, 640);
  assert.equal(json(join(workspace, ".harness/verdict.json")).ready, true);
  await page.locator("#tab-notes").click();
  await page.getByRole("button", { name: "Go to note at 00:04" }).click();
  assert.equal(await page.locator("#film").getAttribute("src"), beforeBroken);
  checkpoint(
    "real recovery render, uninterrupted old-cut playback, version switching and note recall",
  );

  write(join(production, "render-progress.json"), {
    status: "rendering",
    pid: 2147483647,
  });
  assert.equal((await api()).render_progress.status, "failed");
  write(join(production, "render-progress.json"), []);
  assert.equal((await api()).render_progress.status, undefined);
  cpSync(production, join(workspace, "projects/second-film"), {
    recursive: true,
  });
  rmSync(join(workspace, "projects/second-film/review-notes.json"));
  write(join(workspace, "projects/second-film/project.json"), {
    title: "Another production",
  });
  write(join(workspace, "film.json"), { spec: 1, project: "second-film" });
  await page
    .getByRole("heading", { name: "Another production", exact: true })
    .waitFor();
  assert.equal((await api()).notes.length, 0);
  assert.ok(
    (await page.locator("#film").getAttribute("src")).includes("/second-film/"),
  );
  write(join(workspace, "film.json"), { spec: 1, project: "afterglow" });
  await page.getByRole("heading", { name: "Afterglow", exact: true }).waitFor();
  await page.locator("#tab-shots").click();
  await page.setViewportSize({ width: 430, height: 930 });
  await delay(200);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: join(artifacts, "film-narrow.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  checkpoint(
    "interrupted render recovery, independent productions, narrow layout, no browser errors",
  );
} finally {
  if (render) render.kill("SIGTERM");
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("close", resolve)),
    delay(3000),
  ]);
  writeFileSync(join(artifacts, "viewer.log"), serverLog);
  rmSync(workspace, { recursive: true, force: true });
}
