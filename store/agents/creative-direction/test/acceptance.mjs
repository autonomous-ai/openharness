// Exercise targeted revisions through the same saved-project import and delivery tools as users.
import assert from 'node:assert/strict';
import { cp,mkdir,mkdtemp,readFile,writeFile,readdir,access } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve,join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProject,buildBrand } from '../template/tools/build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.env.EXPERIENCE_OUTPUT||fileURLToPath(new URL('../../../../work/experience-evidence/forme-acceptance',import.meta.url)));
await mkdir(output,{recursive:true});const run=await mkdtemp(join(output,'run-'));
let playwright=process.env.PLAYWRIGHT_MODULE||pathToFileURL(join(root,'toolchain/node_modules/playwright-core/index.mjs')).href;
try{await access(fileURLToPath(playwright));}catch{playwright=new URL('../../../tools/experience-tests/node_modules/playwright-core/index.mjs',import.meta.url).href;}
const env={...process.env,FORME_DSH_DIR:root,PLAYWRIGHT_MODULE:playwright};
const reports=[];
for(const [name,field,value]of [['morrow','offer','Opening weekend\n3–4 October'],['vectorial','date','29 October · 18:00 UTC'],['stillwater','price','$75 · materials included']]){
  const ws=join(run,name,'workspace'),beforeDir=join(run,name,'before'),afterDir=join(run,name,'after');await mkdir(join(run,name),{recursive:true});
  execFileSync(process.execPath,[join(root,'examples/materialize.mjs'),name,ws],{env});
  const before=await readProject(ws),edited=structuredClone(before);edited.copy[field]=value;
  execFileSync(process.execPath,[join(ws,'tools/export.mjs'),'--out',beforeDir,'--scale','1'],{env,stdio:['ignore','inherit','inherit']});
  const saved=join(run,name,'revision.forme.json');await writeFile(saved,JSON.stringify(edited));
  const imported=JSON.parse(execFileSync(process.execPath,[join(ws,'tools/import-project.mjs'),saved],{env,encoding:'utf8'}));
  const after=await readProject(ws);assert.equal(after.copy[field],value);assert.deepEqual(after.directions,before.directions);assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.fonts,before.fonts);
  for(const key of Object.keys(before.copy))if(key!==field)assert.equal(after.copy[key],before.copy[key]);
  assert.equal(JSON.parse(await readFile(join(imported.backup,'project.json'),'utf8')).copy[field],before.copy[field]);
  execFileSync(process.execPath,[join(ws,'tools/export.mjs'),'--out',afterDir,'--scale','1'],{env,stdio:['ignore','inherit','inherit']});
  const checks=[];
  for(const b of before.directions.find(d=>d.id===before.active).boards){
    const changed=(await readFile(join(beforeDir,b.id+'.svg'),'utf8'))!==(await readFile(join(afterDir,b.id+'.svg'),'utf8'));
    const requested=b.layers.some(l=>l.type==='text'&&l.text.includes('{{'+field+'}}'));assert.equal(changed,requested,`${name}/${b.id}: only requested copy changes the exported artwork`);checks.push({artboard:b.id,changed});
  }
  for(const logo of await readdir(join(beforeDir,'logos')))if(logo.endsWith('.svg'))assert.ok((await readFile(join(afterDir,'logos',logo))).equals(await readFile(join(beforeDir,'logos',logo))),`${name}: preserve logo vector ${logo}`);
  const rasterChecks=JSON.parse(execFileSync('python3',[join(root,'test/verify-delivery.py'),'--compare-logos',join(beforeDir,'logos'),join(afterDir,'logos')],{encoding:'utf8'}));
  reports.push({name,field,value,before:beforeDir,after:afterDir,sourceBackup:imported.backup,checks,rasterChecks,geometryPreserved:true,sourceAssetsPreserved:true,fontsPreserved:true});
}
await writeFile(join(run,'acceptance.json'),JSON.stringify({ready:false,fixtureDisclosure:'These are authored acceptance briefs and supplied-material fixtures, not customer commissions.',reports},null,2)+'\n');
console.log(JSON.stringify({run,briefs:reports.length,checkedRevisions:reports.length,ready:false}));
