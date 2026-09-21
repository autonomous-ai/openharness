import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewerDir =
  process.env.GAME_VIEWER_DIR || resolve(root, "../../viewers/game-viewer");
const { startGameViewer } = await import(
  pathToFileURL(join(viewerDir, "viewer.mjs")).href
);
const workspace = mkdtempSync(join(tmpdir(), "godogen-browser-test-"));
cpSync(join(root, "template"), workspace, { recursive: true });
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
const artifacts =
  process.env.GODOGEN_TEST_ARTIFACTS || join(root, "test-results");
mkdirSync(artifacts, { recursive: true });
const viewer = await startGameViewer({ workspace, toolchain: root });
const { url } = viewer;
const source = join(workspace, "src/main.ts"),
  original = readFileSync(source, "utf8");
const useWebKit = process.env.GODOGEN_BROWSER === "webkit";
const browser = await (useWebKit ? webkit : chromium)
  .launch({
    headless: true,
    ...(useWebKit
      ? {}
      : {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
            (existsSync(
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : undefined),
          args: ["--enable-unsafe-swiftshader"],
        }),
  })
  .catch(async (error) => {
    await viewer.close();
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  });
const page = await browser.newPage({
  viewport: { width: 1060, height: 800 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const wait = (ms) => page.waitForTimeout(ms);
let awaitSrc = "";
async function game() {
  awaitSrc = await page.locator("#frames iframe.active").getAttribute("src");
  return page.frames().find((frame) => frame.url() === url + awaitSrc);
}
const stats = async () =>
  await (await game()).evaluate(() => window.harnessGame.stats());
const version = () => page.locator("#version").innerText();
const state = async () =>
  await (await page.request.get(url + "/api/state")).json();
const checkpoint = (message) => console.log("PASS " + message);
let exportServer;
try {
  await page.goto(url);
  await page.waitForFunction(
    () =>
      document.querySelector("#frames iframe.active") &&
      !document.querySelector("#play").disabled,
    null,
    { timeout: 45000 },
  );
  assert.equal((await state()).status, "ready");
  assert.ok((await stats()).objects > 100);
  const originalVersion = await version();
  await page.screenshot({
    path: join(artifacts, "game-explore.png"),
    fullPage: true,
  });
  await page.locator("#play").click();
  await wait(500);
  await page.keyboard.down("KeyD");
  await wait(350);
  await page.keyboard.up("KeyD");
  assert.ok((await stats()).positionX > 1);
  await page.keyboard.press("Space");
  await wait(200);
  assert.ok((await stats()).jumpHeight > 0.4);
  await page.locator("#pause").click();
  await wait(60);
  const paused = await stats();
  await wait(350);
  assert.equal((await stats()).time, paused.time);
  await page.locator("#restart").click();
  await wait(80);
  assert.ok((await stats()).distance < 3);
  checkpoint("keyboard steering, jumping, pause, and restart");
  await page.screenshot({
    path: join(artifacts, "game-play.png"),
    fullPage: true,
  });

  // Compile a real source edit while the user is playing.
  const beforeUpdate = await stats();
  writeFileSync(source, original.replace("#397674", "#50755b"));
  await page.locator("#update").waitFor({ state: "visible", timeout: 45000 });
  assert.equal(await version(), originalVersion);
  assert.ok((await stats()).time > beforeUpdate.time);
  assert.ok((await page.locator("#frames iframe").count()) <= 2);
  await page.locator("#update").click();
  assert.notEqual(await version(), originalVersion);
  assert.equal((await stats()).mode, "explore");
  const workingVersion = await version();
  checkpoint(
    "new builds wait without resetting a running game, then apply on request",
  );

  writeFileSync(source, original + "\nTHIS IS NOT TYPESCRIPT !\n");
  await page.waitForFunction(
    () => !document.querySelector("#error").hidden,
    null,
    { timeout: 45000 },
  );
  assert.equal(await version(), workingVersion);
  assert.equal((await state()).status, "error");
  assert.ok((await stats()).fps > 0);
  await page.screenshot({
    path: join(artifacts, "game-recovery.png"),
    fullPage: true,
  });
  checkpoint("syntax errors preserve the last playable version");

  writeFileSync(
    source,
    original + '\nthrow new Error("Deliberate QA runtime failure");\n',
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("#error-message")
        .textContent.includes("Deliberate QA runtime failure"),
    null,
    { timeout: 45000 },
  );
  assert.equal(await version(), workingVersion);
  assert.ok((await stats()).fps > 0);
  writeFileSync(source, original + "\n// Recovery checkpoint\n");
  await page.waitForFunction(
    (old) =>
      document.querySelector("#error").hidden &&
      document.querySelector("#version").textContent !== old,
    workingVersion,
    { timeout: 45000 },
  );
  checkpoint(
    "browser runtime failures preserve the game and recover on the next edit",
  );

  await page.locator("#details").click();
  await page.locator("#tab-versions").click();
  const newest = await version();
  await page.locator("#versions .checkpoint").last().click();
  await page.waitForFunction(
    (latest) => document.querySelector("#version").textContent !== latest,
    newest,
    { timeout: 30000 },
  );
  const historyVersion = await version();
  await wait(300);
  assert.equal(await version(), historyVersion);
  writeFileSync(
    source,
    original + "\n// One more edit while inspecting history\n",
  );
  await page.locator("#update").waitFor({ state: "visible", timeout: 45000 });
  assert.equal(await version(), historyVersion);
  await page.locator("#update").click();
  assert.ok((await page.locator("#frames iframe").count()) <= 2);
  checkpoint(
    "history selection stays selected while new versions arrive; discarded frames are removed",
  );

  await page.locator("#play").click();
  await page.locator("#restart").click();
  await (
    await game()
  ).waitForFunction(
    () => window.harnessGame.stats().state === "finished",
    null,
    { timeout: 60000 },
  );
  assert.ok((await stats()).distance >= 240);
  assert.ok((await stats()).score >= 2);
  await (await game()).locator("#again").click();
  await wait(100);
  assert.ok((await stats()).distance < 5);
  checkpoint("full course, finish screen, and play-again loop");

  // Host an exported build exactly as an ordinary static website.
  await page.locator("#export").click();
  await page.locator("#toast").waitFor({ state: "visible" });
  const exported = (await page.locator("#toast").innerText()).replace(
    "Saved to ",
    "",
  );
  const exportDir = join(workspace, exported);
  exportServer = createServer((req, res) => {
    try {
      const path = join(
        exportDir,
        new URL(req.url, "http://localhost").pathname,
      );
      res.setHeader(
        "content-type",
        path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(
        readFileSync(path.endsWith("/") ? join(path, "index.html") : path),
      );
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => exportServer.listen(0, "127.0.0.1", resolve));
  const exportedPage = await browser.newPage();
  await exportedPage.goto(
    "http://127.0.0.1:" + exportServer.address().port + "/",
  );
  await exportedPage.waitForFunction(
    () => window.harnessGame?.stats().distance > 5,
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await exportedPage.evaluate(() => window.harnessGame.stats().mode),
    "play",
  );
  await exportedPage.close();
  checkpoint("selected version exports as a standalone playable site");

  await page.setViewportSize({ width: 430, height: 740 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator("#fullscreen").click();
  assert.ok(
    await page
      .locator(".studio")
      .evaluate((el) => el.classList.contains("expanded")),
  );
  await (await game()).locator("canvas").click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector(".studio").classList.contains("expanded"),
  );
  assert.equal(
    await page.locator("#fullscreen").getAttribute("aria-label"),
    "Expand preview",
  );
  await page.screenshot({
    path: join(artifacts, "game-narrow.png"),
    fullPage: true,
  });
  assert.deepEqual(
    [...new Set(errors.map((message) => message.replace(/^Error: /, "")))],
    ["Deliberate QA runtime failure"],
  );
  checkpoint("narrow layout, expand/escape, and no uncaught studio errors");
  console.log(
    "RESULT " +
      JSON.stringify({ status: "passed", checks: 8, workspace, exported }),
  );
} finally {
  writeFileSync(source, original);
  await browser.close();
  if (exportServer) await new Promise((resolve) => exportServer.close(resolve));
  await viewer.close();
  rmSync(workspace, { recursive: true, force: true });
}
