const C = globalThis.DataStudioCore,
  $ = (s) => document.querySelector(s),
  clone = (v) => structuredClone(v);
const bytes = (s) => new TextEncoder().encode(s),
  hash = async (v) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", v)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
const label = (s) => s.replaceAll("_", " "),
  el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
let current = null,
  selected = "",
  pageIndex = 0,
  sourceId = null,
  worker = null,
  cancelCalculation = null,
  busy = false,
  assetsPromise;
const status = (text, error = false) => {
  $("#status").textContent = text;
  $("#status").classList.toggle("error", error);
};
const download = (name, data, type = "application/json") => {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
async function get(url, binary = false) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      url +
        ": " +
        response.status +
        " — run the build helper if this is a fresh workspace.",
    );
  const data = await response.arrayBuffer();
  if (data.byteLength > 16 * 1024 * 1024)
    throw new Error("File exceeds 16 MiB.");
  return binary ? data : new TextDecoder("utf-8", { fatal: true }).decode(data);
}
async function assets() {
  if (!assetsPromise)
    assetsPromise = (async () => {
      const [vendor, core, code, wasm, pins] = await Promise.all([
        get("vendor/sqlite3.js"),
        get("core.js"),
        get("worker.js"),
        get("vendor/sqlite3.wasm", true),
        get("vendor/checksums.json"),
      ]);
      const expected = JSON.parse(pins);
      if (
        (await hash(bytes(vendor))) !== expected["sqlite3.js"] ||
        (await hash(wasm)) !== expected["sqlite3.wasm"]
      )
        throw new Error("SQLite runtime checksum mismatch.");
      return {
        code:
          "globalThis.sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-sahpool':true,'opfs-wl':true,kvvfs:true}}};\n" +
          vendor +
          "\n" +
          core +
          "\n" +
          code,
        wasm,
      };
    })().catch((e) => {
      assetsPromise = null;
      throw e;
    });
  return assetsPromise;
}
function setBusy(value) {
  busy = value;
  document.body.dataset.busy = String(value);
  if (!value) $("#cancel-run").hidden = true;
  for (const id of [
    "save-project",
    "export-db",
    "export-report",
    "export-csv",
    "export-json",
    "run-sql",
    "download-source",
  ])
    $("#" + id).disabled = value || !current;
  $("#filters")
    .querySelectorAll("button")
    .forEach((b) => (b.disabled = value));
}
async function calculate(bundle, parameters) {
  const a = await assets();
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([a.code], { type: "text/javascript" }),
    );
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    const finish = (error, value) => {
      clearTimeout(timer);
      worker?.terminate();
      worker = null;
      cancelCalculation = null;
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "20-second query budget exceeded; narrow the data or query.",
          ),
        ),
      20000,
    );
    cancelCalculation = () => finish(new Error("Query cancelled."));
    $("#cancel-run").hidden = false;
    worker.onerror = (event) =>
      finish(new Error(event.message || "SQLite worker failed."));
    worker.onmessage = ({ data }) =>
      data.error ? finish(new Error(data.error)) : finish(null, data);
    worker.postMessage({ bundle, parameters, wasm: a.wasm });
  });
}
$("#cancel-run").onclick = () => cancelCalculation?.();
async function commit(bundle, view, { baseline = null } = {}) {
  if (busy) return false;
  setBusy(true);
  status("Checking source types, joins and saved queries…");
  try {
    C.validateConfig(bundle.config);
    C.validateView(view, bundle.config);
    const result = await calculate(bundle, view.parameters),
      revision = await hash(bytes(C.stable(bundle)));
    C.verifyLinks(bundle, result.report.results);
    if (
      baseline &&
      (baseline.revision !== revision ||
        C.stable(baseline.parameters) !== C.stable(result.report.parameters) ||
        C.stable(baseline.results) !== C.stable(result.report.results))
    )
      throw new Error(
        "Browser results disagree with the saved native build. Rebuild and investigate before using them.",
      );
    result.report.revision = revision;
    current = {
      bundle: clone(bundle),
      view: { ...clone(view), parameters: result.report.parameters },
      ...result,
    };
    selected = view.selectedQuery;
    pageIndex = 0;
    render();
    status(
      (bundle.config.example ? "Synthetic example · " : "") +
        result.report.records +
        " source records · " +
        result.report.checks.length +
        " checks passed" +
        (baseline
          ? " · browser and saved SQLite results agree."
          : " · analysis recalculated. Save project to keep changes."),
    );
    document.body.dataset.ready = "true";
    return true;
  } catch (error) {
    status(
      error.message +
        (current
          ? " Last good analysis is still shown; the attempted change was not applied."
          : ""),
      true,
    );
    return false;
  } finally {
    setBusy(false);
  }
}
function viewFromControls() {
  const view = clone(current.view);
  for (const p of current.bundle.config.parameters.filter((p) => !p.hidden)) {
    const value = $("#param-" + p.id).value;
    view.parameters[p.id] = ["integer", "real"].includes(p.type)
      ? Number(value)
      : value;
  }
  view.notes = $("#notes").value;
  view.selectedQuery = selected;
  return view;
}
function render() {
  const c = current.bundle.config,
    r = current.report;
  $("#title").textContent = c.title;
  document.title = c.title + " · Data Studio";
  $("#question").textContent = c.question;
  $("#example").textContent = c.example
    ? "SYNTHETIC EXAMPLE DATA"
    : "USER-SUPPLIED DATA";
  $("#method").textContent = c.method;
  $("#limitations").replaceChildren(...c.limitations.map((v) => el("li", v)));
  $("#notes").value = current.view.notes;
  $("#revision").textContent = "REVISION " + r.revision.slice(0, 16);
  $("#revision").title = r.revision;
  $("#engine").textContent = r.engine;
  $("#check-count").textContent = r.checks.length + " passed";
  $("#check-summary").textContent =
    c.tables.length + " files · " + r.records + " records";
  const sources = $("#sources");
  sources.replaceChildren();
  for (const t of c.tables) {
    const b = el("button", t.file.split("/").pop(), "source-button");
    b.dataset.source = t.id;
    b.append(
      el(
        "small",
        t.columns.length +
          " typed columns" +
          (t.key ? " · key: " + t.key.join(" + ") : ""),
      ),
    );
    b.onclick = () => showSource(t.id);
    sources.append(b);
  }
  const nav = $("#queries");
  nav.replaceChildren();
  for (const q of c.queries.filter((q) => q.kind !== "metric")) {
    const b = el("button", q.title, "query-button");
    b.dataset.query = q.id;
    b.setAttribute("aria-pressed", String(selected === q.id));
    b.onclick = () => {
      if (busy) return;
      selected = q.id;
      current.view.selectedQuery = selected;
      pageIndex = 0;
      renderQuery();
    };
    nav.append(b);
  }
  const filters = $("#filters");
  filters.replaceChildren();
  for (const p of c.parameters.filter((p) => !p.hidden)) {
    const l = el("label", p.label),
      input = el(p.choices ? "select" : "input");
    input.id = "param-" + p.id;
    if (p.choices)
      for (const choice of p.choices) {
        const o = el("option", choice || "All");
        o.value = choice;
        input.append(o);
      }
    else {
      input.type =
        p.type === "date"
          ? "date"
          : ["integer", "real"].includes(p.type)
            ? "number"
            : "text";
      if (p.type === "real") input.step = "any";
    }
    input.value = String(current.view.parameters[p.id]);
    input.oninput = () =>
      status(
        "Controls changed, but the displayed result still uses the last applied controls. Apply controls to recalculate.",
      );
    l.append(input);
    filters.append(l);
  }
  const run = el("button", "Apply controls", "primary");
  run.type = "button";
  run.id = "apply-controls";
  run.onclick = () => {
    if (current && !busy) commit(current.bundle, viewFromControls());
  };
  filters.append(run);
  const reset = el("button", "Reset");
  reset.type = "button";
  reset.onclick = () => {
    if (!busy)
      commit(current.bundle, {
        ...clone(current.view),
        notes: $("#notes").value,
        parameters: C.parameters(c, {}),
      });
  };
  filters.append(reset);
  const metrics = $("#metrics");
  metrics.replaceChildren();
  for (const q of c.queries.filter((q) => q.kind === "metric")) {
    const result = r.results.find((x) => x.id === q.id);
    result.columns.forEach((col, i) => {
      const card = el("div", undefined, "metric");
      card.dataset.metric = col;
      card.append(
        el("div", label(col), "label"),
        el("strong", C.format(result.rows[0][i], q.formats?.[col])),
        el("small", q.title),
      );
      metrics.append(card);
    });
  }
  renderQuery();
  $("#checks").replaceChildren(
    ...r.checks.map((check) => {
      const item = el("section");
      item.append(el("p", "✓ " + check.description));
      if (check.nulls)
        item.append(
          el("pre", JSON.stringify({ missingValues: check.nulls }, null, 2)),
        );
      return item;
    }),
  );
}
function renderQuery() {
  const q =
      current.bundle.config.queries.find((q) => q.id === selected) ??
      current.bundle.config.queries[0],
    r = current.report.results.find((r) => r.id === q.id);
  selected = q.id;
  current.view.selectedQuery = selected;
  $("#query-title").textContent = q.title;
  $("#query-explanation").textContent = q.explanation;
  $("#sql").value = current.bundle.sql[q.file];
  $("#result-table").dataset.query = q.id;
  $("#queries")
    .querySelectorAll("button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.query === selected)),
    );
  const chart = $("#chart"),
    axis = $("#axis");
  chart.replaceChildren();
  axis.replaceChildren();
  chart.hidden = q.kind !== "bar";
  axis.hidden = q.kind !== "bar" || !r.rows.length;
  if (q.kind === "bar" && r.rows.length) {
    const xi = r.columns.indexOf(q.x),
      yi = r.columns.indexOf(q.y),
      values = r.rows.map((row) => row[yi]).filter((v) => v !== null),
      min = Math.min(0, ...values),
      max = Math.max(q.formats?.[q.y]?.style === "percent" ? 1 : 0, ...values),
      range = max - min || 1,
      zero = ((0 - min) / range) * 100;
    for (const row of r.rows) {
      const value = row[yi],
        b = el(q.trace ? "button" : "div", undefined, "bar-row");
      b.dataset.category = String(row[xi]);
      b.setAttribute(
        "aria-label",
        String(row[xi]) + ": " + C.format(value, q.formats?.[q.y]),
      );
      b.append(el("span", String(row[xi]), "bar-label"));
      const track = el("span", undefined, "bar-track"),
        line = el("span", undefined, "zero");
      line.style.left = zero + "%";
      track.append(line);
      if (value === null) track.append(el("span", "Missing", "null-bar"));
      else {
        const bar = el(
          "span",
          undefined,
          "bar" + (value < 0 ? " negative" : ""),
        );
        bar.style.left = ((Math.min(0, value) - min) / range) * 100 + "%";
        bar.style.width = (Math.abs(value) / range) * 100 + "%";
        track.append(bar);
      }
      b.append(
        track,
        el("span", C.format(value, q.formats?.[q.y]), "bar-value"),
      );
      if (q.trace) b.onclick = () => trace(q, row, r.columns);
      chart.append(b);
    }
    axis.append(
      el("span", C.format(min, q.formats?.[q.y])),
      el("span", C.format(max, q.formats?.[q.y])),
    );
  }
  const table = $("#result-table"),
    head = el("thead"),
    tr = el("tr");
  r.columns.forEach((col) => tr.append(el("th", label(col))));
  head.append(tr);
  const body = el("tbody"),
    start = pageIndex * 50;
  for (const row of r.rows.slice(start, start + 50)) {
    const tr = el("tr");
    row.forEach((v, i) => {
      const col = r.columns[i],
        td = el(
          "td",
          undefined,
          v === null ? "missing" : typeof v === "number" ? "numeric" : "",
        );
      if (q.sourceLinks?.[col] && v !== null) {
        const b = el("button", "record " + v + " ↗", "source-link");
        b.dataset.record = String(v);
        b.dataset.table = q.sourceLinks[col];
        b.onclick = () => showSource(q.sourceLinks[col], v);
        td.append(b);
      } else td.textContent = C.format(v, q.formats?.[col]);
      tr.append(td);
    });
    if (q.trace) {
      const td = el("td"),
        b = el("button", "Trace rows ↗", "source-link");
      b.onclick = () => trace(q, row, r.columns);
      td.append(b);
      tr.append(td);
    }
    body.append(tr);
  }
  if (q.trace) tr.append(el("th", "Evidence"));
  table.replaceChildren(head, body);
  $("#empty").hidden = Boolean(r.rows.length);
  $("#row-count").textContent = r.rows.length
    ? start +
      1 +
      "–" +
      Math.min(start + 50, r.rows.length) +
      " of " +
      r.rows.length +
      " exact result rows"
    : "0 matching result rows";
  $("#previous").disabled = pageIndex === 0;
  $("#next").disabled = start + 50 >= r.rows.length;
  $("#row-count").dataset.count = String(r.rows.length);
  $("#reset-trace").hidden = !current.bundle.config.parameters.some(
    (p) => p.hidden && current.view.parameters[p.id] !== p.default,
  );
}
async function trace(q, row, columns) {
  if (busy) return;
  const view = viewFromControls();
  for (const [p, col] of Object.entries(q.trace.bindings))
    view.parameters[p] = row[columns.indexOf(col)];
  view.selectedQuery = q.trace.query;
  await commit(current.bundle, view);
}
function showSource(id, record) {
  sourceId = id;
  const t = current.bundle.config.tables.find((t) => t.id === id),
    parsed = C.parseCSV(current.bundle.sources[t.file]);
  $("#source-title").textContent = t.label;
  const schema = $("#schema");
  schema.replaceChildren();
  const ul = el("ul");
  for (const col of t.columns)
    ul.append(
      el(
        "li",
        col.source +
          " → " +
          col.name +
          " · " +
          col.type +
          (col.type === "decimal"
            ? " × 10^" + col.scale + " integer storage"
            : "") +
          (col.unit ? " · " + col.unit : "") +
          " · " +
          (col.nullable ? "missing allowed" : "required") +
          (col.trim ? " · trim whitespace" : ""),
      ),
    );
  const rules = el("details");
  rules.open = !record;
  rules.append(
    el(
      "summary",
      "Import rules · " + t.columns.length + " explicitly typed columns",
    ),
    ul,
  );
  schema.append(rules);
  const table = $("#raw-record"),
    head = el("thead"),
    tr = el("tr");
  (record
    ? ["Source field", "Original value"]
    : ["CSV record", ...parsed.headers]
  ).forEach((h) => tr.append(el("th", h)));
  head.append(tr);
  const body = el("tbody");
  const rows = record
    ? [
        ["CSV record", record],
        ...parsed.headers.map((h, i) => [h, parsed.records[record - 2][i]]),
      ]
    : parsed.records.slice(0, 20).map((r, i) => [i + 2, ...r]);
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((v) => tr.append(el("td", v)));
    body.append(tr);
  }
  table.replaceChildren(head, body);
  $("#source-caption").textContent = record
    ? "Original CSV record " +
      record +
      ". Header is record 1; a quoted multiline field is still one record."
    : "First " +
      rows.length +
      " of " +
      parsed.records.length +
      " original records. Download retains all source text. Raw CSV may contain spreadsheet formulas; do not open untrusted raw data with formula evaluation enabled.";
  if (!$("#source-dialog").open) $("#source-dialog").showModal();
}
$("#filters").onkeydown = (e) => {
  if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    if (current && !busy) commit(current.bundle, viewFromControls());
  }
};
$("#run-sql").onclick = async () => {
  if (!current || busy) return;
  const bundle = clone(current.bundle),
    q = bundle.config.queries.find((q) => q.id === selected);
  bundle.sql[q.file] = $("#sql").value;
  if (
    bundle.sql[q.file] !== current.bundle.sql[q.file] &&
    !q.explanation.startsWith("Edited query.")
  )
    q.explanation =
      "Edited query. Review the SQL before interpreting this result. Original explanation: " +
      q.explanation;
  await commit(bundle, viewFromControls());
};
$("#sql").oninput = () =>
  status(
    "SQL draft changed. The displayed result and exports still use the last successful query. Run revised query to apply it.",
  );
