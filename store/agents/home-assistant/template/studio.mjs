import { checkDraft } from "./schema.mjs";
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="habitat-token"]').content;
const pretty = (value) => JSON.stringify(value, null, 2);
const node = (tag, text, className) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
};
let source, baseRevision, selected, lastRun, checkedRevision, currentRevision;
let busy = false,
  pendingProject = false,
  pendingExpect = false,
  revisionSequence = 0;
const currentCase = () =>
  source.project.scenarios.find((c) => c.id === selected);
function status(message, error = false) {
  $("status").textContent = message;
  $("status").className = error ? "error" : "notice";
}
async function api(path, value, binary = false) {
  const response = await fetch("/api/" + path, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      "x-habitat-token": token,
      ...(value === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (!response.ok) {
    let message = "The studio request failed (" + response.status + ").";
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return binary ? response.blob() : response.json();
}
async function digest(value) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ project: value.project, yaml: value.yaml }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function applied() {
  if (pendingProject || pendingExpect)
    throw new Error(
      "Apply or discard the JSON editor changes first. They are not part of the draft yet.",
    );
}
function controls() {
  document.body.dataset.busy = String(busy);
  document.body.dataset.ready = String(
    !!checkedRevision &&
      checkedRevision === currentRevision &&
      !pendingProject &&
      !pendingExpect,
  );
  document.body.dataset.dirty = String(
    currentRevision !== baseRevision || pendingProject || pendingExpect,
  );
  document.querySelectorAll("[data-edit]").forEach((el) => {
    const editor = pendingProject
      ? ["project-json", "apply-project", "discard-project"]
      : pendingExpect
        ? ["expect-json", "apply-expect", "discard-expect"]
        : null;
    el.disabled = busy || (!!editor && !editor.includes(el.id));
  });
  document.querySelectorAll("[data-export]").forEach((el) => {
    el.disabled = busy || document.body.dataset.ready !== "true";
  });
  $("cancel").hidden = !busy;
  $("progress").hidden = !busy;
  $("download-trace").disabled =
    busy ||
    pendingProject ||
    pendingExpect ||
    lastRun?.sourceRevision !== currentRevision;
  $("source-status").textContent =
    pendingProject || pendingExpect
      ? "Unapplied JSON edits — apply or discard them below."
      : currentRevision === baseRevision
        ? "Saved to this workspace"
        : "Unsaved draft · workspace files are unchanged";
  $("source-revision").textContent = currentRevision
    ? "revision " + currentRevision.slice(0, 12)
    : "";
  $("export-status").textContent =
    document.body.dataset.ready === "true"
      ? "Every declared scenario passed for this exact draft. Hardware is still unverified."
      : "Test all scenarios for this exact draft to unlock checked exports.";
}
async function edited(message) {
  const sequence = ++revisionSequence;
  checkedRevision = null;
  currentRevision = null;
  controls();
  const value = await digest(source);
  if (sequence !== revisionSequence) return;
  currentRevision = value;
  if (!pendingProject) $("project-json").value = pretty(source.project);
  controls();
  renderTabs();
  renderResult();
  if (message) status(message);
}
function listen(id, action, event = "click") {
  $(id).addEventListener(event, async (e) => {
    try {
      await action(e);
    } catch (error) {
      status(error.message, true);
    }
  });
}
function option(value, title) {
  const el = node("option", title);
  el.value = value;
  return el;
}
function field(label, input) {
  const el = node("label", label);
  el.append(input);
  return el;
}
function showIdentity() {
  $("title").textContent = source.project.title;
  $("brief").textContent = source.project.brief;
  $("notes").value = source.project.notes || "";
  $("yaml").value = source.yaml;
  $("project-json").value = pretty(source.project);
  $("disclosure").textContent =
    (source.project.example
      ? "Example devices. "
      : "Declared device test doubles. ") +
    "Tests run real Core logic with controlled time; they do not validate physical hardware. Time zone: " +
    source.project.timezone +
    ".";
  $("entity-count").textContent = source.project.entities.length;
  $("entities").replaceChildren(
    ...source.project.entities.map((e) => {
      const el = node("div", undefined, "entity");
      el.append(
        node("strong", e.name),
        node("code", e.id),
        node(
          "span",
          e.kind === "state"
            ? "State input · " + e.state
            : e.kind.replace("input_", "Native helper · ") + " · " + e.state,
          "muted small",
        ),
      );
      return el;
    }),
  );
}
function renderTabs() {
  $("case-count").textContent = source.project.scenarios.length;
  const fresh = lastRun?.sourceRevision === currentRevision;
  $("scenarios").replaceChildren(
    ...source.project.scenarios.map((item, i) => {
      const result =
        fresh && lastRun.results.find((r) => r.scenario === item.id);
      const button = node("button", undefined, "scenario-tab");
      button.type = "button";
      button.role = "tab";
      button.dataset.scenario = item.id;
      button.setAttribute("aria-selected", String(item.id === selected));
      button.setAttribute("aria-controls", "selected-panel");
      button.tabIndex = item.id === selected ? 0 : -1;
      button.append(
        node(
          "span",
          result ? (result.passed ? "✓" : "!") : String(i + 1).padStart(2, "0"),
          "case-number " +
            (result ? (result.passed ? "passed" : "failed") : ""),
        ),
        node("span", item.name),
        node("span", item.id === selected ? "↗" : "", "case-arrow"),
      );
      button.addEventListener("click", () => {
        try {
          applied();
          selected = item.id;
          renderCase();
          renderTabs();
        } catch (error) {
          status(error.message, true);
        }
      });
      button.addEventListener("keydown", (e) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        if (pendingProject || pendingExpect) {
          status(
            "Apply or discard the JSON editor changes before switching scenarios.",
            true,
          );
          return;
        }
        const all = [...$("scenarios").children],
          next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? all.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) %
                  all.length;
        all[next].click();
        $("scenarios").children[next]?.focus();
      });
      return button;
    }),
  );
  const passed = fresh ? lastRun.results.filter((r) => r.passed).length : 0;
  $("suite-summary").textContent = fresh
    ? passed +
      " / " +
      source.project.scenarios.length +
      " scenarios passed" +
      (lastRun.complete
        ? lastRun.passed
          ? " · complete suite"
          : " · review failures"
        : " · partial run")
    : lastRun
      ? "Draft changed. Previous results are stale."
      : "Run all scenarios to check a complete behavior.";
  if (fresh)
    for (const check of lastRun.suiteChecks || []) {
      if (!check.passed)
        $("suite-summary").append(
          node(
            "p",
            check.name + " — needs a positive scenario.",
            "error small",
          ),
        );
    }
}
function renderCase() {
  const item = currentCase();
  $("scenario-title").textContent = item.name;
  $("scenario-why").textContent = item.why;
  $("scenario-start").value = item.start;
  $("scenario-until").value = item.until;
  $("expect-json").value = pretty(item.expect);
  $("expect-summary").textContent = item.expect.calls.length
    ? item.expect.calls
        .map((c) => c.service + " at +" + c.between.join("–") + " s")
        .join(" → ")
    : "No service calls should happen.";
  $("initial-states").replaceChildren(
    ...source.project.entities.map((entity) => {
      const input = node("input");
      input.value = item.initial?.[entity.id]?.state ?? entity.state;
      input.dataset.edit = "";
      input.disabled = busy;
      input.setAttribute("aria-label", entity.id + " initial state");
      input.addEventListener("change", () => {
        item.initial ??= {};
        item.initial[entity.id] = {
          ...item.initial[entity.id],
          state: input.value,
        };
        void edited(
          "Starting state changed. Run the scenario to check its effect.",
        );
      });
      return field(entity.name, input);
    }),
  );
  renderTimeline();
  renderResult();
  controls();
}
function renderTimeline() {
  const item = currentCase();
  $("timeline-editor").replaceChildren(
    ...item.steps.map((step, index) => {
      const row = node("div", undefined, "event-row");
      const at = node("input");
      at.type = "number";
      at.min = 0;
      at.max = item.until;
      at.step = "any";
      at.value = step.at;
      at.dataset.edit = "";
      at.disabled = busy;
      at.setAttribute(
        "aria-label",
        "Event " + (index + 1) + " time in seconds",
      );
      at.addEventListener("change", () => {
        step.at = at.value === "" ? null : Number(at.value);
        void edited();
      });
      row.append(field("+ seconds", at));
      if (step.entity) {
        const entity = node("select");
        entity.dataset.edit = "";
        entity.disabled = busy;
        source.project.entities.forEach((e) =>
          entity.append(option(e.id, e.name)),
        );
        entity.value = step.entity;
        entity.setAttribute("aria-label", "Event " + (index + 1) + " entity");
        entity.addEventListener("change", () => {
          step.entity = entity.value;
          void edited();
        });
        const state = node("input");
        state.value = step.state;
        state.dataset.edit = "";
        state.disabled = busy;
        state.setAttribute("aria-label", "Event " + (index + 1) + " state");
        state.addEventListener("change", () => {
          step.state = state.value;
          void edited();
        });
        row.append(field("Entity", entity), field("Becomes", state));
        if (step.attributes && Object.keys(step.attributes).length)
          row.append(node("code", pretty(step.attributes), "event-data"));
      } else
        row.append(
          node(
            "div",
            "Custom event · " +
              step.event +
              "\n" +
              JSON.stringify(step.data || {}),
            "custom-event",
          ),
        );
      const remove = node("button", "×", "remove-event");
      remove.type = "button";
      remove.dataset.edit = "";
      remove.disabled = busy;
      remove.setAttribute("aria-label", "Remove event " + (index + 1));
      remove.addEventListener("click", () => {
        item.steps.splice(index, 1);
        renderTimeline();
        void edited();
      });
      row.append(remove);
      return row;
    }),
  );
  if (!item.steps.length)
    $("timeline-editor").append(
      node(
        "p",
        "No injected events. Time-based automations still run as the clock advances.",
        "small muted",
      ),
    );
}
function renderResult() {
  const result = lastRun?.results.find((r) => r.scenario === selected);
  const fresh =
    result &&
    lastRun.sourceRevision === currentRevision &&
    !pendingProject &&
    !pendingExpect;
  $("actual-timeline").replaceChildren();
  $("checks").replaceChildren();
  $("trace-panel").hidden = true;
  $("result-badge").textContent = !result
    ? "Not tested"
    : !fresh
      ? "Stale result"
      : result.passed
        ? "Passed"
        : "Needs attention";
  $("result-badge").className =
    "badge " + (!fresh ? "neutral" : result.passed ? "success" : "failure");
  $("result-summary").textContent = !result
    ? "Run this scenario to see real service calls, state changes and engine traces."
    : !fresh
      ? "This result belongs to an earlier draft. Run the scenario again."
      : result.calls.length +
        " service calls · " +
        result.changes.length +
        " state changes · " +
        result.traces.length +
        " native traces · " +
        result.pending +
        " runs still waiting";
  if (!fresh) return;
  const events = [
    ...result.calls.map((call) => ({ ...call, kind: "call" })),
    ...result.changes.map((change) => ({ ...change, kind: "state" })),
  ].sort((a, b) => a.at - b.at);
  if (!events.length)
    $("actual-timeline").append(
      node(
        "p",
        "No calls or declared-entity state changes were recorded.",
        "empty-result",
      ),
    );
  events.slice(0, 160).forEach((event) => {
    const row = node("div", undefined, "actual-event " + event.kind);
    row.append(node("code", "+" + Number(event.at.toFixed(3)) + " s", "time"));
    const detail = node("div");
    detail.append(
      node("strong", event.kind === "call" ? event.service : event.entity),
      node(
        "span",
        event.kind === "call"
          ? event.entities.join(", ") || "Local Core service"
          : "→ " + event.state,
      ),
    );
    if (event.kind === "call" && Object.keys(event.data).length)
      detail.append(node("code", JSON.stringify(event.data), "event-data"));
    row.append(
      detail,
      node("span", event.kind === "call" ? "SERVICE" : "STATE", "event-kind"),
    );
    $("actual-timeline").append(row);
  });
  if (events.length > 160)
    $("actual-timeline").append(
      node(
        "p",
        "Showing 160 events. Download the evidence for the complete timeline.",
        "small muted",
      ),
    );
  result.checks.forEach((check) => {
    const line = node(
      "details",
      undefined,
      "check " + (check.passed ? "pass" : "fail"),
    );
    line.append(
      node("summary", (check.passed ? "✓ " : "! ") + check.name),
      node(
        "pre",
        "Expected\n" +
          pretty(check.expected) +
          "\n\nActual\n" +
          pretty(check.actual),
        "code",
      ),
    );
    if (!check.passed) line.open = true;
    $("checks").append(line);
  });
  $("trace-panel").hidden = !result.traces.length;
  $("trace-select").replaceChildren(
    ...result.traces.map((trace, i) =>
      option(
        String(i),
        i +
          1 +
          " · " +
          (trace.config?.alias || trace.item_id) +
          " · " +
          (trace.script_execution || trace.state),
      ),
    ),
  );
  renderTrace();
}
function renderTrace() {
  const result = lastRun?.results.find((r) => r.scenario === selected),
    trace = result?.traces[Number($("trace-select").value)];
  $("trace-steps").replaceChildren();
  if (!trace) return;
  const raw = pretty(trace);
  $("trace-json").textContent =
    raw.length <= 200000
      ? raw
      : raw.slice(0, 200000) +
        "\n…display truncated; download the complete native trace.";
  const steps = Object.values(trace.trace || {})
    .flat()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  steps.slice(0, 100).forEach((step) => {
    const row = node("details", undefined, "trace-step");
    const label = step.error
      ? "Error: " + step.error
      : step.result?.result === false
        ? "Condition did not match"
        : step.result?.result === true
          ? "Condition matched"
          : step.result?.choice !== undefined
            ? "Selected branch: " + step.result.choice
            : step.result?.params?.service
              ? "Called " +
                step.result.params.domain +
                "." +
                step.result.params.service
              : "Native execution step";
    const summary = node("summary");
    summary.append(node("strong", label), node("code", step.path));
    row.append(summary);
    if (step.result) row.append(node("pre", pretty(step.result), "code"));
    $("trace-steps").append(row);
  });
  if (steps.length > 100)
    $("trace-steps").append(
      node(
        "p",
        "Showing 100 steps. The downloaded trace includes every retained step.",
        "small muted",
      ),
    );
}
async function download(name, bytes) {
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes], { type: "application/json" });
  const url = URL.createObjectURL(blob),
    anchor = node("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function run(scenario) {
  applied();
  const tested = structuredClone(source);
  currentRevision = await digest(tested);
  busy = true;
  controls();
  status(
    "Running official Home Assistant Core in an isolated process for each scenario…",
  );
  const poll = async () => {
    if (!busy) return;
    try {
      const value = await api("progress");
      if (value.progress) {
        $("progress-bar").max = value.progress.total;
        $("progress-bar").value = value.progress.index;
        $("progress-text").textContent =
          value.progress.index +
          1 +
          " / " +
          value.progress.total +
          " · " +
          value.progress.name;
      }
    } catch {}
  };
  const timer = setInterval(poll, 750);
  try {
    const { result } = await api("run", {
      source: tested,
      ...(scenario ? { scenario } : {}),
    });
    lastRun = result;
    checkedRevision =
      result.complete && result.passed ? result.sourceRevision : null;
    status(
      result.passed
        ? result.complete
          ? "All declared scenarios passed. The checked delivery is ready to export; physical hardware is not verified."
          : "This scenario passed. Test all scenarios before exporting a checked delivery."
        : "Some checks failed. Inspect expected versus actual behavior before changing the source or the tests.",
      !result.passed,
    );
  } catch (error) {
    checkedRevision = null;
    status(error.message, true);
  } finally {
    clearInterval(timer);
    busy = false;
    renderTabs();
    renderResult();
    controls();
  }
}
listen("run-all", () => run());
listen("run-case", () => run(selected));
listen("cancel", async () => {
  await api("cancel", {});
  status("Cancelling the isolated test process…");
});
listen(
  "yaml",
  () => {
    source.yaml = $("yaml").value;
    return edited();
  },
  "input",
);
listen(
  "notes",
  () => {
    source.project.notes = $("notes").value;
    return edited();
  },
  "input",
);
listen(
  "scenario-start",
  () => {
    currentCase().start = $("scenario-start").value;
    return edited();
  },
  "change",
);
listen(
  "scenario-until",
  () => {
    currentCase().until =
      $("scenario-until").value === ""
        ? null
        : Number($("scenario-until").value);
    return edited();
  },
  "change",
);
listen("trace-select", renderTrace, "change");
listen("add-event", () => {
  applied();
  const item = currentCase();
  if (item.steps.length >= 120)
    throw new Error("Use at most 120 events per scenario.");
  const entity = source.project.entities[0];
  item.steps.push({
    at: Math.min(item.until, (item.steps.at(-1)?.at ?? -1) + 1),
    entity: entity.id,
    state: entity.state,
  });
  renderTimeline();
  return edited();
});
listen("add-scenario", () => {
  applied();
  if (source.project.scenarios.length >= 24)
    throw new Error("Use at most 24 scenarios per project.");
  const item = structuredClone(currentCase());
  let index = 1;
  while (source.project.scenarios.some((s) => s.id === "scenario-" + index))
    index++;
  item.id = "scenario-" + index;
  item.name = "What if? " + index;
  item.why = "Revise the events and expected behavior to test a new condition.";
  source.project.scenarios.push(item);
  selected = item.id;
  renderCase();
  return edited(
    "Scenario duplicated. Change its conditions and assertions to make it useful.",
  );
});
listen(
  "expect-json",
  () => {
    pendingExpect = true;
    checkedRevision = null;
    controls();
    renderResult();
  },
  "input",
);
listen(
  "project-json",
  () => {
    pendingProject = true;
    checkedRevision = null;
    controls();
    renderResult();
  },
  "input",
);
listen("apply-expect", () => {
  const value = JSON.parse($("expect-json").value);
  const draft = structuredClone(source);
  draft.project.scenarios.find((c) => c.id === selected).expect = value;
  checkDraft(draft);
  currentCase().expect = value;
  pendingExpect = false;
  renderCase();
  return edited(
    "Expected behavior updated. Check it against the brief, then run again.",
  );
});
listen("discard-expect", () => {
  pendingExpect = false;
  $("expect-json").value = pretty(currentCase().expect);
  controls();
  renderResult();
});
listen("discard-project", () => {
  pendingProject = false;
  $("project-json").value = pretty(source.project);
  controls();
  renderResult();
});
listen("apply-project", () => {
  if (pendingExpect)
    throw new Error("Apply or discard expected-behavior edits first.");
  const value = JSON.parse($("project-json").value);
  checkDraft({ project: value, yaml: source.yaml });
  source.project = value;
  pendingProject = false;
  if (!value.scenarios.some((s) => s.id === selected))
    selected = value.scenarios[0].id;
  showIdentity();
  renderCase();
  return edited(
    "Project details applied to the draft. Workspace files are unchanged.",
  );
});
listen("save", async () => {
  applied();
  const value = await api("save", { source, baseRevision });
  baseRevision = value.revision;
  currentRevision = await digest(source);
  controls();
  status(
    "Saved. The previous source is preserved in .harness/" +
      value.history +
      ".",
  );
});
listen("download-project", async () => {
  applied();
  const value = {
    format: "habitat",
    spec: 1,
    engine: "2026.9.3",
    revision: await digest(source),
    ...source,
  };
  await download("project.habitat.json", pretty(value) + "\n");
  status(
    "Editable draft downloaded. This file does not claim a passing test result.",
  );
});
listen(
  "open-project",
  async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    applied();
    if (file.size > 3 * 1024 * 1024)
      throw new Error("Saved projects must be under 3 MiB.");
    if (
      currentRevision !== baseRevision &&
      !confirm(
        "Replace this unsaved draft? Download it first if you want to keep it. Workspace files will not change.",
      )
    )
      return;
    const value = await api("open", JSON.parse(await file.text()));
    source = value.source;
    selected = source.project.scenarios[0].id;
    lastRun = null;
    checkedRevision = null;
    showIdentity();
    renderCase();
    await edited(
      "Project opened as a draft. Test it before export; Save explicitly to replace workspace source.",
    );
  },
  "change",
);
listen("download-trace", async () => {
  applied();
  const value = await api("trace", {
    revision: await digest(source),
    scenario: selected,
  });
  await download(selected + "-core-trace.json", pretty(value) + "\n");
});
document.querySelectorAll("[data-export]").forEach((button) =>
  button.addEventListener("click", async () => {
    try {
      applied();
      const name = button.dataset.export;
      await download(
        name,
        await api("export", { name, revision: await digest(source) }, true),
      );
      status(
        "Downloaded " +
          name +
          ". Review entity IDs, helpers and the installation guide before use.",
      );
    } catch (error) {
      status(error.message, true);
    }
  }),
);
window.addEventListener("beforeunload", (e) => {
  if (document.body.dataset.dirty === "true" || busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});
try {
  const value = await api("project");
  source = value.source;
  baseRevision = value.revision;
  currentRevision = value.revision;
  selected = source.project.scenarios[0].id;
  lastRun = value.prior;
  showIdentity();
  renderCase();
  renderTabs();
  controls();
  status(
    value.runtime.available
      ? "Ready to test with example devices. No Home Assistant installation is connected."
      : value.runtime.message,
    !value.runtime.available,
  );
} catch (error) {
  status(error.message, true);
  document.querySelectorAll("button,input,textarea,select").forEach((el) => {
    el.disabled = true;
  });
  $("source-status").textContent =
    "Workspace could not be opened. Source files were not changed.";
}
