import {assert, clone, validateProject, settingsValid, event, planFrozen, canonical} from './project.mjs';
export function random(seed) {
  let state = 2166136261; for (const ch of String(seed)) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  return () => {let t = state += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296;};
}
export function shuffle(array, seed) {const a = clone(array), r = random(seed); for (let i = a.length - 1; i > 0; i--) {const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]];} return a;}
export function combinations(p) {
  let points = [{}];
  for (const f of p.factors) {assert(points.length * f.levels.length <= 512, 'The full factorial exceeds 512 combinations. Narrow the factors or levels.'); points = points.flatMap(s => f.levels.map(v => ({...s, [f.id]: v})));}
  return points;
}
export function center(p) {return Object.fromEntries(p.factors.map(f => [f.id, f.type === 'number' ? (f.levels[0] + f.levels.at(-1)) / 2 : f.levels[0]]));}
export function generatePlan(raw) {
  const p = validateProject(raw); assert(!planFrozen(p), 'Collected or approved runs cannot be reshuffled. Append a follow-up.');
  const points = combinations(p), d = p.design;
  const count = (points.length * d.replicates + d.controls) * d.blocks.length;
  assert(count <= 512, `This design needs ${count} runs. Keep it within 512.`);
  const previous = {runs: p.runs, phases: p.phases}; p.runs = []; p.phases = [{id: 'initial', label: 'Initial experiment', kind: 'plan', reason: 'Full factorial, independent repetitions and complete blocks.', seed: d.seed}];
  for (const block of d.blocks) {
    const treatments = shuffle(Array.from({length: d.replicates}, () => points).flat().map(settings => ({kind: 'factorial', settings})), d.seed + ':block:' + block);
    // Controls span the run order. For categorical factors, use the declared reference level.
    const schedule = [];
    for (let i = 0; i <= treatments.length; i++) {
      for (let k = 0; k < d.controls; k++) if (Math.round(k * treatments.length / (d.controls - 1)) === i) schedule.push({kind: 'control', settings: center(p)});
      if (i < treatments.length) schedule.push(treatments[i]);
    }
    for (const row of schedule) {const order = p.runs.length + 1; p.runs.push({id: 'r' + String(order).padStart(4, '0'), order, phase: 'initial', block, ...row});}
  }
  event(p, 'design', 'Generated a randomized run sheet; control positions are scheduled.', {previous, runs: p.runs.length}); return validateProject(p);
}
export function approveProtocol(raw) {const p = validateProject(raw); assert(p.runs.length, 'Generate the run sheet first.'); p.approved = true; event(p, 'approve', 'Approved the protocol and original run order.'); return p;}
export function appendPhase(raw, {points, repeats = 3, label = 'Confirmation', reason, seed, kind = 'confirmation', snapshot}) {
  const p = validateProject(raw); assert(['confirmation', 'extension'].includes(kind), 'Choose a confirmation or an extension.');
  assert(Array.isArray(points) && points.length >= 1 && points.length <= 12 && Number.isInteger(repeats) && repeats >= 1 && repeats <= 20, 'Choose 1–12 points and 1–20 independent repetitions.');
  assert(p.runs.length + points.length * repeats <= 512, 'The follow-up exceeds 512 total runs.');
  for (const point of points) {settingsValid(p, point.settings); assert(p.design.blocks.includes(point.block), 'Choose an existing comparable block. New blocking conditions need a separate design.');}
  const id = 'phase' + (p.phases.length + 1), phase = {id, label, kind, reason, seed};
  if (kind === 'confirmation') {assert(snapshot && snapshot.predictions.length === points.length, 'Freeze the predictions before collecting confirmation measurements.'); phase.snapshot = clone(snapshot);}
  p.phases.push(phase);
  for (const block of p.design.blocks) {
    const rows = Array.from({length: repeats}, () => points.filter(x => x.block === block)).flat();
    for (const point of shuffle(rows, seed + ':' + block)) {const order = p.runs.length + 1; p.runs.push({id: 'r' + String(order).padStart(4, '0'), order, phase: id, block, kind: 'followup', settings: clone(point.settings)});}
  }
  event(p, 'followup', reason, {phase: id, kind, runs: points.length * repeats}); return validateProject(p);
}
export function phaseRows(p, phase) {return p.runs.filter(r => r.phase === phase);}
export function sameSettings(a, b) {return canonical(a) === canonical(b);}
