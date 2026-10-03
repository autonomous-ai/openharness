document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  if (!$("eggGrid")) return;
  const R = JSON.parse($("roster-data").textContent),
    E = JSON.parse($("eggs-data").textContent);
  const A = window.DaemonReview,
    { esc, paint } = Review;
  const LABEL = {
    p0: "Whole",
    p1: "First crack",
    p2: "Across the shell",
    p3: "Light inside",
    p4: "Ready to open",
    rock: "Rocking",
    burst: "Rarity revealed",
    tumble: "Shell falling",
    open: "Open shell",
    hatchling: "Hello, little daemon",
  };
  const INSIDE = {
    common: "tim",
    rare: "bug",
    legendary: "tux",
    secret: "beastie",
  };
  const hints = R.reviewEggs;
  let kind = "first",
    rarity = "common",
    progress = hints.first.need,
    opening = false,
    playing = false,
    cursor = 0,
    spent = 0,
    last = 0;
  let timeline = [];
  let artKey = "";
  const stage = () =>
    A.eggStage(progress, hints[kind].need, progress >= hints[kind].need);
  const daemon = () => R.daemons.find((d) => d.id === INSIDE[rarity]);
  const babyFrames = () => R.plates.daemons[daemon().id].reveal["0.1"].idle;
  const eggPaint = (frame, k, light = "plain", dim = false) =>
    paint(frame, (rows, r, ch, mat) =>
      A.eggColor(R, k, rows, r, ch, mat, { light, dim }),
    );
  const line = (k, s) =>
    A.eggLine(R, k, s, { sprite: R.reviewSprites[INSIDE[rarity]] });
  const pressed = (group, value) =>
    $(group)
      .querySelectorAll("button")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(b.dataset.value === String(value)),
        ),
      );
  function sample(k) {
    return E[k].thumb[0];
  }
  for (const k of Object.keys(hints)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.value = k;
    button.innerHTML =
      '<pre aria-hidden="true"><span>' +
      eggPaint(sample(k), k) +
      '</span></pre><span class="nm">' +
      esc(k) +
      '</span><span class="how">' +
      esc(hints[k].short) +
      "</span><code>" +
      esc(A.eggLine(R, k, "p0")) +
      "</code>";
    button.addEventListener("click", () => {
      kind = k;
      progress = hints[k].need;
      if (!R.rules.eggs[k].weights[rarity])
        rarity = Object.keys(INSIDE).find(
          (r) => R.rules.eggs[k].weights[r] > 0,
        );
      pickers();
      reset();
    });
    $("eggGrid").append(button);
    Review.fit(
      button.querySelector("pre"),
      sample(k).rows.split("\n")[0].length,
      6.4,
    );
  }
  const makeButton = (value, label, action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.value = value;
    b.textContent = label;
    b.addEventListener("click", action);
    return b;
  };
  for (const [r, id] of Object.entries(INSIDE))
    $("eggRarity").append(
      makeButton(r, r + " · " + id, () => {
        rarity = r;
        pressed("eggRarity", r);
        reset();
      }),
    );
  function pickers() {
    pressed("eggGrid", kind);
    pressed("eggRarity", rarity);
    $("eggRarity")
      .querySelectorAll("button")
      .forEach((b) => {
        b.disabled = !R.rules.eggs[kind].weights[b.dataset.value];
        b.title = b.disabled ? "This egg cannot hatch this rarity." : "";
      });
    const el = $("eggProgress");
    el.querySelectorAll("button").forEach((b) => b.remove());
    const n = hints[kind].need,
      counts =
        n <= 6
          ? Array.from({ length: n + 1 }, (_, i) => i)
          : [0, Math.ceil(n / 4), Math.ceil(n / 2), Math.ceil((n * 3) / 4), n];
    el.querySelector(".lbl").textContent = hints[kind].unit;
    counts.forEach((count) =>
      el.append(
        makeButton(
          count,
          count + "/" + n + (count === n ? " ready" : ""),
          () => {
            progress = count;
            pressed("eggProgress", count);
            reset();
          },
        ),
      ),
    );
    pressed("eggProgress", progress);
  }
  function rebuildTimeline() {
    timeline = A.openingTimeline(
      E[kind],
      R.rules.plate.eggMs,
      babyFrames()[0].split("\n").length,
    );
    $("eggScrub").max = timeline.length - 1;
  }
  function controls() {
    $("eggHatch").disabled = stage() !== "p4";
    $("eggHatch").textContent = opening ? "Replay opening" : "Hatch egg";
    $("eggPause").disabled = !opening || cursor === timeline.length - 1;
    $("eggPause").textContent =
      playing && Review.motion ? "Pause opening" : "Resume opening";
    $("eggScrub").disabled = stage() !== "p4";
    $("eggScrub").value = opening ? cursor : 0;
    $("eggFrameCount").textContent = opening
      ? cursor + 1 + " / " + timeline.length
      : "—";
    $("eggScrub").setAttribute(
      "aria-valuetext",
      opening
        ? LABEL[timeline[cursor].stage] +
            ", frame " +
            (cursor + 1) +
            " of " +
            timeline.length
        : "Opening has not started",
    );
    $("eggNote").textContent =
      stage() !== "p4"
        ? "Still earning. Reach " +
          hints[kind].need +
          " " +
          hints[kind].unit +
          " before opening."
        : !Review.motion
          ? "Motion is paused. Hatch shows the final reveal; the frame control still works."
          : hints[kind].detail;
  }
  function risen(count, time) {
    const d = daemon(),
      frames = babyFrames(),
      text = frames[Math.floor(time / R.rules.plate.frameMs) % frames.length],
      rows = text.split("\n");
    const shell = E[kind].open[0],
      shellRows = shell.rows.split("\n"),
      first = Math.max(
        0,
        shellRows.findIndex((r) => r.trim()),
      );
    const dHtml = paint({ rows: text }, (n, r, ch) =>
      A.plateColor(R, d, n, r, ch),
    ).split("\n");
    const sHtml = eggPaint(shell, kind, rarity).split("\n").slice(first);
    return A.risingRows(
      dHtml,
      sHtml,
      rows[0].length,
      shellRows[0].length,
      count,
    ).join("\n");
  }
  function render(time = Review.now()) {
    const step = opening ? timeline[cursor] : null,
      s = step?.stage || stage();
    const reveal = s === "hatchling",
      dim = rarity === "secret" && s === "burst";
    const index = reveal
      ? Math.floor(time / R.rules.plate.frameMs) % babyFrames().length
      : opening
        ? step.index
        : Math.floor(time / R.rules.plate.eggMs.loop) % E[kind][s].length;
    const key = [kind, rarity, s, index, step?.rise].join("|");
    if (key !== artKey) {
      const html = reveal
        ? risen(step.rise, time)
        : eggPaint(
            E[kind][s][index],
            kind,
            ["burst", "tumble", "open"].includes(s) ? rarity : "plain",
            dim,
          );
      $("eggArt").innerHTML = "<span>" + html + "</span>";
      artKey = key;
    }
    $("eggStage").classList.toggle("dark", dim);
    $("eggArt").setAttribute(
      "aria-label",
      kind + " egg · " + LABEL[s] + (reveal ? " · " + daemon().id : ""),
    );
    $("eggLine").textContent = line(kind, s);
    $("eggStageLabel").textContent = kind + " / " + LABEL[s];
    const complete = opening && cursor === timeline.length - 1;
    const caption = complete
      ? "fork() returned 0. It’s a " + daemon().id + ". " + daemon().first
      : opening
        ? "Opening a " + kind + " egg · " + LABEL[s].toLowerCase() + "."
        : hints[kind].detail;
    if ($("eggWords").textContent !== caption)
      $("eggWords").textContent = caption;
    controls();
  }
  function reset() {
    opening = false;
    playing = false;
    cursor = 0;
    spent = 0;
    rebuildTimeline();
    Review.fit(
      $("eggArt"),
      Math.max(
        E[kind].p0[0].rows.split("\n")[0].length,
        babyFrames()[0].split("\n")[0].length,
      ),
      11,
    );
    render();
  }
  $("eggHatch").addEventListener("click", () => {
    if (stage() !== "p4") return;
    opening = true;
    playing = Review.motion;
    spent = 0;
    last = Review.now();
    cursor = Review.motion ? 0 : timeline.length - 1;
    render();
  });
  $("eggPause").addEventListener("click", () => {
    playing = !(playing && Review.motion);
    last = Review.now();
    if (playing && !Review.motion) Review.setMotion(true);
    controls();
  });
  $("eggReset").addEventListener("click", reset);
  $("eggScrub").addEventListener("input", () => {
    opening = true;
    playing = false;
    cursor = +$("eggScrub").value;
    spent = 0;
    render(0);
  });
  Review.onMotion(controls);
  pickers();
  reset();
  Review.animate(
    (time) => {
      const delta = Math.min(80, time - last);
      last = time;
      if (opening && playing) {
        spent += delta;
        while (cursor < timeline.length - 1 && spent >= timeline[cursor].ms) {
          spent -= timeline[cursor].ms;
          cursor++;
        }
        if (cursor === timeline.length - 1) playing = false;
      }
      if (!opening || playing || cursor === timeline.length - 1) render(time);
    },
    40,
    $("eggStage"),
  );
  if ($("states")) {
    const names = [
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "rock",
      "burst",
      "tumble",
      "open",
    ];
    const counts = ["0/40", "10/40", "20/40", "30/40", "40/40", "", "", "", ""];
    names.forEach((s, i) => {
      const frames = E.turn[s],
        frame =
          frames[
            s === "burst"
              ? Math.min(4, frames.length - 1)
              : s === "tumble"
                ? Math.min(3, frames.length - 1)
                : 0
          ];
      const fig = document.createElement("figure");
      fig.innerHTML =
        '<pre role="img" aria-label="Turn egg: ' +
        LABEL[s] +
        '"><span>' +
        eggPaint(frame, "turn", i < 6 ? "plain" : "legendary") +
        '</span></pre><span class="one">' +
        esc(A.eggLine(R, "turn", s)) +
        "</span><figcaption><b>" +
        String(i + 1).padStart(2, "0") +
        " · " +
        LABEL[s] +
        "</b><br>" +
        counts[i] +
        "</figcaption>";
      $("states").append(fig);
      Review.fit(
        fig.querySelector("pre"),
        frame.rows.split("\n")[0].length,
        7.6,
      );
    });
  }
});
