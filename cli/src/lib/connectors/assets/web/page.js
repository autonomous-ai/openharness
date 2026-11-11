"use strict";
let key = location.hash.slice(1) || sessionStorage.getItem("harness-connections") || "";
if (key) sessionStorage.setItem("harness-connections", key);
history.replaceState(null, "", location.pathname);
const $ = (selector) => document.querySelector(selector);
const sections = $("#sections");
const notice = $("#notice");
const search = $("#search");
let items = [];
let view = "browse";
const pending = new Map();  // connector -> flow id
// Gmail, Calendar and Drive through this computer's Claude Code or Codex (/api/elsewhere): which engines it has,
// each service's state through them, and what each way lets an agent do.
let engines = {};
let via = {};
let scopes = {};
const ENGINES = [["claude", "Claude", "Claude Code only · via claude.ai"], ["codex", "Codex", "Codex only · via ChatGPT"]];
const working = new Set();  // "connector:engine" while it is being connected or removed
const hasWays = (code) => ENGINES.some(([engine]) => engines[engine] && via[code] && engine in via[code]);
const onVia = (code) => ENGINES.some(([engine]) => engines[engine] && via[code] && (via[code][engine] || "not_connected") !== "not_connected");
let noticeTimer = 0;
// A notice goes away on its own, so a disconnect from earlier does not stand there for good.
function say(text) {
  notice.textContent = text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => {notice.textContent = "";}, 20000);
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {"X-Harness-Connections": key, ...(body ? {"Content-Type": "application/json"} : {})},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not update this connection.");
  return result;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function mark(item) {
  if (item.icon) {
    const image = node("img", "", "mark logo");
    image.src = item.icon;
    image.alt = "";
    return image;
  }
  const tile = node("span", (item.name || "?").trim().charAt(0).toUpperCase(), "mark");
  tile.style.background = item.color || "#59634b";
  return tile;
}
// A service with more than one way in: chips for the ways it is connected by, and Manage (or +) for the choice.
function waysCard(item) {
  const chips = [];
  for (const [engine, name] of ENGINES) {
    const state = engines[engine] ? (via[item.connector] || {})[engine] : undefined;
    if (state === "connected") chips.push(["✓ " + name, ""]);
    else if (state === "installed") chips.push(["✓ " + name + " · sign-in on first use", ""]);
    else if (state === "reconnect") chips.push([name + " · Reconnect", " warn"]);
  }
  if (item.state === "connected") chips.push(["✓ Harness", ""]);
  if (item.state === "reconnect") chips.push(["Harness · Reconnect", " warn"]);
  const box = node("article", "", "card" + (chips.length ? " on" : ""));
  const head = node("div", "", "card-head");
  head.append(mark(item), node("h3", item.name));
  const actions = node("div", "", "card-actions");
  if (pending.has(item.connector)) actions.append(node("span", "Waiting for sign-in…", "hint"));
  else if (chips.length) actions.append(button("Manage", () => openWays(item)));
  else actions.append(button("+", () => openWays(item), "icon plus", "Connect " + item.name));
  head.append(actions);
  box.append(head);
  if (chips.length) {
    const row = node("div", "", "chips");
    for (const [text, tone] of chips) row.append(node("span", text, "badge" + tone));
    box.append(row);
  }
  box.append(node("p", item.description, "about"));
  return box;
}
function card(item) {
  if (hasWays(item.connector)) return waysCard(item);
  const connected = item.state === "connected";
  const box = node("article", "", "card" + (connected ? " on" : ""));
  const head = node("div", "", "card-head");
  head.append(mark(item), node("h3", item.name));
  if (connected) head.append(node("span", item.account || "Signed in", "badge"));
  if (item.state === "reconnect") head.append(node("span", "Reconnect", "badge warn"));
  const actions = node("div", "", "card-actions");
  const waiting = pending.has(item.connector);
  if (waiting) {
    actions.append(node("span", "Waiting for sign-in…", "hint"));
  } else if (item.state !== "not_connected") {
    if (item.state === "reconnect" && !item.custom) actions.append(button("Reconnect", () => connect(item)));
    actions.append(button("×", () => confirmDisconnect(item), "icon", "Disconnect " + item.name));
  } else if (item.reason) {
    // Signs in through the Harness account: shown, but not yet connectable.
    actions.append(node("span", item.reason, "hint"));
    const add = button("+", () => {}, "icon plus", item.reason);
    add.disabled = true;
    actions.append(add);
  } else {
    actions.append(button("+", () => connect(item), "icon plus", "Connect " + item.name));
  }
  head.append(actions);
  box.append(head);
  const about = connected && !item.tools ? item.description + " Agents use it with harness connections call." : item.description;
  box.append(node("p", about, "about"));
  return box;
}
function button(text, action, className, label) {
  const element = node("button", text, className);
  element.type = "button";
  if (label) {element.title = label; element.setAttribute("aria-label", label);}
  element.addEventListener("click", action);
  return element;
}
function render() {
  const query = search.value.trim().toLowerCase();
  const match = (item) => !query || (item.name + " " + item.description).toLowerCase().includes(query);
  const connected = (item) => item.state !== "not_connected" || onVia(item.connector);
  const on = items.filter((item) => connected(item) && match(item));
  const off = items.filter((item) => !connected(item) && match(item));
  sections.replaceChildren();
  const group = (title, list, empty) => {
    const section = node("section", "", "group");
    const heading = node("h2", title + " ");
    heading.append(node("span", String(list.length), "count"));
    section.append(heading);
    const grid = node("div", "", "grid");
    for (const item of list) grid.append(card(item));
    if (!list.length) grid.append(node("p", empty, "empty"));
    section.append(grid);
    sections.append(section);
  };
  group("Connected", on, query ? "No connected service matches." : "Nothing connected yet. Choose a service below.");
  if (view === "browse") group("Available", off, "No service matches.");
}
async function refresh() {
  const result = await request("/api/connections");
  items = result.connections.sort((a, b) => a.name.localeCompare(b.name));
  $("#signed-out").hidden = result.signed_in;
  render();
  // Slower (it asks Claude Code and Codex), so after the list is on screen.
  loadElsewhere().catch(() => {});
}
async function loadElsewhere() {
  const result = await request("/api/elsewhere");
  engines = result.engines || {};
  via = result.connections || {};
  scopes = result.scopes || {};
  // Services only an engine connects (Microsoft 365): a card of their own, where this computer has an engine for them.
  items = items.filter((item) => !item.viaOnly);
  for (const service of result.services || []) {
    if (hasWays(service.connector) && !items.some((item) => item.connector === service.connector)) {
      items.push({...service, state: "not_connected", viaOnly: true});
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  render();
  if (waysItem) renderWays();
}
let waysItem = null;
function openWays(item) {
  waysItem = item;
  renderWays();
  $("#ways-dialog").showModal();
}
// The ways [waysItem] connects: each engine this computer has, then Harness's own, with what each can do.
function renderWays() {
  const item = items.find((i) => i.connector === waysItem.connector) || waysItem;
  const scope = scopes[item.connector] || {};
  $("#ways-title").textContent = "Connect " + item.name;
  const rows = $("#ways-rows");
  rows.replaceChildren();
  const row = (key, title, what, who, state, onConnect, onRemove, blocked) => {
    const line = node("div", "", "way");
    line.dataset.way = key;
    const text = node("div", "", "way-text");
    const name = node("strong", title);
    const status = {connected: "✓ Connected", installed: "✓ Installed", reconnect: "Needs sign-in again"}[state];
    if (status) name.append(node("span", status, "way-state" + (state === "reconnect" ? " warn" : "")));
    text.append(name, node("span", what), node("span", who, "hint"));
    line.append(text);
    if (working.has(item.connector + ":" + key) || (key === "harness" && pending.has(item.connector))) line.append(node("span", "Working…", "hint"));
    else if (blocked) line.append(node("span", blocked, "hint"));
    else if (state && state !== "not_connected" && state !== "reconnect") line.append(button("Remove", onRemove));
    else line.append(button(state === "reconnect" ? "Reconnect" : "Connect", onConnect, "primary"));
    rows.append(line);
  };
  for (const [engine, title, who] of ENGINES) {
    if (!engines[engine]) continue;
    row(engine, title, scope[engine] || "", who, (via[item.connector] || {})[engine] || "not_connected",
      () => connectVia(item, engine), () => disconnectVia(item, engine));
  }
  // Not for a service only an engine connects.
  if (item.viaOnly || !("harness" in scope) && Object.keys(scope).length) return;
  row("harness", "Harness", scope.harness || item.description, "All agents · via Harness", item.state,
    () => {$("#ways-dialog").close(); connect(item);}, () => {$("#ways-dialog").close(); confirmDisconnect(item);},
    item.state === "not_connected" ? item.reason : "");
}
async function connectVia(item, engine) {
  say("");
  const tab = blankTab();
  working.add(item.connector + ":" + engine);
  renderWays();
  try {
    const result = await request("/api/connect_via", {connector: item.connector, via: engine});
    if (tab) tab.location.href = result.url;
    else say("Allow pop-ups for this page, or open " + result.url);
    say(engine === "codex"
      ? "Codex has the " + item.name + " plugin. Connect " + item.name + " in ChatGPT; Codex asks for Google sign-in the first time it uses it."
      : "Connect " + item.name + " on claude.ai. Claude Code on this computer gets it in a moment.");
  } catch (e) {
    if (tab) tab.close();
    say(item.name + ": " + e.message);
  }
  working.delete(item.connector + ":" + engine);
  await loadElsewhere().catch(() => {});
  // Back from the browser: the card shows it as soon as the engine does.
  for (let i = 0; i < 36 && ((via[item.connector] || {})[engine] || "not_connected") === "not_connected"; i++) {
    await new Promise((done) => setTimeout(done, 10000));
    await loadElsewhere().catch(() => {});
  }
}
async function disconnectVia(item, engine) {
  const tab = blankTab();
  working.add(item.connector + ":" + engine);
  renderWays();
  try {
    const result = await request("/api/disconnect_via", {connector: item.connector, via: engine});
    if (tab) tab.location.href = result.url;
    say(engine === "codex"
      ? "Codex stopped using " + item.name + ". To end its access to your Google account, disconnect it in ChatGPT too."
      : "Disconnect " + item.name + " on claude.ai: Claude Code follows your claude.ai account.");
  } catch (e) {
    if (tab) tab.close();
    say(item.name + ": " + e.message);
  }
  working.delete(item.connector + ":" + engine);
  await loadElsewhere().catch(() => {});
}
$("#ways-done").addEventListener("click", () => {$("#ways-dialog").close(); waysItem = null;});
async function follow(item, flow) {
  pending.set(item.connector, flow);
  render();
  try {
    for (;;) {
      await new Promise((done) => setTimeout(done, 1000));
      const status = await request("/api/flows/" + flow);
      if (status.state === "connected") {say(item.name + " connected. Your agents can use it now."); break;}
      if (status.state === "failed") {say(item.name + ": " + status.error); break;}
    }
  } catch (e) {say(e.message);}
  pending.delete(item.connector);
  await refresh().catch((e) => {say(e.message);});
}
function blankTab() {
  const tab = window.open("about:blank", "_blank");
  // The service's page must not be able to reach back into this one.
  if (tab) tab.opener = null;
  return tab;
}
async function connect(item) {
  say("");
  // Open the tab inside the click, so the browser allows it; the address follows.
  const tab = blankTab();
  try {
    const result = await request("/api/connect", {connector: item.connector});
    if (result.authorize_url && tab) tab.location.href = result.authorize_url;
    else if (tab) tab.close();
    if (result.authorize_url && !tab) say("Allow pop-ups for this page to sign in to " + item.name + ".");
    await follow(item, result.flow);
  } catch (e) {
    if (tab) tab.close();
    say(item.name + ": " + e.message);
  }
}
let disconnecting = null;
function confirmDisconnect(item) {
  disconnecting = item;
  $("#confirm-title").textContent = "Disconnect " + item.name + "?";
  $("#confirm-dialog").showModal();
}
$("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close());
$("#confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#confirm-dialog").close();
  const item = disconnecting;
  try {
    await request("/api/disconnect", {connector: item.connector});
    say(item.name + " disconnected.");
    await refresh();
  } catch (e) {say(e.message);}
});
function headers(text) {
  const result = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(":");
    if (at < 1) throw new Error("Write each header as Name: value.");
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}
$("#add").addEventListener("click", () => {
  $("#custom-form").reset();
  $("#custom-error").textContent = "";
  $("#custom-dialog").showModal();
  $("#custom-name").focus();
});
$("#custom-cancel").addEventListener("click", () => $("#custom-dialog").close());
$("#custom-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const save = $("#custom-save");
  const name = $("#custom-name").value.trim();
  let extra;
  try {extra = headers($("#custom-headers").value);} catch (e) {$("#custom-error").textContent = e.message; return;}
  const tab = Object.keys(extra).length ? null : blankTab();
  save.disabled = true;
  try {
    const result = await request("/api/custom", {name, url: $("#custom-url").value.trim(), headers: extra});
    $("#custom-dialog").close();
    if (result.flow) {
      if (result.authorize_url && tab) tab.location.href = result.authorize_url;
      else if (tab) tab.close();
      await follow({connector: "custom:" + name, name}, result.flow);
    } else {
      if (tab) tab.close();
      say(name + " added. Your agents can use it now.");
      await refresh();
    }
  } catch (e) {
    if (tab) tab.close();
    $("#custom-error").textContent = e.message;
  } finally {save.disabled = false;}
});
function show(next) {
  view = next;
  for (const id of ["browse", "connected"]) {
    $("#" + id).classList.toggle("selected", id === next);
    $("#" + id).setAttribute("aria-selected", String(id === next));
  }
  render();
}
$("#browse").addEventListener("click", () => show("browse"));
$("#connected").addEventListener("click", () => show("connected"));
$("#reload").addEventListener("click", () => refresh().catch((e) => {say(e.message);}));
search.addEventListener("input", render);
if (!key) say("Open “harness connections” from the terminal to manage your accounts.");
else refresh().catch((e) => {say(e.message);});
