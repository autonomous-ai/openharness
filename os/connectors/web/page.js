"use strict";
let key = location.hash.slice(1) || sessionStorage.getItem("harness-connections") || "";
if (key) sessionStorage.setItem("harness-connections", key);
history.replaceState(null, "", location.pathname);
const list = document.querySelector("#connections");
const notice = document.querySelector("#notice");
const dialog = document.querySelector("#connect-dialog");
const form = document.querySelector("#connect-form");
const input = document.querySelector("#token");
const save = document.querySelector("#save");
const error = document.querySelector("#connect-error");
let selected = null;

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
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function connect(item) {
  selected = item.connector;
  document.querySelector("#service-name").textContent = "Connect " + item.name;
  document.querySelector("#manage-link").href = item.manage_url;
  error.textContent = "";
  input.value = "";
  dialog.showModal();
  input.focus();
}
async function refresh() {
  const result = await request("/api/connections");
  list.replaceChildren();
  for (const item of result.connections) {
    const row = node("section", "", "service");
    const info = node("div", "");
    info.append(node("h2", item.name));
    const connected = item.state === "connected";
    const state = connected ? (item.account || "Connected") : ({
      expired: "Reconnect this account", unreadable: "Connection settings need attention",
      not_connected: item.manual ? "Not connected" : "Browser sign-in is not available yet"
    }[item.state]);
    info.append(node("div", state, "detail" + (connected ? " connected" : "")));
    if (connected) info.append(node("div",
      item.scopes.length ? "Permissions: " + item.scopes.join(", ") : "Permissions managed at the provider", "detail"));
    row.append(info);
    const actions = node("div", "", "service-actions");
    if (item.manual && item.state !== "connected") {
      const button = node("button", item.state === "not_connected" ? "Connect" : "Reconnect");
      button.addEventListener("click", () => connect(item));
      actions.append(button);
    }
    if (item.state !== "not_connected") {
      const disconnect = node("button", "Disconnect");
      disconnect.addEventListener("click", async () => {
        disconnect.disabled = true;
        try {
          await request("/api/disconnect", {connector: item.connector});
          notice.textContent = item.name + " disconnected here. To revoke the token everywhere, use the service’s settings.";
          await refresh();
        } catch (e) {notice.textContent = e.message; disconnect.disabled = false;}
      });
      actions.append(disconnect);
    } else if (!item.manual) actions.append(node("span", "Unavailable", "unavailable"));
    row.append(actions);
    list.append(row);
  }
}
document.querySelector("#cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {input.value = ""; selected = null;});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  save.disabled = true;
  save.textContent = "Connecting…";
  error.textContent = "";
  try {
    await request("/api/connect", {connector: selected, token: input.value.trim()});
    dialog.close();
    notice.textContent = "Connected. Your agents can use this account now.";
    await refresh();
  } catch (e) {error.textContent = e.message;}
  finally {input.value = ""; save.disabled = false; save.textContent = "Connect";}
});
if (!key) notice.textContent = "Open “harness connections” from the terminal to manage your accounts.";
else refresh().catch(e => {notice.textContent = e.message;});
