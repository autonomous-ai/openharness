"use strict";

// Acknowledge the very first installation so the OS can open its first window.
// No startup listener, tab access, timers, or persistent native connection.
chrome.runtime.onInstalled.addListener(({reason}) => {
  if (reason === "install") {
    chrome.runtime.sendNativeMessage("ai.autonomous.harness_home", {action: "installed"}).catch(() => {});
  }
});
