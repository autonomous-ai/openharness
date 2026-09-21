(() => {
  if (window.parent === window) return;
  const id = window.__studioRevision;
  const tell = (type, detail = {}) =>
    window.parent.postMessage(
      { studio: true, id, type, ...detail },
      location.origin,
    );
  let failed = false,
    ready = false;
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
        }
      }),
    );
  });
  addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      !event.data?.studioCommand
    )
      return;
    const game = window.harnessGame;
    try {
      if (event.data.action === "mode") game?.setMode?.(event.data.value);
      if (event.data.action === "pause") game?.setPaused?.(!!event.data.value);
      if (event.data.action === "restart") game?.restart?.();
    } catch (error) {
      fail(error.message);
    }
  });
  addEventListener("keydown", (event) => {
    if (event.code === "Escape")
      queueMicrotask(() => {
        if (!event.defaultPrevented) tell("escape");
      });
  });
  setInterval(() => {
    if (!ready || failed) return;
    try {
      const game = window.harnessGame;
      tell("stats", {
        stats: game?.stats?.() || {},
        features: {
          play: typeof game?.setMode === "function",
          pause: typeof game?.setPaused === "function",
          restart: typeof game?.restart === "function",
        },
      });
    } catch {
      /* statistics never stop the game */
    }
  }, 1000);
  setTimeout(() => {
    if (!ready && !failed)
      tell("waiting", { message: "Waiting for the first rendered frame" });
  }, 15000);
})();
