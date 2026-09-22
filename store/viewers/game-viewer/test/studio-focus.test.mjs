import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";

const studio = readFileSync(new URL("../web/studio.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/, "");
const playtest = readFileSync(new URL("../web/playtest.js", import.meta.url), "utf8")
  .replace("export function createPlaytest", "function createPlaytest");

// Execute both real controllers with a small DOM/bridge adapter. This checks
// focus ownership through asynchronous toolbar/dialog flows, not rendered UI.
async function fixture() {
  const elements = new Map(), handlers = new Map(), focusEvents = [];
  let source, frame, rejectRestore = false;
  const document = {
    activeElement: null,
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    querySelector: (id) => document.getElementById(id),
    createElement: (tag) => new Element(tag),
  };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.style = {};
      this.content = "fixture-token";
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      const classes = new Set();
      this.classList = {
        toggle(name, on = !classes.has(name)) {
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
        contains: (name) => classes.has(name),
      };
      if (tag === "iframe") {
        frame = this;
        this.contentWindow = {
          focus: () => {
            focusEvents.push(`window:${this.tag}`);
            if (!this.inert) document.activeElement = this;
          },
          postMessage: ({ action, value, requestId }) => {
            if (!requestId) return;
            const result = action === "capture" || action === "restore"
              ? { state: value || { score: 1 }, stats: { time: 2, score: 1 }, mode: "play" }
              : { ok: true };
            queueMicrotask(() => message({
              type: "response", requestId, result,
              ...(action === "restore" && rejectRestore ? { error: "Snapshot rejected" } : {}),
            }));
          },
        };
      }
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return this.children.filter((child) => child.tag === "button"); }
    setAttribute(name, value) {
      this.attributes.set(name, value);
      if (name === "inert") this.inert = true;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "inert") this.inert = false;
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    focus() {
      focusEvents.push(`element:${this.tag}`);
      if (!this.inert) document.activeElement = this;
    }
    showModal() { this.open = true; }
    close() {
      this.open = false;
      this.listeners.get("close")?.();
    }
    remove() {}
  }
  const origin = "http://127.0.0.1:4111";
  const message = (data) => handlers.get("message")({
    origin, source: frame.contentWindow, data: { studio: true, id: "game", ...data },
  });
  runInNewContext(`const createPlaytest = (() => { ${playtest}; return createPlaytest; })();\n${studio}`, {
    document,
    location: { origin },
    crypto: { randomUUID },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    addEventListener: (name, handler) => handlers.set(name, handler),
    EventSource: class {
      constructor() { source = this; this.handlers = new Map(); }
      addEventListener(name, handler) { this.handlers.set(name, handler); }
    },
    fetch: async (path, options) => ({
      ok: true,
      json: async () => path === "/api/playtests" && !options
        ? [] : { path: "out/playtests/saved" },
    }),
  });
  const revision = { id: "game", number: 1, url: "/game/index.html", project: {} };
  source.handlers.get("state")({ data: JSON.stringify({
    status: "ready", project: {}, progress: {}, activity: [], history: [revision], latest: revision,
  }) });
  await message({ type: "ready" });
  const stats = () => message({
    type: "stats", stats: {}, features: { play: true, pause: true, restart: true, rewind: true },
  });
  await stats();
  const click = async (id) => {
    const target = document.getElementById(id);
    target.focus();
    await target.onclick?.({ preventDefault() {} });
  };
  return {
    click, stats, document, frame, message, focusEvents,
    element: document.getElementById,
    rejectRestore() { rejectRestore = true; },
    async save() {
      document.getElementById("moment-save").focus();
      await document.getElementById("moment-form").onsubmit({ preventDefault() {} });
    },
  };
}

test("starting Play focuses the iframe element before its window", async () => {
  const app = await fixture();
  app.focusEvents.length = 0;
  await app.click("play");
  // A native WebKit pane can keep keyboard input in the neighboring terminal
  // when only the child window is focused. Exercise the real Play handler.
  assert.deepEqual(app.focusEvents, ["element:play", "element:iframe", "window:iframe"]);
  assert.equal(app.document.activeElement, app.frame);
});

test("Resume returns keyboard focus to the game; Pause and Explore retain toolbar focus", async () => {
  const app = await fixture();
  await app.click("play");
  assert.equal(app.document.activeElement, app.frame);
  await app.click("pause");
  assert.equal(app.document.activeElement, app.element("pause"));
  await app.click("pause");
  assert.equal(app.document.activeElement, app.frame);
  await app.click("explore");
  await app.click("pause");
  await app.click("pause");
  assert.equal(app.document.activeElement, app.element("pause"));
});

test("Back to live unlocks the game before returning keyboard focus", async () => {
  const app = await fixture();
  await app.click("play");
  for (let i = 0; i < 2; i++)
    await app.message({ type: "sample", at: i * 200, state: { score: i }, stats: { time: i } });
  await app.click("rewind");
  assert.equal(app.frame.inert, true);
  await app.click("back-live");
  assert.equal(app.frame.inert, false);
  assert.equal(app.document.activeElement, app.frame);
});

test("canceling or saving a playtest note returns focus only after the game is unlocked", async () => {
  for (const save of [false, true]) {
    const app = await fixture();
    await app.click("play");
    await app.click("pin-moment");
    assert.equal(app.frame.inert, true);
    assert.equal(app.document.activeElement, app.element("moment-note"));
    if (save) await app.save();
    else await app.click("moment-cancel");
    assert.equal(app.frame.inert, false);
    assert.equal(app.document.activeElement, app.frame);
  }
});

test("a paused game and subsequent stats updates do not steal focus", async () => {
  const app = await fixture();
  await app.click("play");
  await app.click("pause");
  await app.click("pin-moment");
  await app.click("moment-cancel");
  assert.equal(app.frame.inert, false);
  assert.notEqual(app.document.activeElement, app.frame);
  app.element("details").focus();
  await app.stats();
  assert.equal(app.document.activeElement, app.element("details"));
  await app.click("pause");
  assert.equal(app.document.activeElement, app.frame);
  app.element("details").focus();
  await app.stats();
  assert.equal(app.document.activeElement, app.element("details"));
});

test("failed restoration retains the rewind input lock", async () => {
  const app = await fixture();
  await app.click("play");
  for (let i = 0; i < 2; i++)
    await app.message({ type: "sample", at: i * 200, state: { score: i }, stats: { time: i } });
  await app.click("rewind");
  app.rejectRestore();
  await app.click("back-live");
  assert.equal(app.frame.inert, true);
  assert.notEqual(app.document.activeElement, app.frame);
});
