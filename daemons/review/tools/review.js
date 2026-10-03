/* One pausable clock. Offscreen plates are painted only when they enter the viewport. */
(() => {
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  let motion = !preference.matches,
    time = 0,
    previous = performance.now();
  let timer = null;
  const jobs = new Set(),
    watched = new WeakMap(),
    subscribers = new Set();
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              watched.set(entry.target, entry.isIntersecting);
          },
          { rootMargin: "120px" },
        )
      : null;
  const visible = (element) => {
    if (!element || !observer) return true;
    if (!watched.has(element)) {
      watched.set(element, true);
      observer.observe(element);
    }
    return watched.get(element);
  };
  function setMotion(value) {
    motion = value;
    previous = performance.now();
    document.querySelectorAll("[data-review-motion]").forEach((button) => {
      button.textContent = motion ? "Pause motion" : "Play motion";
      button.setAttribute("aria-pressed", String(!motion));
    });
    subscribers.forEach((fn) => fn(motion));
    schedule();
  }
  const esc = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  function paint(frame, color) {
    const rows = frame.rows.split("\n"),
      mats = (frame.mats || "").split("\n");
    return rows
      .map((row, r) => {
        let html = "",
          run = "",
          key;
        const flush = () => {
          if (run)
            html += key
              ? '<span style="color:' + key + '">' + esc(run) + "</span>"
              : esc(run);
          run = "";
        };
        [...row].forEach((ch, c) => {
          const next = color(rows.length, r, ch, mats[r]?.[c] || ".");
          if (next !== key) {
            flush();
            key = next;
          }
          run += ch;
        });
        flush();
        return html;
      })
      .join("\n");
  }
  function fit(pre, columns, max = 11) {
    if (
      pre.dataset.columns === String(columns) &&
      pre.dataset.fontMax === String(max)
    )
      return;
    pre.dataset.columns = columns;
    pre.dataset.fontMax = max;
    resize.observe(pre.parentElement);
    fitOne(pre);
  }
  function fitOne(pre) {
    const parent = pre.parentElement;
    const style = getComputedStyle(parent);
    const width =
      parent.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    // Measure the actual selected font, including fallback fonts, rather than assuming a cell width.
    const context = measure.getContext("2d");
    context.font = "100px " + getComputedStyle(pre).fontFamily;
    const cell = context.measureText("M").width / 100;
    if (width > 0)
      pre.style.fontSize =
        Math.min(+pre.dataset.fontMax, width / (+pre.dataset.columns * cell)) +
        "px";
  }
  const measure = document.createElement("canvas");
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries)
      entry.target.querySelectorAll("pre[data-columns]").forEach(fitOne);
  });
  window.Review = {
    get motion() {
      return motion;
    },
    now: () => time,
    setMotion,
    visible,
    esc,
    paint,
    fit,
    onMotion(fn) {
      subscribers.add(fn);
    },
    animate(fn, ms = 170, element) {
      const job = { fn, ms, element, last: time };
      jobs.add(job);
      fn(time);
      return () => jobs.delete(job);
    },
    draw(pre, frame, color, key) {
      if (pre.dataset.frame === key) return;
      pre.dataset.frame = key;
      pre.innerHTML = "<span>" + paint(frame, color) + "</span>";
    },
  };
  function tick() {
    const now = performance.now(),
      delta = Math.min(now - previous, 250);
    previous = now;
    if (!motion || document.hidden) return;
    time += delta;
    for (const job of jobs) {
      if (time - job.last >= job.ms && visible(job.element)) {
        job.last = time;
        job.fn(time);
      }
    }
  }
  function schedule() {
    clearInterval(timer);
    timer = null;
    previous = performance.now();
    if (motion && !document.hidden) timer = setInterval(tick, 40);
  }
  document.addEventListener("DOMContentLoaded", () => {
    document
      .querySelectorAll("[data-review-motion]")
      .forEach((button) =>
        button.addEventListener("click", () => setMotion(!motion)),
      );
    setMotion(motion);
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("pagehide", () => clearInterval(timer));
  window.addEventListener("pageshow", schedule);
  preference.addEventListener("change", (event) => setMotion(!event.matches));
})();
