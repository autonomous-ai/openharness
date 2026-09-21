const $ = (id) => document.getElementById(id);
const token = document.querySelector("meta[name=studio-token]").content;
const frames = new Map();
const offered = new Set(),
  client = crypto.randomUUID();
let state,
  active = null,
  mode = "explore",
  paused = false,
  pending = null,
  requested = null,
  selectedTab = "activity",
  toastTimer,
  lastLease = "",
  followLatest = true;
const phases = [
  ["concept", "Imagine"],
  ["world", "Build"],
  ["play", "Play"],
  ["polish", "Polish"],
  ["check", "Check"],
];
const time = (value) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = String(value ?? "");
  if (className) el.className = className;
  return el;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function command(action, value) {
  frames
    .get(active)
    ?.frame.contentWindow?.postMessage(
      { studioCommand: true, action, value },
      location.origin,
    );
}
function retain(force = false) {
  const ids = [
    ...new Set(
      [active, pending, requested, state?.candidate?.id].filter(
        (id) => id && frames.has(id),
      ),
    ),
  ];
  const key = ids.slice().sort().join(",");
  if (!force && key === lastLease) return;
  lastLease = key;
  void post("/api/retain", { client, ids }).catch(() => {
    lastLease = "";
  });
}
function cleanup() {
  const keep = new Set([active, pending, requested, state?.candidate?.id]);
  for (const [id, entry] of frames)
    if (!keep.has(id)) {
      entry.frame.remove();
      frames.delete(id);
    }
  retain();
}
setInterval(() => retain(true), 30000);
function ensure(revision) {
  if (!revision || frames.has(revision.id)) return;
  offered.add(revision.id);
  const frame = document.createElement("iframe");
  frame.src = revision.url;
  frame.title = `Game preview, version ${revision.number}`;
  frame.tabIndex = -1;
  frame.setAttribute("inert", "");
  frame.setAttribute("allow", "autoplay; fullscreen; gamepad");
  frames.set(revision.id, { frame, revision, ready: false, failed: false });
  $("frames").append(frame);
  retain();
}
function activate(id) {
  const entry = frames.get(id);
  if (!entry?.ready) return;
  for (const [key, item] of frames) {
    const show = key === id;
    item.frame.classList.toggle("active", show);
    item.frame.tabIndex = show ? 0 : -1;
    if (show) item.frame.removeAttribute("inert");
    else {
      item.frame.setAttribute("inert", "");
      item.frame.contentWindow?.postMessage(
        { studioCommand: true, action: "pause", value: true },
        location.origin,
      );
    }
  }
  active = id;
  pending = null;
  requested = null;
  $("update").hidden = true;
  $("empty").hidden = true;
  $("version").textContent = `Version ${entry.revision.number}`;
  $("export").disabled = false;
  setMode("explore");
  setPaused(false);
  renderVersions();
  cleanup();
}
function setMode(value) {
  mode = value;
  $("explore").setAttribute("aria-pressed", String(value === "explore"));
  $("play").setAttribute("aria-pressed", String(value === "play"));
  command("mode", value);
  $("controls").textContent =
    value === "play"
      ? state?.project.controls || "Click the game to use its controls"
      : "Drag to orbit · Scroll to look closer";
  if (value === "play") frames.get(active)?.frame.contentWindow?.focus();
}
function setPaused(value) {
  paused = value;
  command("pause", value);
  $("pause").setAttribute("aria-label", value ? "Resume game" : "Pause game");
  $("pause").setAttribute("aria-pressed", String(value));
}
$("explore").onclick = () => setMode("explore");
$("play").onclick = () => setMode("play");
$("pause").onclick = () => setPaused(!paused);
$("restart").onclick = () => {
  command("restart");
  setPaused(false);
  if (mode === "play") frames.get(active)?.frame.contentWindow?.focus();
};
$("update").onclick = () => {
  followLatest = true;
  activate(pending);
};
$("fit").onclick = () => {
  const on = $("stage").classList.toggle("widescreen");
  $("fit").setAttribute("aria-pressed", String(on));
  $("fit").setAttribute(
    "aria-label",
    on ? "Fit preview to pane" : "Use widescreen preview",
  );
};
function setExpanded(on) {
  document.querySelector(".studio").classList.toggle("expanded", on);
  $("fullscreen").setAttribute(
    "aria-label",
    on ? "Restore studio" : "Expand preview",
  );
}
$("fullscreen").onclick = () =>
  setExpanded(
    !document.querySelector(".studio").classList.contains("expanded"),
  );
