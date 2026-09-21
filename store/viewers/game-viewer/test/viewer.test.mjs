import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { startGameViewer } from "../viewer.mjs";

const until = async (predicate) => {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not arrive");
};
async function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), "game-viewer-test-"));
  writeFileSync(
    join(workspace, "studio.json"),
    JSON.stringify({ title: "Fixture world" }),
  );
  let fail = false;
  const build = async (options) => {
    mkdirSync(options.build.outDir, { recursive: true });
    writeFileSync(
      join(options.build.outDir, "index.html"),
      "<h1>A playable fixture</h1>",
    );
    writeFileSync(
      join(options.build.outDir, "version.js"),
      "export const ready=true;",
    );
    if (fail) throw new Error("Syntax error in src/main.ts");
  };
  const viewer = await startGameViewer({ workspace, build });
  t.after(async () => {
    await viewer.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  await until(() => viewer.state.status === "preview");
  const post = async (path, body, headers = {}) =>
    fetch(viewer.url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-token": viewer.token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const ready = async () => {
    const id = viewer.state.candidate.id;
    assert.equal(
      (await post("/api/report", { id, type: "ready" })).status,
      200,
    );
    return id;
  };
  return {
    workspace,
    viewer,
    post,
    ready,
    setFail: (value) => {
      fail = value;
    },
  };
}

test("a build is not ready until a browser reports a rendered frame", async (t) => {
  const { viewer, workspace, ready } = await fixture(t);
  assert.equal(
    JSON.parse(readFileSync(join(workspace, ".harness/verdict.json"))).ready,
    false,
  );
  await ready();
  assert.equal(viewer.state.status, "ready");
  assert.equal(
    JSON.parse(readFileSync(join(workspace, ".harness/verdict.json"))).ready,
    true,
  );
});

test("build and runtime failures retain the last working revision and recover on the next edit", async (t) => {
  const { viewer, ready, post, setFail } = await fixture(t);
  const original = await ready();
  setFail(true);
  await viewer.rebuild();
  assert.equal(viewer.state.status, "error");
  assert.equal(viewer.state.latest.id, original);
  assert.equal(
    (await fetch(viewer.url + `/__game/${original}/index.html`)).status,
    200,
  );
  setFail(false);
  await viewer.rebuild();
  const broken = viewer.state.candidate.id;
  await post("/api/report", {
    id: broken,
    type: "error",
    message: "Required model failed to load",
  });
  assert.equal(viewer.state.latest.id, original);
  assert.equal(viewer.state.status, "error");
  assert.equal(
    viewer.state.history.some((item) => item.id === broken),
    false,
  );
  await viewer.rebuild();
  await ready();
  assert.equal(viewer.state.status, "ready");
  assert.equal(viewer.state.error, null);
});

test("a player can keep an old revision beyond the ten-version history limit", async (t) => {
  const { viewer, ready, post } = await fixture(t);
  const original = await ready();
  assert.equal(
    (await post("/api/retain", { client: "player-one", ids: [original] }))
      .status,
    200,
  );
  for (let i = 0; i < 12; i++) {
    await viewer.rebuild();
    await ready();
  }
  assert.equal(viewer.state.history.length, 10);
  assert.equal(
    viewer.state.history.some((item) => item.id === original),
    false,
  );
  assert.equal(
    (await fetch(viewer.url + `/__game/${original}/version.js`)).status,
    200,
  );
  await post("/api/retain", { client: "player-one", ids: [] });
  assert.equal(
    (await fetch(viewer.url + `/__game/${original}/version.js`)).status,
    404,
  );
});

test("export writes a complete chosen version and never overwrites an earlier export", async (t) => {
  const { viewer, workspace, ready, post } = await fixture(t);
  assert.equal(
    (await post("/api/export", { id: viewer.state.candidate.id })).status,
    409,
  );
  const id = await ready();
  const first = await (await post("/api/export", { id })).json();
  const second = await (await post("/api/export", { id })).json();
  assert.notEqual(first.path, second.path);
  assert.equal(
    readFileSync(join(workspace, first.path, "version.js"), "utf8"),
    "export const ready=true;",
  );
  assert.equal(existsSync(join(workspace, second.path, "index.html")), true);
});

test("rejects cross-origin writes, invalid hosts, traversal and exports outside the project", async (t) => {
  const { viewer, workspace, ready, post } = await fixture(t);
  const id = await ready();
  assert.equal(
    (await post("/api/export", { id }, { origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal(
    (await post("/api/export", { id }, { "x-studio-token": "wrong" })).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) =>
    get(
      viewer.url + "/api/state",
      { headers: { host: "other.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    ).on("error", reject),
  );
  assert.equal(hostStatus, 403);
  assert.equal(
    (await fetch(viewer.url + "/api/asset?path=../../etc/passwd")).status,
    404,
  );
  const outside = mkdtempSync(join(tmpdir(), "game-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(workspace, "out"), "dir");
  assert.equal((await post("/api/export", { id })).status, 403);
});

test("studio metadata updates without rebuilding the game or clearing readiness", async (t) => {
  const { viewer, workspace, ready } = await fixture(t);
  await ready();
  const number = viewer.state.latest.number;
  writeFileSync(
    join(workspace, ".harness/progress.json"),
    JSON.stringify({ phase: "play", message: "Adding the jump controls" }),
  );
  await until(
    () => viewer.state.progress.message === "Adding the jump controls",
  );
  writeFileSync(
    join(workspace, "studio.json"),
    JSON.stringify({ title: "A new title", controls: "Arrow keys" }),
  );
  await until(() => viewer.state.project.title === "A new title");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(viewer.state.latest.number, number);
  assert.equal(viewer.state.status, "ready");
  const verdict = JSON.parse(
    readFileSync(join(workspace, ".harness/verdict.json")),
  );
  assert.equal(
    verdict.phases.find((phase) => phase.id === "play").state,
    "active",
  );
});
