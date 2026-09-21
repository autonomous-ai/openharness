// A portable experiment, including the original measurements and their history.
export const clone = x => JSON.parse(JSON.stringify(x));
export function assert(ok, message) { if (!ok) throw new Error(message); }
export const text = (x, max = 160, empty = false) => typeof x === 'string' && (empty || x.trim().length > 0) && x.length <= max;
export const identifier = x => typeof x === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(x) && !['constructor', 'prototype'].includes(x);
export const finite = x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e12;
const list = (x, max, min = 0) => Array.isArray(x) && x.length >= min && x.length <= max;
export function canonical(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  return Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']' : '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
}
export async function digest(x) {
  const bytes = x instanceof Uint8Array ? x : new TextEncoder().encode(typeof x === 'string' ? x : canonical(x));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function settingsValid(p, settings) {
  assert(settings && Object.keys(settings).length === p.factors.length, 'Every run needs exactly one setting for each factor.');
  for (const f of p.factors) {
    const v = settings[f.id];
    assert(f.type === 'number' ? finite(v) && v >= f.levels[0] && v <= f.levels.at(-1) : f.levels.includes(v), `Keep ${f.name} inside its planned range.`);
  }
  return settings;
}
export function validateProject(raw) {
  assert(raw && new TextEncoder().encode(JSON.stringify(raw)).length <= 5000000, 'Keep the complete project below 5 MB.');
  const p = clone(raw); delete p.revision;
  assert(p.spec === 1 && identifier(p.id) && text(p.title) && text(p.question, 1200), 'Use a version 1 Signal project with an id, title and question.');
  assert(p.response && identifier(p.response.id) && text(p.response.name, 80) && text(p.response.unit, 40), 'Name the continuous response and its measurement unit.');
  assert(['maximize', 'minimize', 'target'].includes(p.response.goal), 'Choose a response goal.');
  assert(p.conclusion === undefined || text(p.conclusion, 8000, true), 'Keep the decision note within 8000 characters.');
  assert(p.evidenceNote === undefined || text(p.evidenceNote, 600), 'Keep the evidence note short and explicit.');
  if (p.response.goal === 'target') assert(finite(p.response.target), 'Enter a finite target response.');
  assert(list(p.factors, 6, 1), 'Use 1–6 experimental factors.');
  const ids = new Set();
  for (const f of p.factors) {
    assert(identifier(f.id) && !ids.has(f.id) && !['run_id', 'response', 'block', 'order', 'phase', 'kind', 'unit', 'note'].includes(f.id), 'Factors need distinct ids, separate from collection columns.'); ids.add(f.id);
    assert(text(f.name, 80) && ['number', 'category'].includes(f.type) && text(f.unit, 40, true), 'Each factor needs a name, type and unit (which can be blank).');
    assert(list(f.levels, 5, 2) && new Set(f.levels).size === f.levels.length, 'Use 2–5 distinct levels per factor.');
    if (f.type === 'number') assert(f.levels.every(finite) && f.levels.every((x, i) => i === 0 || x > f.levels[i - 1]), 'Numeric levels must be finite and increasing.');
    else assert(f.levels.every(x => text(x, 60)), 'Category levels must be short, nonempty names.');
  }
  const protocol = p.protocol;
  assert(protocol && text(protocol.unit, 300) && text(protocol.randomization, 600) && text(protocol.analysisPlan, 1200) && list(protocol.steps, 20, 1) && protocol.steps.every(s => text(s, 1200)), 'Describe the independent experimental unit, randomization, planned analysis and procedure.');
  assert(text(protocol.notes, 4000, true) && typeof p.approved === 'boolean', 'Include protocol notes and approval state.');
  assert(p.design && text(p.design.seed, 100) && Number.isInteger(p.design.replicates) && p.design.replicates >= 1 && p.design.replicates <= 20, 'Use a seed and 1–20 independent repetitions per combination and block.');
  assert(list(p.design.blocks, 8, 1) && p.design.blocks.every(x => text(x, 60)) && new Set(p.design.blocks).size === p.design.blocks.length, 'Name 1–8 distinct complete blocks.');
  assert(Number.isInteger(p.design.controls) && p.design.controls >= 0 && p.design.controls <= 5 && p.design.controls !== 1, 'Choose zero or 2–5 control runs per block (at the beginning, end and between).');
  assert(p.model && list(p.model.terms, 24) && new Set(p.model.terms).size === p.model.terms.length && typeof p.model.blocks === 'boolean', 'Use a distinct list of model terms and a block setting.');
  assert([.8, .9, .95, .99].includes(p.model.confidence), 'Use 80%, 90%, 95% or 99% confidence.');
  for (const term of p.model.terms) {
    assert(typeof term === 'string', 'Model terms must be names.');
    if (term.endsWith('^2')) {
      const f = p.factors.find(x => x.id === term.slice(0, -2));
      assert(f?.type === 'number' && p.model.terms.includes(f.id), 'A quadratic term needs its numeric main effect.');
    } else {
      const parts = term.split(':');
      assert(parts.length <= 2 && new Set(parts).size === parts.length && parts.every(x => ids.has(x)), 'Use main effects, two-factor interactions or numeric quadratic terms.');
      if (parts.length === 2) assert(parts.every(x => p.model.terms.includes(x)), 'An interaction needs both main effects.');
    }
  }
  assert(list(p.phases, 30) && list(p.runs, 512) && list(p.measurements, 512) && list(p.sources, 30) && list(p.audit, 5000), 'This workshop supports up to 512 runs, 30 phases/imports and 5000 recorded changes.');
  const phases = new Set();
  for (const phase of p.phases) {
    assert(identifier(phase.id) && !phases.has(phase.id) && text(phase.label) && ['plan', 'extension', 'confirmation'].includes(phase.kind) && text(phase.reason, 1000) && text(phase.seed, 100), 'Each phase needs a unique id, purpose, reason and seed.'); phases.add(phase.id);
    if (phase.kind === 'confirmation') {
      assert(phase.snapshot && /^[a-f0-9]{64}$/.test(phase.snapshot.trainingRevision) && list(phase.snapshot.predictions, 12, 1), 'Confirmation runs retain their original model and predictions.');
      const snapshot = phase.snapshot, matrix = snapshot.matrix, width = snapshot.columns?.length;
      assert(Number.isInteger(snapshot.n) && snapshot.n > 1 && snapshot.n <= 512 && list(snapshot.columns, 48, 1) && snapshot.columns.every(c => text(c.id) && text(c.label, 300)) && snapshot.df === snapshot.n - width && snapshot.df > 0, 'A confirmation snapshot needs its original measured count, columns and residual degrees of freedom.');
      assert(snapshot.model && [.8, .9, .95, .99].includes(snapshot.model.confidence) && list(snapshot.coefficients, width, width) && list(snapshot.covariance, width, width), 'Retain the original model, coefficients and covariance for confirmation.');
      assert(matrix && list(matrix.X, snapshot.n, snapshot.n) && list(matrix.y, snapshot.n, snapshot.n) && list(matrix.runIds, snapshot.n, snapshot.n) && new Set(matrix.runIds).size === snapshot.n, 'Retain the complete training matrix and run ids with the forecast.');
      assert(matrix.X.every(row => list(row, width, width) && row.every(finite)) && matrix.y.every(finite) && snapshot.coefficients.every(c => Number.isFinite(c.value)) && snapshot.covariance.every(row => list(row, width, width) && row.every(Number.isFinite)) && Number.isFinite(snapshot.mse) && snapshot.mse > 0, 'The frozen analysis must contain finite numerical results.');
      for (const prediction of phase.snapshot.predictions) {
        settingsValid(p, prediction.settings);
        assert(p.design.blocks.includes(prediction.block) && Number.isFinite(prediction.mean) && list(prediction.x, width, width) && prediction.x.every(finite) && list(prediction.meanCI, 2, 2) && list(prediction.predictionCI, 2, 2) && [...prediction.meanCI, ...prediction.predictionCI].every(Number.isFinite) && prediction.meanCI[0] <= prediction.mean && prediction.meanCI[1] >= prediction.mean && prediction.predictionCI[0] <= prediction.meanCI[0] && prediction.predictionCI[1] >= prediction.meanCI[1], 'Confirmation predictions must retain their design row, ordered intervals and named block.');
      }
    }
  }
  const runs = new Map();
  for (const [i, run] of p.runs.entries()) {
    assert(identifier(run.id) && !runs.has(run.id) && run.order === i + 1 && phases.has(run.phase) && p.design.blocks.includes(run.block) && ['factorial', 'control', 'followup'].includes(run.kind), 'Run ids and order must be unique, with a declared phase and block.');
    settingsValid(p, run.settings); runs.set(run.id, run);
  }
  for (const phase of p.phases.filter(x => x.kind === 'confirmation')) {
    const predictions = phase.snapshot.predictions.map(x => canonical({settings: x.settings, block: x.block}));
    assert(new Set(predictions).size === predictions.length, 'Use distinct confirmation points.');
    assert(p.runs.filter(r => r.phase === phase.id).every(r => predictions.includes(canonical({settings: r.settings, block: r.block}))), 'Each confirmation run must match one of its frozen predicted settings.');
    assert(phase.snapshot.matrix.runIds.every(id => runs.has(id) && p.phases.find(x => x.id === runs.get(id).phase)?.kind !== 'confirmation'), 'The frozen training matrix must reference existing non-confirmation runs.');
  }
  const sources = new Map();
  for (const source of p.sources) {
    assert(identifier(source.id) && !sources.has(source.id) && text(source.name, 160) && /^[a-f0-9]{64}$/.test(source.sha256), 'Imported measurements need unique ids, original filenames and SHA-256 hashes.');
    assert(text(source.base64, 1400000) && /^[A-Za-z0-9+/]*={0,2}$/.test(source.base64) && text(source.unit, 40) && source.unit === p.response.unit, 'Keep each original CSV below 1 MB and confirm its response unit.');
    assert(source.mapping && text(source.mapping.runId) && text(source.mapping.response) && source.mapping.runId !== source.mapping.response && text(source.importedAt, 50), 'Map distinct run id and response columns.'); sources.set(source.id, source);
  }
  const measured = new Set();
  for (const m of p.measurements) {
    assert(runs.has(m.runId) && !measured.has(m.runId) && finite(m.value) && text(m.note, 1000, true), 'Each known run may have one finite measurement.'); measured.add(m.runId);
    assert(m.excluded === null || text(m.excluded, 600), 'An excluded measurement needs a recorded reason.');
    assert(m.origin && finite(m.origin.value) && ['manual', 'csv'].includes(m.origin.kind), 'Keep the original measurement and its provenance.');
    if (m.origin.kind === 'csv') assert(sources.has(m.origin.source) && Number.isInteger(m.origin.row) && m.origin.row >= 2, 'CSV measurements must reference their original file and row.');
  }
  const auditIds = new Set();
  for (const event of p.audit) {
    assert(text(event.id, 80) && !auditIds.has(event.id) && text(event.at, 50) && text(event.action, 80) && text(event.reason, 1200), 'Every change in the log needs an id, time, action and reason.'); auditIds.add(event.id);
  }
  for (const m of p.measurements) if (m.value !== m.origin.value || m.excluded) assert(p.audit.some(e => e.action === 'measurement' && e.runId === m.runId && canonical(e.after) === canonical(m)), 'A corrected or excluded result needs its complete logged change and reason.');
  if (p.comparison) for (const point of [p.comparison.a, p.comparison.b]) {assert(point && p.design.blocks.includes(point.block), 'Comparison points need a known block.'); settingsValid(p, point.settings);}
  return p;
}
export function event(p, action, reason, details = {}) {
  assert(text(reason, 1200), 'Record a reason for this change.');
  p.audit.push({id: crypto.randomUUID(), at: new Date().toISOString(), action, reason, ...clone(details)});
}
export const planFrozen = p => p.approved || p.measurements.length > 0;
export function validateTransition(before, after) {
  // Source files are editable; this guards accidental destructive saves, not hostile users.
  assert(before.id === after.id, 'Open a different project in its own workspace; source saves keep this experiment id.');
  assert(canonical(after.audit.slice(0, before.audit.length)) === canonical(before.audit), 'Keep the existing change log.');
  for (const source of before.sources) assert(canonical(after.sources.find(x => x.id === source.id)) === canonical(source), 'Keep every original imported file.');
  if (planFrozen(before)) {
    for (const key of ['factors', 'protocol', 'response', 'design']) assert(canonical(before[key]) === canonical(after[key]), 'The collected or approved protocol is locked. Start a separate experiment to change its factors or measurement method.');
    assert(!before.approved || after.approved, 'Preserve protocol approval.');
    for (const run of before.runs) assert(canonical(after.runs.find(x => x.id === run.id)) === canonical(run), 'Keep existing run settings and order; append a follow-up phase.');
    for (const phase of before.phases) assert(canonical(after.phases.find(x => x.id === phase.id)) === canonical(phase), 'Keep each phase and its original prediction snapshot.');
  }
  const changes = after.audit.slice(before.audit.length);
  for (const m of after.measurements.filter(m => !before.measurements.some(old => old.runId === m.runId))) {
    assert(changes.some(e => e.action === 'measurement' && e.runId === m.runId && e.before === null && canonical(e.after) === canonical(m)) || changes.some(e => e.action === 'import' && e.source === m.origin.source && e.runs?.includes(m.runId)), 'Keep the entry or import event for every new measurement.');
  }
  for (const m of before.measurements) {
    const next = after.measurements.find(x => x.runId === m.runId);
    assert(next && canonical(next.origin) === canonical(m.origin), 'Keep each measured result and its original provenance.');
    if (canonical(m) !== canonical(next)) {
      let state = m;
      for (const e of changes.filter(x => x.runId === m.runId && x.action === 'measurement')) {
        assert(canonical(e.before) === canonical(state), 'Measurement corrections must keep their previous value.'); state = e.after;
      }
      assert(canonical(state) === canonical(next), 'Use a logged correction or exclusion with a reason to change a measured result.');
    }
  }
  if (before.measurements.length && canonical(before.model) !== canonical(after.model)) assert(changes.some(x => x.action === 'model' && canonical(x.before) === canonical(before.model) && canonical(x.after) === canonical(after.model)), 'Record the reason for changing a model after seeing data.');
  return after;
}
export function history(initial, limit = 24) {
  let items = [clone(initial)], at = 0;
  return {get value() {return clone(items[at]);}, get canUndo() {return at > 0;}, get canRedo() {return at < items.length - 1;},
    push(x) {items = items.slice(0, at + 1); items.push(clone(x)); if (items.length > limit) items.shift(); at = items.length - 1; return this.value;},
    undo() {at = Math.max(0, at - 1); return this.value;}, redo() {at = Math.min(items.length - 1, at + 1); return this.value;}};
}
