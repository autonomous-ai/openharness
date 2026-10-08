"use strict";

const connections = document.querySelector("#connections");
const notice = document.querySelector("#notice");
connections.addEventListener("click", async () => {
  if (connections.disabled) return;
  connections.disabled = true;
  notice.textContent = "Opening Connections…";
  try {
    const response = await chrome.runtime.sendNativeMessage("ai.autonomous.harness_home", {action: "connections"});
    // The native host supplies only this user's authenticated loopback page.
    // Never turn a host response into an arbitrary browser navigation.
    const url = new URL(response.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        Number(url.port) < 1024 || Number(url.port) > 65535 || url.pathname !== "/" ||
        url.search || url.username || url.password || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)) {
      throw new Error("Invalid local page");
    }
    window.location.assign(url.href);
  } catch {
    notice.textContent = "Couldn’t open Connections. Try again, or ask your agent to open Connections.";
    connections.disabled = false;
    connections.focus();
  }
});
// Restore the action after navigating Back, including a page restored from cache.
window.addEventListener("pageshow", () => {
  connections.disabled = false;
  notice.textContent = "";
});
