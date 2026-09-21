// Shared UI/file shape checks. Core remains the authority on automation semantics.
export function checkDraft(value) {
  const fail = (message) => {
    throw new Error(message);
  };
  const object = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v) => typeof v === "string";
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const state = (v) =>
    object(v) &&
    text(v.state) &&
    (v.attributes === undefined || object(v.attributes));
  const p = value?.project;
  if (
    !object(p) ||
    p.spec !== 1 ||
    !text(p.title) ||
    !text(p.brief) ||
    !text(p.timezone) ||
    typeof p.example !== "boolean" ||
    (p.notes !== undefined && !text(p.notes)) ||
    !text(value.yaml) ||
    !value.yaml.length
  )
    fail(
      "Use a version 1 Habitat project with title, brief, time zone, example flag and automation YAML.",
    );
  const bytes = (v) => new TextEncoder().encode(v).length;
  if (
    bytes(value.yaml) > 512 * 1024 ||
    bytes(JSON.stringify(p)) > 2 * 1024 * 1024
  )
    fail(
      "Project details may be at most 2 MiB; automation YAML may be at most 512 KiB.",
    );
  if (
    !Array.isArray(p.entities) ||
    p.entities.length < 1 ||
    p.entities.length > 100 ||
    p.entities.some(
      (e) =>
        !object(e) ||
        !text(e.id) ||
        !text(e.name) ||
        !text(e.kind) ||
        !state(e),
    )
  )
    fail(
      "Declare 1–100 entities with id, name, kind, state and optional attributes.",
    );
  const ids = new Set(p.entities.map((e) => e.id));
  if (ids.size !== p.entities.length) fail("Entity IDs must be unique.");
  if (
    !Array.isArray(p.scenarios) ||
    p.scenarios.length < 1 ||
    p.scenarios.length > 24
  )
    fail("Declare 1–24 scenarios.");
  const cases = new Set();
  for (const c of p.scenarios) {
    if (
      !object(c) ||
      !text(c.id) ||
      cases.has(c.id) ||
      !text(c.name) ||
      !text(c.why) ||
      !text(c.start) ||
      !finite(c.until) ||
      c.until < 0 ||
      c.until > 172800
    )
      fail(
        "Each scenario needs a unique id, name, purpose, start time and duration from 0–172800 seconds.",
      );
    cases.add(c.id);
    if (
      c.initial !== undefined &&
      (!object(c.initial) ||
        Object.entries(c.initial).some(([id, v]) => !ids.has(id) || !state(v)))
    )
      fail("Starting conditions need declared entity IDs and state objects.");
    if (
      !Array.isArray(c.steps) ||
      c.steps.length > 120 ||
      c.steps.some(
        (s) =>
          !object(s) ||
          !finite(s.at) ||
          (s.entity !== undefined
            ? !ids.has(s.entity) || !state(s)
            : !text(s.event) || (s.data !== undefined && !object(s.data))),
      )
    )
      fail(
        "Timeline events need a numeric time and a declared entity/state or custom event/data.",
      );
    const e = c.expect;
    if (
      !object(e) ||
      !Array.isArray(e.calls) ||
      e.calls.length > 200 ||
      e.calls.some(
        (call) =>
          !object(call) ||
          !text(call.service) ||
          (call.entities !== undefined &&
            (!Array.isArray(call.entities) ||
              call.entities.some((id) => !ids.has(id)))) ||
          (call.data !== undefined && !object(call.data)) ||
          !Array.isArray(call.between) ||
          call.between.length !== 2 ||
          !call.between.every(finite),
      ) ||
      (e.states !== undefined &&
        (!object(e.states) ||
          Object.entries(e.states).some(
            ([id, v]) => !ids.has(id) || !state(v),
          )))
    )
      fail(
        "Expected behavior needs calls with service, targets and a [first, last] time window, plus optional final states.",
      );
  }
  return value;
}