addEventListener("keydown", (event) => {
  if (event.code === "Escape") setExpanded(false);
});
$("details").onclick = () => {
  const show = $("drawer").hidden;
  $("drawer").hidden = !show;
  $("details").setAttribute("aria-expanded", String(show));
  if (show && selectedTab === "assets") loadAssets();
};
for (const tab of ["activity", "versions", "assets"])
  $("tab-" + tab).onclick = () => {
    selectedTab = tab;
    for (const other of ["activity", "versions", "assets"]) {
      $(other).hidden = other !== tab;
      $("tab-" + other).setAttribute("aria-selected", String(other === tab));
    }
    if (tab === "assets") loadAssets();
  };
$("export").onclick = async () => {
  try {
    const result = await post("/api/export", { id: active });
    toast(`Saved to ${result.path}`);
  } catch (error) {
    toast(error.message);
  }
};
function renderVersions() {
  $("versions").replaceChildren();
  if (!state?.history.length) {
    $("versions").append(
      text(
        "p",
        "Working versions appear here after they render.",
        "drawer-empty",
      ),
    );
    return;
  }
  for (const version of state.history) {
    const button = document.createElement("button");
    button.className = "checkpoint" + (active === version.id ? " current" : "");
    button.append(
      text("b", `Version ${version.number}`),
      text("p", version.label),
      text("time", time(version.at)),
    );
    button.onclick = () => {
      followLatest = false;
      requested = version.id;
      ensure(version);
      activate(version.id);
    };
    $("versions").append(button);
  }
}
async function loadAssets() {
  try {
    const files = await (await fetch("/api/assets")).json();
    $("assets").replaceChildren();
    if (!files.length) {
      $("assets").append(
        text(
          "p",
          "This world uses procedural geometry. Imported images, models, and audio will appear here.",
          "drawer-empty",
        ),
      );
      return;
    }
    for (const file of files) {
      const link = document.createElement("a");
      link.className = "asset";
      link.href = "/api/asset?path=" + encodeURIComponent(file.path);
      link.download = file.name;
      if (["png", "jpg", "jpeg", "webp", "svg"].includes(file.type)) {
        const img = document.createElement("img");
        img.src = link.href;
        img.alt = file.name;
        link.append(img);
      } else
        link.append(text("div", file.type.toUpperCase() || "FILE", "file"));
      link.append(text("span", file.name));
      $("assets").append(link);
    }
  } catch {
    $("assets").replaceChildren(
      text(
        "p",
        "Could not load assets. Reopen this tab to try again.",
        "drawer-empty",
      ),
    );
  }
}
function render(next) {
  state = next;
  $("title").textContent = state.project.title;
  $("description").textContent = state.project.description;
  document.title = state.project.title + " · Game Studio";
  $("connection").textContent = "Live";
  document.querySelector(".connection").style.color = "";
  const building = state.status === "building";
  $("status-dot").className =
    "status-dot" + (building ? " building" : state.error ? " error" : "");
  $("progress-message").textContent = state.error
    ? "Update needs a fix"
    : building
      ? "Building the next version"
      : state.progress.message ||
        (state.latest
          ? "Your world is ready to explore"
          : "Checking the first rendered frame");
  const phaseIndex = phases.findIndex(([id]) => id === state.progress.phase);
  $("phases").replaceChildren();
  phases.forEach(([id, name], index) => {
    if (index) $("phases").append(text("span", "", "phase-line"));
    const step = text(
      "span",
      name,
      "phase" +
        (index < phaseIndex ? " done" : index === phaseIndex ? " active" : ""),
    );
    if (index === phaseIndex) step.setAttribute("aria-current", "step");
    $("phases").append(step);
  });
  $("error").hidden = !state.error;
  if (state.error) {
    $("error-message").textContent = state.error.message;
    $("error-frame").textContent =
      state.error.frame ||
      [state.error.file, state.error.line].filter(Boolean).join(":");
  }
  $("notice").hidden = !state.error || !active;
  if (state.error && active)
    $("notice").textContent =
      "The next update needs a fix. You can keep playing this version.";
  if (state.error && !active) {
    $("empty").querySelector("h2").textContent = "The first build needs a fix";
    $("empty").querySelector("p").textContent =
      "The details below are available to your agent.";
  }
  $("activity").replaceChildren();
  for (const event of state.activity) {
    const row = text("div", "", `event ${event.kind}`);
    row.append(text("span", event.message), text("time", time(event.at)));
    $("activity").append(row);
  }
  $("log-count").textContent = state.activity.length;
  renderVersions();
  if (state.candidate && !offered.has(state.candidate.id))
    ensure(state.candidate);
  else if (
    !active &&
    !state.candidate &&
    state.latest &&
    !offered.has(state.latest.id)
  ) {
    requested = state.latest.id;
    ensure(state.latest);
  }
  cleanup();
}
addEventListener("message", async (event) => {
  if (event.origin !== location.origin || !event.data?.studio) return;
  const data = event.data,
    entry = frames.get(data.id);
  if (!entry || event.source !== entry.frame.contentWindow) return;
  if (data.type === "escape" && data.id === active) setExpanded(false);
  if (data.type === "ready") {
    if (entry.failed) return;
    entry.ready = true;
    try {
      await post("/api/report", { id: data.id, type: "ready" });
    } catch {
      return;
    }
    if (entry.failed || frames.get(data.id) !== entry) return;
    const newer =
      entry.revision.number > (frames.get(active)?.revision.number || 0);
    if (
      !active ||
      requested === data.id ||
      (newer && mode !== "play" && followLatest)
    )
      activate(data.id);
    else if (
      newer &&
      entry.revision.number > (frames.get(pending)?.revision.number || 0)
    ) {
      pending = data.id;
      $("update").hidden = false;
    }
    cleanup();
  }
  if (data.type === "error") {
    entry.failed = true;
    entry.ready = false;
    try {
      await post("/api/report", {
        id: data.id,
        type: "error",
        message: data.message,
        file: data.file,
        line: data.line,
      });
    } catch {}
    if (pending === data.id) {
      pending = null;
      $("update").hidden = true;
    }
    if (requested === data.id) {
      requested = null;
      toast("That version could not start. Your current preview is unchanged.");
    }
    if (active === data.id) {
      active = null;
      $("empty").hidden = false;
      $("export").disabled = true;
      for (const id of ["play", "pause", "restart"]) $(id).disabled = true;
      const fallback = state?.history.find((version) => version.id !== data.id);
      if (fallback) {
        requested = fallback.id;
        ensure(fallback);
        activate(fallback.id);
        $("empty").querySelector("h2").textContent =
          `Restoring version ${fallback.number}`;
        toast("The preview stopped. Restoring the last working version.");
      } else {
        $("empty").querySelector("h2").textContent = "The preview needs a fix";
        $("empty").querySelector("p").textContent =
          "The details below are available to your agent.";
      }
    }
    cleanup();
  }
  if (data.type === "stats" && data.id === active) {
    const fps = Number(data.stats?.fps),
      objects = Number(data.stats?.objects);
    $("stats").textContent = [
      Number.isFinite(objects) ? `${objects} objects` : "",
      Number.isFinite(fps) ? `${Math.round(fps)} fps` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    $("play").disabled = !data.features.play;
    $("pause").disabled = !data.features.pause;
    $("restart").disabled = !data.features.restart;
  }
  if (data.type === "waiting" && !active)
    $("empty").querySelector("p").textContent = data.message;
});
const events = new EventSource("/api/events");
events.addEventListener("state", (event) => render(JSON.parse(event.data)));
events.onerror = () => {
  $("connection").textContent = "Reconnecting";
  document.querySelector(".connection").style.color = "#ffc198";
};
