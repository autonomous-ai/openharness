// Synthetic acceptance data only. No empirical result or customer trial is represented.
import {readFile} from 'node:fs/promises';
import {clone, event} from '../template/studio/project.mjs';
import {generatePlan, random, approveProtocol, appendPhase} from '../template/studio/design.mjs';
import {csv, prepareImport, commitImport, recordMeasurement} from '../template/studio/measurements.mjs';
import {fitProject, predictionSnapshot} from '../template/studio/analysis.mjs';
export const kinds = ['coffee', 'canopy', 'fold'];
export async function blank(kind = 'coffee') {
  const p = JSON.parse(await readFile(new URL('../template/bench/project.json', import.meta.url), 'utf8'));
  p.phases = []; p.runs = []; p.measurements = []; p.sources = []; p.audit = []; p.approved = false;
  p.protocol.notes = 'Synthetic acceptance fixture; no empirical extraction result is claimed.';
  p.evidenceNote = 'Synthetic acceptance measurements. These fixtures verify the workflow and calculations; they are not empirical findings.';
  if (kind === 'canopy') {
    p.id = 'canopy'; p.title = 'Canopy Seedlings'; p.question = 'How do growing medium and water allocation affect 14-day height gain, accounting for the shelf?';
    p.response = {id: 'growth', name: 'Height gain', unit: 'mm', goal: 'maximize'};
    p.factors = [{id: 'medium', name: 'Growing medium', type: 'category', unit: '', levels: ['Coir', 'Leaf', 'Blend']}, {id: 'water', name: 'Daily water', type: 'number', unit: 'mL', levels: [40, 80]}];
    p.design = {seed: 'canopy-01', replicates: 2, blocks: ['East shelf', 'West shelf'], controls: 0};
    p.model = {terms: ['medium', 'water'], blocks: true, confidence: .95};
    p.protocol = {unit: 'One independently prepared pot with one seedling. Leaves and repeated readings within a pot are not separate runs.', randomization: 'Randomize pots within each shelf. Each shelf contains all medium and water combinations.', analysisPlan: 'Estimate medium and water effects with a fixed shelf effect. Inspect residuals before considering exploratory interactions.', steps: ['Label each pot with its run id and record its initial height using one consistent measurement procedure.', 'Use the planned medium and daily water allocation for that pot. Keep the species, starting stage and container size consistent.', 'Record the 14-day height gain in mm. Record a departure or instrument problem in the run note.'], notes: 'Synthetic acceptance fixture; no plant growth claim is made.'};
  } else if (kind === 'fold') {
    p.id = 'fold'; p.title = 'Fold Paperworks'; p.question = 'Which crease width and flap overlap give the strongest package under our fixed compression procedure?';
    p.response = {id: 'load', name: 'Peak load', unit: 'N', goal: 'maximize'};
    p.factors = [{id: 'crease', name: 'Crease width', type: 'number', unit: 'mm', levels: [3, 6, 9]}, {id: 'overlap', name: 'Flap overlap', type: 'number', unit: 'mm', levels: [10, 20, 30]}];
    p.design = {seed: 'fold-01', replicates: 2, blocks: ['Paper lot A'], controls: 0};
    p.model = {terms: ['crease', 'overlap', 'crease:overlap', 'crease^2', 'overlap^2'], blocks: false, confidence: .9};
    p.protocol = {unit: 'One independently fabricated package. Multiple readings during its compression are one run, summarized as peak load.', randomization: 'Fabricate and test independent packages in the randomized run order within one paper lot.', analysisPlan: 'Fit main, interaction and quadratic terms across the three-level factorial. Inspect residuals and extend with new interior settings.', steps: ['Label the package with the run id. Use the same paper lot, adhesive amount and fabrication process.', 'Measure the planned crease width and flap overlap. Record a departure instead of silently changing its planned values.', 'Use a fixed compression procedure and record one peak load in N for this independent package.'], notes: 'Synthetic acceptance fixture, not a measured or certified packaging strength result.'};
  }
  return generatePlan(p);
}
export function syntheticCSV(p, kind = 'coffee', runs = p.runs) {
  const r = random('acceptance-response:' + kind + ':' + runs.map(x => x.id).join(','));
  const noise = () => (r() + r() + r() + r() + r() + r() - 3);
  const rows = [['run_id', 'block', ...p.factors.map(f => f.id), 'response', 'unit', 'note']];
  for (const run of runs) {
    const s = run.settings; let y;
    if (kind === 'coffee') {const x = (s.steep - 12) / 4, z = (s.dose - 75) / 15; y = 18.3 + 1.6 * x + z - .8 * x * z + noise() * .3;}
    else if (kind === 'canopy') {const x = (s.water - 60) / 20; y = 20 + 3 * x + {Coir: 0, Leaf: 4, Blend: 7}[s.medium] + {Coir: 0, Leaf: 1.2, Blend: -1.8}[s.medium] * x + (run.block === 'West shelf' ? -1.7 : 0) + noise() * .6; if (run.id === 'r0005') y += 5;}
    else {const x = (s.crease - 6) / 3, z = (s.overlap - 20) / 10; y = 60 + 8 * x + 6 * z - 9 * x * x - 7 * z * z + 2 * x * z + noise() * 1.2;}
    rows.push([run.id, run.block, ...p.factors.map(f => s[f.id]), Number(y.toFixed(6)), p.response.unit, 'Synthetic fixture; row ' + run.order + (run.id === 'r0005' && kind === 'canopy' ? '; simulated failed instrument check' : '')]);
  }
  return new TextEncoder().encode('\uFEFF' + csv(rows));
}
export async function measured(kind = 'coffee') {
  const p = approveProtocol(await blank(kind)), bytes = syntheticCSV(p, kind);
  return commitImport(p, await prepareImport(p, bytes, {name: kind + '-synthetic-observations.csv', mapping: {runId: 'run_id', response: 'response'}, unit: p.response.unit}));
}
export async function revised(before, kind) {
  let p = clone(before);
  if (kind === 'canopy') {
    const after = {...p.model, terms: ['medium', 'water', 'medium:water']}; event(p, 'model', 'Acceptance revision: inspect an exploratory medium-by-water interaction.', {before: p.model, after, afterCollection: true}); p.model = after;
    const m = p.measurements.find(m => m.runId === 'r0005');
    p = recordMeasurement(p, m.runId, {...m, excluded: 'Synthetic fixture log identifies a failed instrument check for this run.', reason: 'Use the recorded failed check; retain the value and compare the all-recorded sensitivity fit.'});
  } else {
    const fit = fitProject(p), points = kind === 'coffee' ? [{settings: {steep: 16, dose: 60}, block: p.design.blocks[0]}, {settings: {steep: 12, dose: 84}, block: p.design.blocks[0]}] : [{settings: {crease: 4.5, overlap: 20}, block: p.design.blocks[0]}, {settings: {crease: 6, overlap: 25}, block: p.design.blocks[0]}];
    const phaseKind = kind === 'coffee' ? 'confirmation' : 'extension'; p.comparison = {a: points[0], b: points[1]};
    const snapshot = phaseKind === 'confirmation' ? await predictionSnapshot(p, fit, points) : undefined;
    p = appendPhase(p, {points, repeats: kind === 'coffee' ? 3 : 2, label: kind === 'coffee' ? 'Fresh-jar confirmation' : 'Interior-setting extension', reason: 'Acceptance revision using independent synthetic follow-up observations.', seed: kind + '-followup', kind: phaseKind, snapshot});
    const runs = p.runs.filter(r => r.phase === p.phases.at(-1).id), bytes = syntheticCSV(p, kind, runs);
    p = commitImport(p, await prepareImport(p, bytes, {name: kind + '-synthetic-followup.csv', mapping: {runId: 'run_id', response: 'response'}, unit: p.response.unit}));
  }
  p.conclusion = 'Acceptance exercise only. The synthetic observations demonstrate the stated workflow and model calculations; a practical decision requires the person’s own measured experiment.';
  return p;
}
