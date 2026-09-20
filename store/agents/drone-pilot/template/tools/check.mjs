#!/usr/bin/env node
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProject} from './build.mjs';
import {planProject} from '../studio/project.mjs';
import {segmentWithin} from '../studio/geo.mjs';
import {report} from '../studio/formats.mjs';
export async function checkFlight(workspace){
  const plan=planProject(await readProject(workspace));
  for(const sortie of plan.sorties){if(sortie.seconds>plan.budgetSeconds+.001)throw new Error('A sortie exceeds its configured time budget.');for(let i=1;i<sortie.path.length;i++)if(!segmentWithin(plan.region,sortie.path[i-1],sortie.path[i]))throw new Error('A route crosses outside the flight region.');}
  const result={...report(plan),geometryChecks:'passed',scope:'Finite geometry, timing and source-data checks. Browser operation, exported-file review and any real flight remain separate evidence.'};
  await mkdir(join(workspace,'.harness'),{recursive:true});await writeFile(join(workspace,'.harness/survey-check.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await checkFlight(resolve(dirname(fileURLToPath(import.meta.url)),'..'))));
