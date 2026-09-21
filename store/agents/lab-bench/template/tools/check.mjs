#!/usr/bin/env node
import {writeFile, mkdir, realpath} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProject} from './build.mjs';
import {plannedAnalysis, fitProject, confirmationResults} from '../studio/analysis.mjs';
import {canonical, digest} from '../studio/project.mjs';
export async function checkBench(workspace) {
  const p = await readProject(workspace), fit = fitProject(p), repeated = canonical(fit) === canonical(fitProject(p));
  if (!repeated) throw new Error('The same source produced different analysis.');
  const report = {title: p.title, revision: await digest(p), sourceHashesVerified: p.sources.length, planned: plannedAnalysis(p), analysis: fit, confirmations: confirmationResults(p), repeated,
    scope: 'Checks source integrity, design identifiability and reproducible calculations. Does not establish experimental validity or empirical results without actual measurement and review.'};
  await mkdir(join(workspace, '.harness'), {recursive: true}); await writeFile(join(workspace, '.harness/lab-check.json'), JSON.stringify(report, null, 2) + '\n');
  return {title: p.title, runs: p.runs.length, measured: p.measurements.length, model: fit.ok ? 'estimable' : fit.issue, repeated};
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkBench(resolve(dirname(fileURLToPath(import.meta.url)), '..'))));
