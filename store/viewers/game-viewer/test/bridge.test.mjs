import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../web/bridge.js", import.meta.url),
  "utf8",
);
async function fixture(game) {
  const handlers = new Map(),
    ticks = new Map(),
    messages = [];
  const parent = {
    postMessage: (message) =>
      messages.push(JSON.parse(JSON.stringify(message))),
  };
  const location = { origin: "http://127.0.0.1:4111" };
  const context = {
    window: { parent, __studioRevision: "fixture", harnessGame: game },
    parent,
    location,
    TextEncoder,
    queueMicrotask,
    performance: { now: () => 123 },
    document: { querySelector: () => null },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    requestAnimationFrame(callback) {
      queueMicrotask(callback);
    },
    setInterval(callback, delay) {
      ticks.set(delay, callback);
    },
    setTimeout() {},
  };
  runInNewContext(source, context);
  handlers.get("harness:ready")();
  await new Promise(setImmediate);
  return {
    messages,
    tick: (delay) => ticks.get(delay)(),
    command: (action, value, requestId) =>
      handlers.get("message")({
        source: parent,
        origin: location.origin,
        data: { studioCommand: true, action, value, requestId },
      }),
    response: (id) => messages.findLast((message) => message.requestId === id),
  };
}

test("recording only samples active play and commands acknowledge the actual restored state", async () => {
  let score = 3;
  const bridge = await fixture({
    setMode() {},
    setPaused() {},
    captureState: () => ({ score }),
    restoreState: (state) => {
      score = state.score;
    },
    stats: () => ({ score }),
  });
  bridge.tick(200);
  assert.equal(
    bridge.messages.filter((item) => item.type === "sample").length,
    0,
  );
  await bridge.command("mode", "play");
  await bridge.command("pause", false, "resume");
  assert.equal(bridge.response("resume").result.ok, true);
  bridge.tick(200);
  assert.equal(
    bridge.messages.filter((item) => item.type === "sample").length,
    1,
  );
  await bridge.command("capture", undefined, "running");
  assert.match(bridge.response("running").error, /Pause/);
  await bridge.command("pause", true);
  bridge.tick(200);
  assert.equal(
    bridge.messages.filter((item) => item.type === "sample").length,
    1,
  );
  await bridge.command("restore", { score: 1 }, "rewind");
  assert.equal(score, 1);
  assert.deepEqual(bridge.response("rewind").result.state, { score: 1 });
  await bridge.command("capture", undefined, "pin");
  assert.equal(bridge.response("pin").result.image, null);
  assert.deepEqual(bridge.response("pin").result.stats, { score: 1 });
});

test("a rejected restore rolls back partial mutations and does not fail the game build", async () => {
  let score = 7;
  const bridge = await fixture({
    setPaused() {},
    captureState: () => ({ score }),
    restoreState(state) {
      score = state.score;
      if (score < 0) throw new Error("Invalid score");
    },
  });
  await bridge.command("restore", { score: -1 }, "bad");
  assert.equal(score, 7);
  assert.equal(bridge.response("bad").error, "Invalid score");
  assert.equal(
    bridge.messages.some((item) => item.type === "error"),
    false,
  );
});

test("oversized or asynchronous snapshots fail as optional capabilities, leaving play available", async () => {
  for (const captureState of [
    () => ({ data: "x".repeat(65536) }),
    async () => ({ score: 0 }),
  ]) {
    const bridge = await fixture({
      setMode() {},
      setPaused() {},
      captureState,
      restoreState() {},
    });
    await bridge.command("mode", "play");
    await bridge.command("pause", false);
    bridge.tick(200);
    bridge.tick(1000);
    assert.equal(
      bridge.messages.some((item) => item.type === "rewind-unavailable"),
      true,
    );
    assert.equal(
      bridge.messages.some((item) => item.type === "error"),
      false,
    );
    const stats = bridge.messages.findLast((item) => item.type === "stats");
    assert.equal(stats.features.play, true);
    assert.equal(stats.features.rewind, false);
  }
});

test("games without state hooks keep their existing controls", async () => {
  let restarts = 0;
  const bridge = await fixture({
    setMode() {},
    setPaused() {},
    restart: () => restarts++,
  });
  bridge.tick(1000);
  assert.deepEqual(bridge.messages.at(-1).features, {
    play: true,
    pause: true,
    restart: true,
    rewind: false,
  });
  await bridge.command("restart");
  assert.equal(restarts, 1);
  await bridge.command("capture", undefined, "missing");
  assert.match(bridge.response("missing").error, /no snapshot support/);
});

test("an ended run keeps its useful history instead of recording the finish screen forever", async () => {
  let running = true;
  const bridge = await fixture({
    setMode() {},
    setPaused() {},
    captureState: () => ({ running }),
    restoreState() {},
    stats: () => ({ running }),
  });
  await bridge.command("mode", "play");
  await bridge.command("pause", false);
  bridge.tick(200);
  running = false;
  for (let i = 0; i < 200; i++) bridge.tick(200);
  assert.equal(
    bridge.messages.filter((item) => item.type === "sample").length,
    2,
  );
  running = true;
  bridge.tick(200);
  assert.equal(
    bridge.messages.filter((item) => item.type === "sample").length,
    3,
  );
});
