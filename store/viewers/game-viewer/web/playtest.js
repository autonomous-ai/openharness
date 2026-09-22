const $ = (id) => document.getElementById(id);
const element = (tag, value, className = "") => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
const describe = (sample) => {
  const stats = sample?.stats || {};
  return [
    Number.isFinite(stats.time)
      ? `${stats.time.toFixed(1)} s`
      : "Recorded frame",
    Number.isFinite(stats.score) ? `score ${stats.score}` : "",
    typeof stats.state === "string" ? stats.state : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

export function createPlaytest(host) {
  let samples = [],
    supported = false,
    session = null,
    busy = false;
  let selected = 0,
    wanted = null,
    restoring = false,
    draft = null,
    generation = 0;
  const locked = () => busy || !!session || !!draft;
  const lock = () => host.lock(locked());
  function render() {
    const seconds = samples.at(-1)?.stats.time - samples[0]?.stats.time;
    $("rewind").disabled =
      busy ||
      !!session ||
      !supported ||
      samples.length < 2 ||
      host.mode() !== "play";
    $("pin-moment").disabled = busy || restoring || !supported;
    $("rewind-status").textContent = session
      ? session.saved
        ? "Saved game and moment"
        : "Choose a moment, then try another move"
      : !supported
        ? "Rewind is unavailable for this game"
        : samples.length > 1
          ? Number.isFinite(seconds) && seconds >= 0
            ? `${seconds.toFixed(1)} s to rewind`
            : `${samples.length} frames to rewind`
          : "Play to record your last 36 seconds";
    $("timeline").hidden = !session;
    if (session) {
      $("timeline-range").max = Math.max(0, session.samples.length - 1);
      $("timeline-range").value = wanted ?? selected;
      $("timeline-range").disabled = busy || session.samples.length < 2;
      $("timeline-position").textContent = describe(session.samples[selected]);
      $("timeline-title").textContent = session.saved
        ? "Saved moment"
        : "Rewind your run";
      $("back-live").textContent = session.saved
        ? "Latest game"
        : "Back to live";
      for (const id of ["back-live", "try-here"])
        $(id).disabled = busy || restoring;
    }
    lock();
  }
  async function select(index) {
    if (
      !session ||
      busy ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= session.samples.length
    )
      return;
    wanted = index;
    if (restoring) return;
    restoring = true;
    const current = session,
      turn = generation;
    render();
    try {
      while (wanted !== null && session === current && turn === generation) {
        const next = wanted;
        wanted = null;
        await host.request("restore", current.samples[next].state);
        if (session !== current || turn !== generation) return;
        selected = next;
      }
    } catch (error) {
      if (turn !== generation) return;
      wanted = null;
      host.toast(`Could not restore this moment: ${error.message}`);
    } finally {
      if (turn === generation) {
        restoring = false;
        render();
      }
    }
  }
  $("timeline-range").oninput = (event) => select(Number(event.target.value));
  $("rewind").onclick = async () => {
    if (locked() || !supported || samples.length < 2) return;
    const turn = generation;
    busy = true;
    const wasPaused = host.paused();
    host.pause(true);
    render();
    try {
      const anchor = await host.request("capture");
      if (turn !== generation) return;
      const frames = [...samples, { ...anchor, at: samples.at(-1).at + 200 }];
      session = { live: anchor, wasPaused, samples: frames };
      selected = frames.length - 1;
      busy = false;
      await select(Math.max(0, selected - 25));
    } catch (error) {
      if (turn !== generation) return;
      host.pause(wasPaused);
      host.toast(error.message);
    } finally {
      if (turn === generation) {
        busy = false;
        render();
      }
    }
  };
  $("back-live").onclick = async () => {
    if (!session || busy || restoring) return;
    if (session.saved) return host.latest();
    const turn = generation;
    busy = true;
    render();
    try {
      await host.request("restore", session.live.state);
      if (turn !== generation) return;
      host.pause(session.wasPaused);
      session = null;
    } catch (error) {
      if (turn === generation) host.toast(error.message);
    } finally {
      if (turn === generation) {
        busy = false;
        render();
      }
    }
  };
  $("try-here").onclick = async () => {
    if (!session || busy || restoring) return;
    const turn = generation;
    busy = true;
    render();
    try {
      await host.resume();
      if (turn !== generation) return;
      samples = session.samples.slice(0, selected + 1);
      session = null;
      busy = false;
      render();
      host.focus();
    } catch (error) {
      if (turn === generation) {
        host.pause(true);
        host.toast(error.message);
      }
    } finally {
      if (turn === generation) {
        busy = false;
        render();
      }
    }
  };
  $("pin-moment").onclick = async () => {
    if (busy || restoring || !supported) return;
    const turn = generation;
    busy = true;
    const wasPaused = host.paused();
    host.pause(true);
    render();
    try {
      const capture = await host.request("capture");
      if (turn !== generation) return;
      draft = { ...capture, id: host.id(), wasPaused };
      $("moment-image").hidden = !capture.image;
      if (capture.image) $("moment-image").src = capture.image;
      $("moment-position").textContent = describe(capture);
      $("moment-note").value = "";
      $("moment-kind").value = "change";
      $("moment-dialog").showModal();
      $("moment-note").focus();
    } catch (error) {
      if (turn === generation) {
        host.pause(wasPaused);
        host.toast(error.message);
      }
    } finally {
      if (turn === generation) {
        busy = false;
        render();
      }
    }
  };
  $("moment-cancel").onclick = () => $("moment-dialog").close();
  $("moment-dialog").addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  $("moment-dialog").addEventListener("close", () => {
    if (draft) host.pause(draft.wasPaused);
    draft = null;
    render();
  });
  $("moment-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!draft || busy) return;
    const turn = generation;
    busy = true;
    $("moment-save").disabled = $("moment-cancel").disabled = true;
    try {
      const saved = await host.post("/api/playtests", {
        id: draft.id,
        kind: $("moment-kind").value,
        note: $("moment-note").value,
        snapshot: { mode: draft.mode, state: draft.state, stats: draft.stats },
        image: draft.image,
      });
      if (turn === generation) $("moment-dialog").close();
      host.toast(`Moment saved to ${saved.path}`);
      await load();
    } catch (error) {
      host.toast(error.message);
    } finally {
      if (turn === generation) {
        busy = false;
        $("moment-save").disabled = $("moment-cancel").disabled = false;
        render();
      }
    }
  };
  async function load() {
    try {
      const response = await fetch("/api/playtests");
      const moments = await response.json();
      if (!response.ok) throw new Error(moments.error);
      $("moments").replaceChildren();
      if (!moments.length)
        $("moments").append(
          element(
            "p",
            "Keep a great move, mark a frustrating spot, or save an idea. Each moment keeps this version of the game, its state, and your note in out/playtests/.",
            "drawer-empty",
          ),
        );
      for (const moment of moments) {
        const card = element("article", "", "moment-card");
        if (moment.image) {
          const img = document.createElement("img");
          img.src = moment.image;
          img.alt = `Saved frame from version ${moment.revision.number}`;
          img.loading = "lazy";
          card.append(img);
        }
        const content = element("div", "", "moment-content");
        content.append(
          element(
            "span",
            `${moment.kind} · version ${moment.revision.number}`,
            "moment-badge",
          ),
        );
        content.append(
          element("p", moment.note || "A moment worth revisiting."),
        );
        content.append(element("small", describe(moment)));
        const open = element("button", "Revisit moment");
        open.onclick = async () => {
          if (busy || draft) return;
          open.disabled = true;
          try {
            await host.open(
              await host.post("/api/playtests/open", { id: moment.id }),
            );
          } catch (error) {
            host.toast(error.message);
          } finally {
            open.disabled = false;
          }
        };
        content.append(open);
        card.append(content);
        $("moments").append(card);
      }
    } catch (error) {
      $("moments").replaceChildren(
        element(
          "p",
          `Could not read saved moments: ${error.message}`,
          "drawer-empty",
        ),
      );
    }
  }
  return {
    load,
    locked,
    activate() {
      generation++;
      if ($("moment-dialog").open) $("moment-dialog").close();
      samples = [];
      supported = false;
      session = draft = wanted = null;
      restoring = busy = false;
      $("moment-save").disabled = $("moment-cancel").disabled = false;
      render();
    },
    async restoreSaved(snapshot) {
      const turn = generation;
      busy = true;
      host.setMode(snapshot.mode === "explore" ? "explore" : "play");
      host.pause(true);
      render();
      try {
        const restored = await host.request("restore", snapshot.state);
        if (turn !== generation) return;
        session = {
          saved: true,
          samples: [{ ...restored, at: performance.now() }],
        };
        selected = 0;
      } catch (error) {
        if (turn === generation)
          host.toast(
            `Saved game opened, but its moment could not be restored: ${error.message}`,
          );
      } finally {
        if (turn === generation) {
          busy = false;
          render();
        }
      }
    },
    message(data) {
      if (
        data.type === "sample" &&
        !locked() &&
        host.mode() === "play" &&
        !host.paused()
      ) {
        samples.push(data);
        if (samples.length > 180) samples.shift();
      }
      if (data.type === "timeline-reset" && !locked()) samples = [];
      if (data.type === "stats") supported = !!data.features.rewind;
      if (data.type === "rewind-unavailable") {
        supported = false;
        host.toast(`Rewind unavailable: ${data.message}`);
      }
      render();
    },
    render,
  };
}
