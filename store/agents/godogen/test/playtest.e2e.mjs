import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewerDir =
  process.env.GAME_VIEWER_DIR || resolve(root, "../../viewers/game-viewer");
const { startGameViewer } = await import(
  pathToFileURL(join(viewerDir, "viewer.mjs"))
);
const workspace = mkdtempSync(join(tmpdir(), "godogen-playtest-"));
cpSync(join(root, "template"), workspace, { recursive: true });
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
const artifacts =
  process.env.GODOGEN_TEST_ARTIFACTS || join(root, "test-results");
mkdirSync(artifacts, { recursive: true });
let viewer = await startGameViewer({ workspace, toolchain: root });
const useWebKit = process.env.GODOGEN_BROWSER === "webkit";
const browser = await (useWebKit ? webkit : chromium).launch({
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
});
const page = await browser.newPage({
  viewport: { width: 1200, height: 940 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];
const pass = (name) => {
  results.push(name);
  console.log("PASS " + name);
};
const game = async () => {
  const src = await page.locator("iframe.active").getAttribute("src");
  return page.frames().find((frame) => frame.url() === viewer.url + src);
};
const snapshot = async () =>
  (await game()).evaluate(() => window.harnessGame.captureState());
const ready = async () =>
  page.waitForFunction(
    () =>
      document.querySelector("iframe.active") &&
      !document.querySelector("#play").disabled,
    null,
    { timeout: 45000 },
  );
const idle = async () =>
  page.waitForFunction(
    () =>
      !document.querySelector("#timeline").hidden &&
      !document.querySelector("#try-here").disabled,
    null,
    { timeout: 12000 },
  );
const selectFrame = async (index) => {
  await page.locator("#timeline-range").evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, index);
  await idle();
};
const note = "Keep this jump. Try a longer airtime and a brighter next gate.";
try {
  await page.goto(viewer.url);
  await ready();
  await page.locator("#play").click();
  await (
    await game()
  ).waitForFunction(() => window.harnessGame.stats().score >= 1, null, {
    timeout: 45000,
  });
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(200);
  await page.keyboard.up("KeyD");
  await page.keyboard.press("Space");
  await (
    await game()
  ).waitForFunction(() => window.harnessGame.stats().jumpHeight > 0.5);
  await page.locator("#pause").click();
  await page.waitForTimeout(100);
  const live = await snapshot();
  assert.ok(live.score >= 1 && live.jump > 0);
  await page.locator("#rewind").click();
  await idle();
  await selectFrame(0);
  const early = await snapshot();
  assert.ok(early.elapsed < live.elapsed - 1);
  assert.equal(early.score, 0);
  assert.ok(early.gates.every((taken) => !taken));
  assert.equal(await page.locator("iframe.active").getAttribute("inert"), "");
  await page.screenshot({
    path: join(artifacts, "game-rewind.png"),
    fullPage: true,
  });
  await page.locator("#back-live").click();
  await page.locator("#timeline").waitFor({ state: "hidden" });
  assert.deepEqual(await snapshot(), live);
  assert.equal(
    await page.locator("#pause").getAttribute("aria-pressed"),
    "true",
  );
  pass(
    "rewind restores gates and score; Back to live restores the exact mid-jump state",
  );

  await page.locator("#rewind").click();
  await idle();
  await selectFrame(0);
  const branch = await snapshot();
  await page.locator("#try-here").click();
  await page.locator("#timeline").waitFor({ state: "hidden" });
  await page.keyboard.down("KeyA");
  await (
    await game()
  ).waitForFunction(
    (x) => window.harnessGame.stats().positionX < x - 1,
    branch.x,
  );
  await page.keyboard.up("KeyA");
  await page.keyboard.press("Space");
  await (
    await game()
  ).waitForFunction(() => window.harnessGame.stats().jumpHeight > 0.5);
  await page.locator("#pin-moment").click();
  await page.locator("#moment-dialog").waitFor({ state: "visible" });
  const pinned = await snapshot();
  assert.ok(pinned.elapsed > branch.elapsed && pinned.x < branch.x - 1);
  await page.locator("#moment-kind").selectOption("keep");
  await page.locator("#moment-note").fill(note);
  await page.screenshot({
    path: join(artifacts, "game-pin-moment.png"),
    fullPage: true,
  });
  await page.locator("#moment-save").click();
  await page.locator("#moment-dialog").waitFor({ state: "hidden" });
  const saved = (
    await (await page.request.get(viewer.url + "/api/playtests")).json()
  )[0];
  const record = JSON.parse(readFileSync(join(workspace, saved.path), "utf8"));
  assert.equal(record.note, note);
  assert.equal(record.kind, "keep");
  assert.deepEqual(record.snapshot.state, pinned);
  assert.ok(
    readFileSync(join(workspace, "out/playtests", saved.id, "screenshot.jpg"))
      .length > 2000,
  );
  assert.ok(
    existsSync(join(workspace, "out/playtests", saved.id, "game/index.html")),
  );
  pass(
    "Try from here resumes different input; pin saves state, canvas image, note, and exact build",
  );

  const source = join(workspace, "src/main.ts"),
    original = readFileSync(source, "utf8");
  writeFileSync(source, original.replace("#397674", "#50755b"));
  await page.locator("#update").waitFor({ state: "visible", timeout: 45000 });
  await page.locator("#update").click();
  const latest = viewer.state.latest.id;
  await page.locator("#show-moments").click();
  await page
    .getByRole("button", { name: "Revisit moment", exact: true })
    .click();
  await page.locator("#timeline").waitFor({ state: "visible", timeout: 45000 });
  await idle();
  assert.deepEqual(await snapshot(), pinned);
  assert.equal(viewer.state.latest.id, latest);
  assert.equal(viewer.state.status, "ready");
  assert.equal(await page.locator("#version").innerText(), "Saved version 1");
  await page.waitForTimeout(250); // Let the preview's opacity transition finish before the evidence image.
  await page.screenshot({
    path: join(artifacts, "game-saved-moments.png"),
    fullPage: true,
  });
  // Invalid saved state must reject atomically, leaving the running world intact.
  const invalid = await (
    await game()
  ).evaluate(() => {
    const before = window.harnessGame.captureState();
    try {
      window.harnessGame.restoreState({ ...before, gates: [true] });
      return null;
    } catch (error) {
      return {
        message: error.message,
        before,
        after: window.harnessGame.captureState(),
      };
    }
  });
  assert.match(invalid.message, /compatible/);
  assert.deepEqual(invalid.before, invalid.after);
  pass(
    "saved game reopens after source changes; invalid state leaves the world unchanged",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(artifacts, "game-moments-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator("#back-live").click();
  await page.waitForFunction(
    () => !document.querySelector("#version").textContent.includes("Saved"),
  );
  pass("saved moments fit a narrow viewport and return to the current game");

  await viewer.close();
  viewer = await startGameViewer({ workspace, toolchain: root });
  await page.setViewportSize({ width: 1200, height: 940 });
  await page.goto(viewer.url);
  await ready();
  await page.locator("#show-moments").click();
  await page
    .getByRole("button", { name: "Revisit moment", exact: true })
    .click();
  await page.locator("#timeline").waitFor({ state: "visible", timeout: 45000 });
  await idle();
  assert.deepEqual(await snapshot(), pinned);
  assert.equal(viewer.state.history.length, 1);
  pass(
    "workspace moments survive a complete viewer restart with their original game build",
  );

  await page.locator("#back-live").click();
  await ready();
  await page.locator("#pin-moment").click();
  await page.locator("#moment-dialog").waitFor({ state: "visible" });
  const explored = await snapshot();
  await page
    .locator("#moment-note")
    .fill("Explore this camera angle for the opening scene.");
  await page.locator("#moment-kind").selectOption("explore");
  const inspectedVersion = await page.locator("#version").innerText();
  writeFileSync(
    source,
    readFileSync(source, "utf8") +
      "\n// Update while a player writes an Explore note.\n",
  );
  await page.locator("#update").waitFor({ state: "visible", timeout: 45000 });
  assert.equal(await page.locator("#version").innerText(), inspectedVersion);
  assert.equal(await page.locator("#moment-dialog").isVisible(), true);
  await page.locator("#moment-save").click();
  await page.locator("#moment-dialog").waitFor({ state: "hidden" });
  const exploredRecord = (
    await (await page.request.get(viewer.url + "/api/playtests")).json()
  )[0];
  const exploredState = JSON.parse(
    readFileSync(join(workspace, exploredRecord.path), "utf8"),
  );
  assert.equal(exploredState.snapshot.mode, "explore");
  await page.locator("#show-moments").click();
  await page
    .getByRole("button", { name: "Revisit moment", exact: true })
    .first()
    .click();
  await idle();
  assert.deepEqual(await snapshot(), explored);
  assert.equal(
    await page.locator("#explore").getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await (await game()).evaluate(() => window.harnessGame.stats().mode),
    "explore",
  );
  await page.locator("#try-here").click();
  await page.locator("#timeline").waitFor({ state: "hidden" });
  await (
    await game()
  ).waitForFunction(
    () =>
      window.harnessGame.stats().mode === "play" &&
      window.harnessGame.stats().time > 0.3,
  );
  pass(
    "Explore moments retain mode and camera across agent edits, then start Play on request",
  );

  // Snapshot support is optional; old games still play, pause, and export.
  await page.locator("#explore").click();
  await page.locator("#tab-versions").click();
  await page.locator("#versions .checkpoint").first().click();
  // Selecting history disables following updates; apply the next one explicitly.
  writeFileSync(
    source,
    original.replace("  captureState,\n  restoreState,\n", ""),
  );
  await page.locator("#update").waitFor({ state: "visible", timeout: 45000 });
  await page.locator("#update").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#rewind-status")
      .textContent.includes("unavailable"),
  );
  assert.equal(await page.locator("#pin-moment").isDisabled(), true);
  await page.locator("#play").click();
  await (
    await game()
  ).waitForFunction(() => window.harnessGame.stats().time > 0.3);
  assert.equal(await page.locator("#pause").isDisabled(), false);
  pass(
    "legacy games without snapshot hooks remain playable with rewind disabled",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(artifacts, "playtest-results.json"),
    JSON.stringify({ passed: results, errors, savedMoment: record }, null, 2),
  );
} catch (error) {
  await page
    .screenshot({
      path: join(artifacts, "playtest-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
  await viewer.close();
  rmSync(workspace, { recursive: true, force: true });
}
