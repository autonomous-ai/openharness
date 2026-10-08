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
function card(item) {
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
    actions.append(node("span", item.reason, "hint"));
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
  const on = items.filter((item) => item.state !== "not_connected" && match(item));
  const off = items.filter((item) => item.state === "not_connected" && match(item));
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
  render();
}
async function follow(item, flow) {
  pending.set(item.connector, flow);
  render();
  try {
    for (;;) {
      await new Promise((done) => setTimeout(done, 1000));
      const status = await request("/api/flows/" + flow);
      if (status.state === "connected") {notice.textContent = item.name + " connected. Your agents can use it now."; break;}
      if (status.state === "failed") {notice.textContent = item.name + ": " + status.error; break;}
    }
  } catch (e) {notice.textContent = e.message;}
  pending.delete(item.connector);
  await refresh().catch((e) => {notice.textContent = e.message;});
}
function blankTab() {
  const tab = window.open("about:blank", "_blank");
  // The service's page must not be able to reach back into this one.
  if (tab) tab.opener = null;
  return tab;
}
async function connect(item) {
  notice.textContent = "";
  // Open the tab inside the click, so the browser allows it; the address follows.
  const tab = blankTab();
  try {
    const result = await request("/api/connect", {connector: item.connector});
    if (result.authorize_url && tab) tab.location.href = result.authorize_url;
    else if (tab) tab.close();
    if (result.authorize_url && !tab) notice.textContent = "Allow pop-ups for this page to sign in to " + item.name + ".";
    await follow(item, result.flow);
  } catch (e) {
    if (tab) tab.close();
    notice.textContent = item.name + ": " + e.message;
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
    notice.textContent = item.name + " disconnected on this computer.";
    await refresh();
  } catch (e) {notice.textContent = e.message;}
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
      notice.textContent = name + " added. Your agents can use it now.";
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
$("#reload").addEventListener("click", () => refresh().catch((e) => {notice.textContent = e.message;}));
search.addEventListener("input", render);
if (!key) notice.textContent = "Open “harness connections” from the terminal to manage your accounts.";
else refresh().catch((e) => {notice.textContent = e.message;});
