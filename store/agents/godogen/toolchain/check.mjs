#!/usr/bin/env node
import { readFileSync } from "node:fs";
try {
  const runtime = JSON.parse(
    readFileSync(".harness/studio-runtime.json", "utf8"),
  );
  const url = new URL(runtime.url);
  if (url.hostname !== "127.0.0.1")
    throw new Error("The game viewer must be on loopback");
  const state = await (
    await fetch(new URL("/api/state", url), {
      signal: AbortSignal.timeout(5000),
    })
  ).json();
  if (state.status !== "ready" || state.error || !state.latest?.ready)
    throw new Error(
      state.error?.message ||
        `Preview is ${state.status}. Open the viewer and wait for its first rendered frame.`,
    );
  console.log(
    `ok   Version ${state.latest.number} compiled and rendered without reported runtime errors`,
  );
  console.log(
    "info Play-test controls, goals, and restart before calling the game complete.",
  );
} catch (error) {
  console.error(`fail ${error.message}`);
  process.exitCode = 1;
}