$("#reset-trace").onclick = () => {
  if (!current || busy) return;
  const view = viewFromControls();
  for (const p of current.bundle.config.parameters.filter((p) => p.hidden))
    view.parameters[p.id] = p.default;
  commit(current.bundle, view);
};
$("#previous").onclick = () => {
  if (pageIndex) {
    pageIndex--;
    renderQuery();
  }
};
$("#next").onclick = () => {
  pageIndex++;
  renderQuery();
};
$("#close-source").onclick = () => $("#source-dialog").close();
$("#close-checks").onclick = () => $("#checks-dialog").close();
$("#show-checks").onclick = () => current && $("#checks-dialog").showModal();
$("#replace-source").onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !current || busy) return;
  if (file.size > C.LIMITS.sourceBytes) {
    status("Replacement exceeds 6 MiB; last good analysis is unchanged.", true);
    return;
  }
  setBusy(true);
  status("Reading replacement CSV…");
  try {
    const bundle = clone(current.bundle),
      t = bundle.config.tables.find((t) => t.id === sourceId);
    bundle.sources[t.file] = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    const view = viewFromControls();
    setBusy(false);
    const ok = await commit(bundle, view);
    if (ok) showSource(sourceId);
  } catch (e) {
    setBusy(false);
    status(e.message + " Last good analysis is unchanged.", true);
  }
};
$("#download-source").onclick = () => {
  const t = current.bundle.config.tables.find((t) => t.id === sourceId);
  download(t.file.split("/").pop(), current.bundle.sources[t.file], "text/csv");
};
$("#open-project").onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || busy) return;
  setBusy(true);
  status("Reading saved project…");
  try {
    if (file.size > 12 * 1024 * 1024)
      throw new Error("Project exceeds 12 MiB.");
    const p = C.validateProject(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
      ),
    );
    if ((await hash(bytes(C.stable(p.bundle)))) !== p.revision)
      throw new Error("Project revision checksum mismatch.");
    setBusy(false);
    await commit(p.bundle, p.view);
  } catch (error) {
    setBusy(false);
    status(
      error.message + (current ? " Last good analysis is unchanged." : ""),
      true,
    );
  }
};
$("#save-project").onclick = () => {
  current.view.notes = $("#notes").value;
  download(
    "analysis.data-studio.json",
    JSON.stringify(
      {
        format: "data-studio",
        spec: 1,
        revision: current.report.revision,
        bundle: current.bundle,
        view: current.view,
      },
      null,
      2,
    ),
  );
  status(
    "Project saved with source CSVs, types, queries, applied controls and notes. Unapplied controls or SQL drafts are not included.",
  );
};
$("#export-db").onclick = () =>
  download("analysis.sqlite", current.database, "application/vnd.sqlite3");
$("#export-report").onclick = () =>
  download(
    "analysis-report.html",
    globalThis.DataStudioReport(
      current.bundle,
      current.report,
      $("#notes").value,
    ),
    "text/html",
  );
$("#export-csv").onclick = () => {
  const r = current.report.results.find((r) => r.id === selected);
  download(selected + ".csv", C.csv(r.columns, r.rows), "text/csv");
};
$("#export-json").onclick = () => {
  const r = current.report.results.find((r) => r.id === selected);
  download(
    selected + ".json",
    JSON.stringify(
      {
        revision: current.report.revision,
        parameters: current.report.parameters,
        query: current.bundle.config.queries.find((q) => q.id === selected),
        ...r,
      },
      null,
      2,
    ),
  );
};
try {
  const [p, baseline] = await Promise.all([
    get("output/project.data-studio.json").then(JSON.parse),
    get("output/analysis-result.json").then(JSON.parse),
  ]);
  C.validateProject(p);
  if ((await hash(bytes(C.stable(p.bundle)))) !== p.revision)
    throw new Error("Saved project revision mismatch.");
  await commit(p.bundle, p.view, { baseline });
} catch (error) {
  status(error.message, true);
}
