import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {measured, revised, kinds} from './fixtures.mjs';
import {validateTransition, canonical, digest} from '../template/studio/project.mjs';
import {fitProject} from '../template/studio/analysis.mjs';
import {exportBench} from '../template/tools/export.mjs';
const pkg = fileURLToPath(new URL('..', import.meta.url)), output = resolve(process.env.LAB_ACCEPTANCE_ROOT ?? 'work/experience-evidence/signal-acceptance');
await mkdir(output, {recursive: true}); const results = [];
for (const kind of kinds) {
  const before = await measured(kind), after = await revised(before, kind); validateTransition(before, after);
  const approved = {factors: before.factors, protocol: before.protocol, response: before.response, design: before.design, runs: before.runs};
  assert.equal(canonical({...approved, factors: after.factors, protocol: after.protocol, response: after.response, design: after.design, runs: after.runs.slice(0, before.runs.length)}), canonical(approved));
  for (const [edition, project] of [['before', before], ['after', after]]) {
    const destination = join(output, kind + '-' + edition), report = await exportBench(join(pkg, 'template'), destination, {project});
    const fit = fitProject(project); assert.equal(fit.ok, true);
    results.push({kind, edition, title: project.title, destination, measured: project.measurements.length, training: fit.n, df: fit.df, parameters: fit.parameters, heldOut: fit.confirmation, excluded: fit.excluded, approvedHash: await digest(approved), files: report.files});
    console.log(`${kind}/${edition}: ${project.measurements.length} measured, ${fit.n} training, ${fit.parameters} coefficients; ${report.files.length} delivered files.`);
  }
}
await writeFile(join(output, 'acceptance.json'), JSON.stringify({scope: 'Authored briefs and explicitly synthetic response fixtures; not actual experiments or installed-agent prompt trials.', results}, null, 2));
console.log(JSON.stringify({output, deliveries: results.length}));
