// DOM behavior checks only: no browser engine, layout, network, or real app state.
import { parseHTML } from "linkedom";
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import path from "node:path";
export function load(file, { reduced = false } = {}) {
  const html = fs.readFileSync(file, "utf8"),
    { document, window: w } = parseHTML(html);
  let now = 0,
    id = 0,
    active = document.body;
  const timers = new Map(),
    listeners = new Map();
  const select = w.HTMLSelectElement.prototype;
  Object.defineProperty(select, "value", {
    configurable: true,
    get() {
      return (
        [...this.querySelectorAll("option")]
          .find((x) => x.hasAttribute("selected"))
          ?.getAttribute("value") ??
        this.querySelector("option")?.getAttribute("value") ??
        ""
      );
    },
    set(v) {
      this.querySelectorAll("option").forEach((x) =>
        x.toggleAttribute("selected", x.getAttribute("value") === String(v)),
      );
    },
  });
  Object.defineProperty(document, "activeElement", {
    get: () => active,
    configurable: true,
  });
  Object.defineProperty(document, "hidden", {
    value: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", {
    get: () => 600,
    configurable: true,
  });
  w.HTMLElement.prototype.focus = function () {
    active = this;
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.setCustomValidity = function (message) {
    this.validationMessage = message;
  };
  w.HTMLElement.prototype.reportValidity = function () {
    return (
      !this.validationMessage &&
      (!this.hasAttribute("required") || !!this.value)
    );
  };
  w.HTMLCanvasElement.prototype.getContext = () => ({
    font: "",
    measureText: () => ({ width: 60 }),
  });
  const media = new Map();
  const sandbox = {
    document,
    console,
    performance: { now: () => now },
    location: { hash: "" },
    navigator: {},
    getComputedStyle: () => ({
      paddingLeft: "0",
      paddingRight: "0",
      fontFamily: "Menlo",
    }),
    matchMedia: (q) => {
      if (!media.has(q))
        media.set(q, {
          matches: q.includes("reduced-motion") ? reduced : true,
          addEventListener(type, fn) {
            this.listener = fn;
          },
        });
      return media.get(q);
    },
    setInterval: (fn, delay) => {
      const key = ++id;
      timers.set(key, { fn, at: now + delay, repeat: delay });
      return key;
    },
    setTimeout: (fn, delay = 0) => {
      const key = ++id;
      timers.set(key, { fn, at: now + delay, repeat: 0 });
      return key;
    },
    clearInterval: (key) => timers.delete(key),
    clearTimeout: (key) => timers.delete(key),
    addEventListener: (type, fn) => {
      const set = listeners.get(type) || new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      constructor(fn) {
        this.fn = fn;
      }
      observe(target) {
        this.fn([{ target, isIntersecting: true }]);
      }
      disconnect() {}
    },
    fetch: () => {
      throw new Error("Unexpected network request");
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const s of document.querySelectorAll("script"))
    if (s.type !== "application/json")
      new vm.Script(s.textContent, { filename: file }).runInContext(context);
  document.dispatchEvent(new w.Event("DOMContentLoaded"));
  const $ = (s) => document.querySelector(s);
  const event = (el, type, properties = {}) => {
    assert.ok(el, "Missing event target");
    const e = new w.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, properties);
    el.dispatchEvent(e);
  };
  const click = (s) => {
    const el = typeof s === "string" ? $(s) : s;
    assert.ok(el, "Missing click target " + s);
    assert.ok(!el.disabled, "Disabled click target " + s);
    event(el, "click");
  };
  const input = (s, value, type = "input") => {
    const el = $(s);
    el.value = value;
    event(el, type);
  };
  const advance = (ms) => {
    const end = now + ms;
    let turns = 0;
    while (true) {
      let next;
      for (const [k, t] of timers)
        if (t.at <= end && (!next || t.at < next[1].at)) next = [k, t];
      if (!next) break;
      if (++turns > 20000) throw new Error("Runaway timers");
      now = next[1].at;
      if (next[1].repeat) next[1].at += next[1].repeat;
      else timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  const emit = (type) => listeners.get(type)?.forEach((fn) => fn());
  const seen = new Set();
  for (const el of document.querySelectorAll("[id]")) {
    assert.ok(!seen.has(el.id), "Duplicate id " + el.id + " in " + file);
    seen.add(el.id);
  }
  for (const el of document.querySelectorAll("[href],[src]")) {
    const target = el.getAttribute("href") || el.getAttribute("src");
    if (!target || /^(https?:|mailto:|data:)/.test(target)) continue;
    const [rel, hash] = target.split("#");
    if (rel)
      assert.ok(
        fs.existsSync(path.resolve(path.dirname(file), rel)),
        "Broken local link " + target + " in " + file,
      );
    else if (hash)
      assert.ok(document.getElementById(hash), "Broken fragment " + target);
  }
  assert.equal(
    document.querySelectorAll("main").length,
    1,
    "One main landmark in " + file,
  );
  assert.equal(
    document.querySelectorAll("h1").length,
    1,
    "One page title in " + file,
  );
  assert.ok(
    document.querySelector('meta[name="viewport"]'),
    "Mobile viewport in " + file,
  );
  assert.equal(
    document.querySelectorAll(
      'script[src],link[rel="stylesheet"],img[src^="http"]',
    ).length,
    0,
    "No external resources in " + file,
  );
  for (const el of document.querySelectorAll(
    "[aria-labelledby],[aria-describedby],[for]",
  ))
    for (const attribute of ["aria-labelledby", "aria-describedby", "for"])
      for (const id of (el.getAttribute(attribute) || "")
        .split(/\s+/)
        .filter(Boolean))
        assert.ok(
          document.getElementById(id),
          "Missing accessible label " + id + " in " + file,
        );
  return { document, $, click, input, event, advance, emit, context, timers };
}
