document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id),
    { esc } = Review;
  const R = JSON.parse($("roster-data").textContent);
  const standalone = !!$("all");
  const data = standalone
    ? JSON.parse($("traits-data").textContent)
    : [{ id: "tim", samples: JSON.parse($("tims-data").textContent) }];
  const cards = [],
    sections = [];
  const pct = (list, item) =>
    +((100 * item[1]) / list.reduce((sum, v) => sum + v[1], 0)).toFixed(1) +
    "%";
  for (const group of data) {
    const sp = R.daemons.find((d) => d.id === group.id),
      T = sp.traits;
    let grid = $("timsGrid"),
      section = grid;
    if (standalone) {
      section = document.createElement("section");
      section.className = "sp";
      section.id = "species-" + sp.id;
      section.setAttribute("aria-labelledby", "title-" + sp.id);
      section.innerHTML =
        '<h3 id="title-' +
        sp.id +
        '">' +
        esc(sp.id) +
        "<small>" +
        esc(sp.rarity) +
        "</small></h3>" +
        '<details class="cat"><summary>Colour, markings, shape &amp; odds</summary><p><b>Colours</b> ' +
        T.colours.map((c) => esc(c[0]) + " " + pct(T.colours, c)).join(" · ") +
        "<br><b>Markings</b> " +
        T.marks
          .map((c) => esc(c[0] || "none") + " " + pct(T.marks, c))
          .join(" · ") +
        "<br><b>Shape</b> " +
        Object.entries(T.props)
          .map(([k, v]) => esc(k) + " " + v.join("–"))
          .join(" · ") +
        "<br><b>Extras</b> " +
        T.extras
          .map((c) => esc(c[0] || "none") + " " + pct(T.extras, c))
          .join(" · ") +
        "<br><b>Odd eye</b> " +
        100 * T.oddEye +
        "% · <b>Fidgety</b> " +
        100 * T.fidgety +
        "%</p></details>";
      grid = document.createElement("div");
      grid.className = "grid6";
      section.append(grid);
      $("all").append(section);
      const option = document.createElement("option");
      option.value = sp.id;
      option.textContent = sp.id;
      $("speciesFilter").append(option);
      const link = document.createElement("a");
      link.href = "#species-" + sp.id;
      link.textContent = sp.id;
      link.addEventListener("click", () => {
        $("speciesFilter").value = "";
        $("traitFilter").value = "";
        $("traitSearch").value = "";
        filter();
      });
      $("speciesLinks").append(link);
    }
    sections.push(section);
    for (const sample of group.samples) {
      const card = document.createElement("article");
      card.className = "sample-card";
      const flags = sample.flags
        .replace(/^\S+ /, "")
        .replace("-c ", "-c\u00a0")
        .split(" ")
        .map(
          (f) =>
            "<span>" +
            (T.extras.some((e) => "--" + e[0] === f) || f === "--odd-eye"
              ? "<b>" + esc(f) + "</b>"
              : esc(f)) +
            "</span>",
        )
        .join(" ");
      card.innerHTML =
        '<pre role="img" aria-label="' +
        esc(sample.flags) +
        '"></pre><code class="one" title="In the status line">' +
        esc(sample.oneLine) +
        '</code><div class="rare">1 in ' +
        sample.oneIn.toLocaleString("en-US") +
        '</div><div class="flags">' +
        flags +
        '</div><div class="seed">' +
        esc(sp.id) +
        " · sample seed " +
        sample.traits.seed +
        "</div>";
      grid.append(card);
      const pre = card.querySelector("pre"),
        cache = new Map();
      Review.fit(pre, sample.frames[0].rows.split("\n")[0].length, 8.5);
      const draw = (time) => {
        const index =
          Math.floor(time / R.rules.plate.frameMs) % sample.frames.length;
        if (pre.dataset.frame === String(index)) return;
        if (!cache.has(index))
          cache.set(
            index,
            Review.paint(sample.frames[index], (n, r, ch, mat) =>
              DaemonReview.individualColor(R, sp, sample.traits, n, r, ch, mat),
            ),
          );
        pre.dataset.frame = index;
        pre.innerHTML = "<span>" + cache.get(index) + "</span>";
      };
      Review.animate(draw, R.rules.plate.frameMs, pre);
      cards.push({ card, section, id: sp.id, sample });
    }
  }
  function filter() {
    const id = $("speciesFilter").value,
      trait = $("traitFilter").value,
      query = $("traitSearch").value.trim().toLowerCase();
    let count = 0;
    for (const item of cards) {
      const t = item.sample.traits;
      const matches =
        (!id || id === item.id) &&
        (!query ||
          item.sample.flags.toLowerCase().includes(query) ||
          String(t.seed) === query) &&
        (!trait ||
          (trait === "extra" && t.extra) ||
          (trait === "oddEye" && t.oddEye) ||
          (trait === "fidgety" && t.temper === "fidgety"));
      item.card.hidden = !matches;
      if (matches) count++;
    }
    sections.forEach((section) => {
      section.hidden = !cards.some(
        (c) => c.section === section && !c.card.hidden,
      );
    });
    $("traitEmpty").hidden = count > 0;
    $("traitCount").textContent = count + " of " + cards.length + " samples";
  }
  if (standalone) {
    $("speciesFilter").addEventListener("change", filter);
    $("traitFilter").addEventListener("change", filter);
    $("traitSearch").addEventListener("input", filter);
    $("clearFilters").addEventListener("click", () => {
      $("speciesFilter").value = "";
      $("traitFilter").value = "";
      $("traitSearch").value = "";
      filter();
      $("traitSearch").focus();
    });
    filter();
    const target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
  }
});
