"use strict";

const connections = document.querySelector("#connections");
const notice = document.querySelector("#notice");
connections.addEventListener("click", async () => {
  if (connections.disabled) return;
  connections.disabled = true;
  notice.textContent = "Opening Connections…";
  try {
    const response = await chrome.runtime.sendNativeMessage("ai.autonomous.harness_home", {action: "connections"});
    if (response.ok !== true) throw new Error("Could not open local page");
    notice.textContent = "Opened in a new tab.";
  } catch {
    notice.textContent = "Couldn’t open Connections. Try again, or ask your agent to open Connections.";
  } finally {
    connections.disabled = false;
    connections.focus();
  }
});
// Restore the action after navigating Back, including a page restored from cache.
window.addEventListener("pageshow", () => {
  connections.disabled = false;
  notice.textContent = "";
});
