const $ = (id) => document.getElementById(id);
const paths = {
  play: "M7 4l13 8-13 8z",
  pause: "M8 5v14M16 5v14",
  volume: "M11 5L6 9H3v6h3l5 4zM15 8c3 2 3 6 0 8M18 5c5 4 5 10 0 14",
  muted: "M11 5L6 9H3v6h3l5 4zM16 9l5 6m0-6-5 6",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  layers: "M12 3 2 8l10 5 10-5zM2 12l10 5 10-5M2 16l10 5 10-5",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", paths[name]);
  svg.append(p);
  return svg;
}
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => el.replaceChildren(icon(el.dataset.icon)));
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}
const film = $("film");
let state = null,
  current = null,
  project = null,
  tab = "shots",
  events = null,
  pending = null,
  fetching = false,
  lastDesk = "",
  noteDraft = "",
  toastTimer;
const time = (seconds) => {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};
const media = (path) =>
  `/media/${encodeURIComponent(project)}/${path.split("/").map(encodeURIComponent).join("/")}`;
const thumb = (path, width = 640, revision = "") =>
  `/thumb/${encodeURIComponent(project)}/${path.split("/").map(encodeURIComponent).join("/")}?w=${width}&v=${encodeURIComponent(revision)}`;
const identity = (r) => (r ? `${r.path}:${r.revision}` : "");
function toast(text, download) {
  clearTimeout(toastTimer);
  $("toast").replaceChildren(document.createTextNode(text));
  if (download) {
    const a = el("a", "", "Download");
    a.href = download;
    a.download = "";
    $("toast").append(a);
  }
  $("toast").classList.remove("hidden");
  toastTimer = setTimeout(
    () => $("toast").classList.add("hidden"),
    download ? 16000 : 5000,
  );
}
function transport() {
  const playing = !film.paused;
  $("screen").classList.toggle("playing", playing);
  $("play").replaceChildren(icon(playing ? "pause" : "play"));
  $("play").setAttribute("aria-label", playing ? "Pause film" : "Play film");
  $("clock").textContent = time(film.currentTime);
  if (document.activeElement !== $("seek"))
    $("seek").value = String(film.currentTime || 0);
  const stamp = $("note-time");
  if (stamp) stamp.textContent = `At ${time(film.currentTime)}`;
  document.querySelectorAll(".shot").forEach((button) => {
    button.classList.toggle(
      "active",
      film.currentTime >= Number(button.dataset.start) &&
        film.currentTime < Number(button.dataset.end),
    );
  });
}
function choose(render) {
  current = render;
  pending = null;
  $("new-cut").classList.add("hidden");
  film.pause();
  if (!render) {
    film.removeAttribute("src");
    film.load();
    $("empty").classList.remove("hidden");
    $("big-play").classList.add("hidden");
  } else {
    film.poster = thumb(render.path, 960, render.revision);
    film.src = `${media(render.path)}?v=${encodeURIComponent(render.revision)}`;
    film.load();
    $("empty").classList.add("hidden");
    $("big-play").classList.remove("hidden");
    $("film-meta").textContent = `${render.width} × ${render.height}`;
    $("duration").textContent = time(render.duration);
    $("seek").max = String(render.duration);
    $("screen-label").textContent = state?.starter
      ? "AFTERGLOW · EDITABLE STARTER"
      : "YOUR FILM";
    $("versions").value = identity(render);
    $("cut-description").textContent =
      `${render.audio ? "With audio" : "No audio"} · ${time(render.duration)}`;
  }
  for (const id of ["play", "mute", "full", "seek", "export"])
    $(id).disabled = !render;
  transport();
  lastDesk = "";
  renderDesk();
}
async function play() {
  if (!current) return;
  try {
    film.paused ? await film.play() : film.pause();
  } catch {
    toast("Playback could not start. Select the cut again to reload it.");
  }
}
$("play").onclick = play;
$("big-play").onclick = play;
film.onclick = play;
film.addEventListener("timeupdate", transport);
film.addEventListener("play", transport);
film.addEventListener("pause", transport);
film.addEventListener("ended", transport);
film.addEventListener("error", () => {
  if (current)
    toast(
      "This cut could not be played. Your other versions are still available.",
    );
});
$("seek").oninput = () => {
  film.currentTime = Number($("seek").value);
  transport();
};
$("mute").onclick = () => {
  film.muted = !film.muted;
  $("mute").replaceChildren(icon(film.muted ? "muted" : "volume"));
  $("mute").setAttribute(
    "aria-label",
    film.muted ? "Unmute audio" : "Mute audio",
  );
};
$("full").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($("screen").requestFullscreen)
      await $("screen").requestFullscreen();
    else if (film.webkitEnterFullscreen) film.webkitEnterFullscreen();
    else toast("Use Harness’s pane expansion shortcut for a larger view.");
  } catch {
    toast("Use Harness’s pane expansion shortcut for a larger view.");
  }
};
$("versions").onchange = () =>
  choose(state.renders.find((r) => identity(r) === $("versions").value));
