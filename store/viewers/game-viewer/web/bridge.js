(() => {
  if (window.parent === window) return;
  const id = window.__studioRevision;
  const tell = (type, detail = {}) =>
    window.parent.postMessage(
      { studio: true, id, type, ...detail },
      location.origin,
    );
  let failed = false,
    ready = false,
    mode = "explore",
    paused = true,
    snapshotError = "",
    capturing = false,
    recordedStopped = false;
  const supportsRewind = (game) =>
    typeof game?.captureState === "function" &&
    typeof game?.restoreState === "function" &&
    typeof game?.setPaused === "function";
  function jsonObject(value, limit) {
    if (value?.then) {
      value.catch?.(() => {});
      throw new Error("Game snapshots must be synchronous");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Game snapshots must be JSON objects");
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).length > limit)
      throw new Error("Game snapshot is too large");
    return JSON.parse(json);
  }
  function snapshot(game) {
    return {
      mode,
      state: jsonObject(game.captureState(), 65536),
      stats: jsonObject(game.stats?.() || {}, 8192),
    };
  }
  function restore(game, state) {
    const result = game.restoreState(state);
    if (result?.then) {
      result.catch?.(() => {});
      throw new Error("Restoring game snapshots must be synchronous");
    }
  }
  function screenshot() {
    try {
      const source = document.querySelector(
        "canvas[data-harness-capture], canvas",
      );
      if (!source?.width || !source?.height) return null;
      const target = document.createElement("canvas");
      const scale = Math.min(1, 720 / source.width, 450 / source.height);
      target.width = Math.round(source.width * scale);
      target.height = Math.round(source.height * scale);
      target
        .getContext("2d")
        .drawImage(source, 0, 0, target.width, target.height);
      return target.toDataURL("image/jpeg", 0.78);
    } catch {
      return null;
    }
  }
  const fail = (message, file = "", line = 0) => {
    failed = true;
    tell("error", { message: String(message), file, line });
  };
  addEventListener(
    "error",
    (event) => {
      if (event.target && event.target !== window)
        fail(
          `Could not load ${event.target.src || event.target.href || "an asset"}`,
        );
      else fail(event.message, event.filename, event.lineno);
    },
    true,
  );
  addEventListener("unhandledrejection", (event) =>
    fail(
      event.reason?.message || event.reason || "Unhandled promise rejection",
    ),
  );
  addEventListener("harness:ready", () => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!failed && !ready) {
          ready = true;
          tell("ready");
          sendStats();
        }
      }),
    );
  });
  addEventListener("message", async (event) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      !event.data?.studioCommand
    )
      return;
    const game = window.harnessGame;
    const { action, value, requestId } = event.data;
    if (action === "capture" || action === "restore") {
      if (typeof requestId !== "string") return;
      if (capturing)
        return tell("response", {
          requestId,
          error: "Another moment is still being captured",
        });
      capturing = true;
      try {
        if (!supportsRewind(game))
          throw new Error("This game has no snapshot support");
        if (!paused)
          throw new Error(
            "Pause the game before capturing or restoring a moment",
          );
        if (action === "restore") {
          const backup = snapshot(game).state;
          try {
            restore(game, jsonObject(value, 65536));
          } catch (error) {
            try {
              restore(game, backup);
            } catch {
              /* Keep paused for inspection. */
            }
            throw error;
          }
          game.setPaused(true);
        }
        // Capture the image only after the restored state has actually rendered.
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        tell("response", {
          requestId,
          result: {
            ...snapshot(game),
            ...(action === "capture" ? { image: screenshot() } : {}),
          },
        });
      } catch (error) {
        tell("response", { requestId, error: String(error.message || error) });
      } finally {
        capturing = false;
      }
      return;
    }
    try {
      if (action === "mode") {
        game?.setMode?.(value);
        mode = value;
      }
      if (action === "pause") {
        game?.setPaused?.(!!value);
        paused = !!value;
      }
      if (action === "restart") {
        game?.restart?.();
        recordedStopped = false;
        tell("timeline-reset");
      }
      if (requestId) tell("response", { requestId, result: { ok: true } });
    } catch (error) {
      if (requestId)
        tell("response", { requestId, error: String(error.message || error) });
      fail(error.message);
    }
  });
  addEventListener("harness:timeline-reset", () => {
    recordedStopped = false;
    tell("timeline-reset");
  });
  setInterval(() => {
    const game = window.harnessGame;
    if (
      !ready ||
      failed ||
      paused ||
      mode !== "play" ||
      capturing ||
      snapshotError ||
      !supportsRewind(game)
    )
      return;
    try {
      const sample = snapshot(game);
      if (sample.stats.running === false && recordedStopped) return;
      recordedStopped = sample.stats.running === false;
      tell("sample", { ...sample, at: performance.now() });
    } catch (error) {
      snapshotError = String(error.message || error);
      tell("rewind-unavailable", { message: snapshotError });
    }
  }, 200);
  addEventListener("keydown", (event) => {
    if (event.code === "Escape")
      queueMicrotask(() => {
        if (!event.defaultPrevented) tell("escape");
      });
  });
  function sendStats() {
    if (!ready || failed) return;
    try {
      const game = window.harnessGame;
      tell("stats", {
        stats: game?.stats?.() || {},
        features: {
          play: typeof game?.setMode === "function",
          pause: typeof game?.setPaused === "function",
          restart: typeof game?.restart === "function",
          rewind: supportsRewind(game) && !snapshotError,
        },
      });
    } catch {
      /* statistics never stop the game */
    }
  }
  setInterval(sendStats, 1000);
  setTimeout(() => {
    if (!ready && !failed)
      tell("waiting", { message: "Waiting for the first rendered frame" });
  }, 15000);
})();