$("new-cut").onclick = () => {
  if (pending) choose(pending);
};
async function post(path, body) {
  const r = await fetch(`/api/studio/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-film-token": state.token,
    },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.detail || "The action could not be completed");
  return result;
}
$("export").onclick = async () => {
  if (!current) return;
  const snapshot = current,
    owner = project;
  $("export").disabled = true;
  try {
    const r = await post("export", {
      project: owner,
      path: snapshot.path,
      revision: snapshot.revision,
    });
    toast(`Saved to ${r.file}`, r.download);
  } catch (e) {
    toast(e.message);
  } finally {
    $("export").disabled = !current;
  }
};
function selectTab(name) {
  if ($("note-input")) noteDraft = $("note-input").value;
  tab = name;
  document.querySelectorAll(".tab").forEach((button) => {
    const selected = button.dataset.tab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $("panel").setAttribute("aria-labelledby", `tab-${name}`);
  lastDesk = "";
  renderDesk();
}
document.querySelectorAll(".tab").forEach((button) => {
  button.onclick = () => selectTab(button.dataset.tab);
  button.onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const names = ["shots", "script", "notes"];
    selectTab(
      names[(names.indexOf(tab) + (e.key === "ArrowRight" ? 1 : 2)) % 3],
    );
    $(`tab-${tab}`).focus();
  };
});
function shotPanel() {
  const shots = state.storyboard?.scenes || [];
  if (!shots.length)
    return el(
      "p",
      "muted",
      "Your shot plan will appear here as the agent writes it.",
    );
  const grid = el("div", "shots");
  for (const [index, shot] of shots.entries()) {
    const b = el("button", "shot");
    b.type = "button";
    b.dataset.start = shot.start_seconds || 0;
    b.dataset.end = shot.end_seconds || 0;
    b.setAttribute(
      "aria-label",
      `Scene ${index + 1}: ${shot.description || shot.id}`,
    );
    const picture = el("div", "shot-picture");
    if (shot.visual?.exists && shot.visual.path) {
      const img = el("img");
      img.src = thumb(shot.visual.path, 640, shot.visual.revision);
      img.alt = shot.description || `Scene ${index + 1}`;
      img.loading = "lazy";
      img.onerror = () =>
        img.replaceWith(
          el(
            "div",
            "shot-placeholder",
            shot.generating ? "Creating this shot" : "Preview coming",
          ),
        );
      picture.append(img);
    } else
      picture.append(
        el(
          "div",
          "shot-placeholder",
          shot.generating ? "Creating this shot" : "Shot planned",
        ),
      );
    picture.append(
      el("span", "number", String(index + 1).padStart(2, "0")),
      el(
        "span",
        "duration",
        `${Number(shot.duration_seconds || 0).toFixed(1)}s`,
      ),
    );
    b.append(
      picture,
      el("h3", "", shot.description || `Scene ${index + 1}`),
      el("p", "", shot.shot_intent || shot.narration || shot.type || ""),
    );
    b.onclick = () => {
      if (current) {
        film.currentTime = Math.min(
          current.duration,
          Number(shot.start_seconds) || 0,
        );
        film.pause();
        transport();
      } else
        toast(
          shot.shot_intent ||
            shot.description ||
            "The shot is still being made.",
        );
    };
    grid.append(b);
  }
  return grid;
}
function scriptPanel() {
  const sections = state.artifacts?.script?.sections || [];
  if (!sections.length)
    return el(
      "p",
      "muted",
      "The screenplay will appear here as the agent writes it.",
    );
  const page = el("div", "script");
  for (const [index, section] of sections.entries()) {
    const row = el("article", "script-section");
    const body = el("div");
    body.append(
      el("h3", "", section.label || `Scene ${index + 1}`),
      el("p", "", section.text || ""),
    );
    row.append(el("span", "", String(index + 1).padStart(2, "0")), body);
    page.append(row);
  }
  return page;
}
function notesPanel() {
  const wrap = el("div");
  const editor = el("form", "notes-editor");
  const input = el("textarea", "note-input");
  input.id = "note-input";
  input.maxLength = 2000;
  input.rows = 2;
  input.value = noteDraft;
  input.placeholder = current
    ? "Pause at a moment. Leave a direction for the next cut…"
    : "The first cut needs to be ready before you can leave a timed note.";
  input.setAttribute("aria-label", "Review note");
  input.disabled = !current;
  input.oninput = () => (noteDraft = input.value);
  const toolbar = el("div", "note-toolbar");
  const stamp = el("span", "note-time", `At ${time(film.currentTime)}`);
  stamp.id = "note-time";
  const save = el("button", "button small", "Save note");
  save.type = "submit";
  save.disabled = !current;
  toolbar.append(stamp, save);
  editor.append(input, toolbar);
  editor.onsubmit = async (e) => {
    e.preventDefault();
    if (!current || !input.value.trim()) return;
    save.disabled = true;
    try {
      await post("notes", {
        project,
        path: current.path,
        revision: current.revision,
        seconds: film.currentTime,
        text: input.value,
      });
      noteDraft = "";
      input.value = "";
      toast("Note saved. Ask the agent to apply your review notes.");
      await refresh();
      lastDesk = "";
      renderDesk();
    } catch (error) {
      toast(error.message);
    } finally {
      save.disabled = !current;
    }
  };
  wrap.append(editor);
  const list = el("div", "notes-list");
  for (const note of (state.notes || []).toReversed()) {
    const row = el("article", "note");
    const jump = el("button", "stamp", time(note.seconds));
    jump.setAttribute("aria-label", `Go to note at ${time(note.seconds)}`);
    jump.onclick = () => {
      const r = state.renders.find(
        (r) => r.path === note.render && r.revision === note.revision,
      );
      if (!r) {
        toast(
          "That version has been removed or replaced. The note is preserved.",
        );
        return;
      }
      if (identity(r) !== identity(current)) choose(r);
      const seek = () => {
        film.currentTime = Math.min(note.seconds, r.duration);
        film.pause();
        transport();
      };
      film.readyState >= 1
        ? seek()
        : film.addEventListener("loadedmetadata", seek, { once: true });
    };
    const body = el("div");
    body.append(el("p", "", note.text), el("small", "", PathName(note.render)));
    row.append(jump, body);
    list.append(row);
  }
  if (!(state.notes || []).length)
    list.append(
      el(
        "p",
        "muted",
        "Notes are saved with this production. They never send a message or spend credits on your behalf.",
      ),
    );
  wrap.append(list);
  return wrap;
}
function PathName(path) {
  return String(path).split("/").at(-1) || "Cut";
}
function renderDesk() {
  if (!state) return;
  const hash = JSON.stringify([
    project,
    tab,
    state.storyboard,
    state.artifacts?.script,
    state.notes,
    !!current,
  ]);
  if (hash === lastDesk) return;
  if (tab === "notes" && document.activeElement?.id === "note-input") return;
  lastDesk = hash;
  $("panel").replaceChildren(
    tab === "shots"
      ? shotPanel()
      : tab === "script"
        ? scriptPanel()
        : notesPanel(),
  );
  transport();
}
function apply(next) {
  state = next;
  const changed = project !== next.project_id;
  if (changed) {
    project = next.project_id;
    current = null;
    pending = null;
    noteDraft = "";
    events?.close();
    if (project) {
      events = new EventSource(
        `/api/project/${encodeURIComponent(project)}/events`,
      );
      events.onmessage = (event) => {
        try {
          if (JSON.parse(event.data).type === "change") refresh();
        } catch {}
      };
      events.onerror = () => showConnection("Reconnecting to the production…");
    }
  }
  $("title").textContent = next.title || "Your next film";
  document.title = `${next.title || "Film"} · Film Studio`;
  const shots = next.storyboard?.scenes || [];
  const length =
    next.storyboard?.total_duration_seconds || next.renders?.[0]?.duration || 0;
  $("subtitle").textContent = project
    ? `${next.starter ? "Editable starter · " : ""}${shots.length} shots${length ? ` · ${time(length)}` : ""} · OpenMontage`
    : "Describe a film in the agent pane to begin.";
  $("shot-count").textContent = shots.length || "";
  $("note-count").textContent = next.notes?.length || "";
  $("production-link").href = project
    ? `/p/${encodeURIComponent(project)}`
    : "/";
  const progress = next.render_progress || {},
    running = progress.status === "rendering",
    failed = progress.status === "failed";
  document.querySelector(".production-state").classList.toggle("busy", running);
  document.querySelector(".production-state").classList.toggle("error", failed);
  const active = next.stages?.find((s) =>
    ["in_progress", "awaiting_human"].includes(s.status),
  );
  $("production-status").textContent = failed
    ? "The next render failed. Your previous cut is still here."
    : running
      ? "Rendering the next cut. You can keep watching."
      : active
        ? `${active.name.replaceAll("_", " ")} · ${active.status === "awaiting_human" ? "Waiting for your review" : "In progress"}`
        : next.renders?.length
          ? "Ready when you are."
          : "Your production is taking shape.";
  const spent = next.cost?.total_spent_usd;
  $("spend").textContent = Number.isFinite(spent)
    ? `Generation spend $${spent.toFixed(2)}`
    : "";
  $("stages").classList.toggle("hidden", !next.has_pipeline_state);
  $("stages").replaceChildren(
    ...(next.stages || []).map((s) =>
      el("span", `stage ${s.status}`, s.name.replaceAll("_", " ")),
    ),
  );
  const renders = next.renders || [];
  $("versions").replaceChildren(
    ...(renders.length
      ? renders.map((r, i) => {
          const o = el(
            "option",
            "",
            `${i === 0 ? "Latest cut" : `Earlier cut ${renders.length - i}`} · ${time(r.duration)}`,
          );
          o.value = identity(r);
          return o;
        })
      : [el("option", "", "No cut yet")]),
  );
  $("versions").disabled = !renders.length;
  if (!current && renders.length) choose(renders[0]);
  else if (current && !renders.some((r) => identity(r) === identity(current))) {
    if (!film.paused) {
      pending = renders[0];
    } else choose(renders[0] || null);
  } else if (!renders.length && !current) choose(null);
  if (current) {
    $("versions").value = identity(current);
    if (renders[0] && identity(renders[0]) !== identity(current)) {
      pending = renders[0];
      $("new-cut").classList.remove("hidden");
    }
  }
  renderDesk();
}
function showConnection(message) {
  $("connection").textContent = message;
  $("connection").classList.toggle("hidden", !message);
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch("/api/studio", { cache: "no-store" });
    if (!response.ok)
      throw Error(
        "The production could not be read. Check film.json and the agent output.",
      );
    const next = await response.json();
    showConnection("");
    apply(next);
  } catch (error) {
    showConnection(
      state
        ? "Connection interrupted. Your current cut stays playable."
        : error.message,
    );
  } finally {
    fetching = false;
  }
}
document.addEventListener("keydown", (e) => {
  if (
    e.target.closest("input,textarea,select,button,a") ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    play();
  } else if (current && ["ArrowLeft", "ArrowRight", "j", "l"].includes(e.key)) {
    e.preventDefault();
    film.currentTime = Math.max(
      0,
      Math.min(
        current.duration,
        film.currentTime + (["ArrowLeft", "j"].includes(e.key) ? -2 : 2),
      ),
    );
  } else if (e.key === "n") {
    selectTab("notes");
    $("note-input")?.focus();
  }
});
await refresh();
const poll = setInterval(refresh, 2500);
window.addEventListener("pagehide", () => {
  clearInterval(poll);
  events?.close();
  film.pause();
});
