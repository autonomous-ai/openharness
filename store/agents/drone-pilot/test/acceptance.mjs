import {mkdir,mkdtemp,cp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {orchard,yard,estuary,recordedCSV,logMapping} from './fixtures.mjs';
import {planProject,clone} from '../template/studio/project.mjs';
import {importFlight} from '../template/studio/log.mjs';
import {exportFlight} from '../template/tools/export.mjs';
import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {browserPath} from '../toolchain/browser.mjs';
const root=resolve(process.env.DRONE_ACCEPTANCE_ROOT||'work/experience-evidence/vector-acceptance');await mkdir(root,{recursive:true});
const browser=await chromium.launch({executablePath:await browserPath(),headless:true}),results=[];
process.env.DRONE_DSH_DIR=fileURLToPath(new URL('../',import.meta.url));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
try{
  for(const create of [orchard,yard,estuary]){
    const before=create(),after=clone(before);let revision;
    if(create===orchard){after.settings.angle=25;after.settings.height=50;after.settings.margin=8;revision='Lower capture height and rotate runs; increase margin while preserving the approved pond.';}
    if(create===yard){after.areas.find(a=>a.id==='plant').ring=after.areas.find(a=>a.id==='plant').ring.map(([x,y])=>[x+10,y+8]);after.settings.angle=0;revision='Move equipment exclusion and reorient capture runs; retain the locked storage compound.';}
    if(create===estuary){after.settings.usableMinutes=7;after.areas.find(a=>a.id==='east').ring[2]=[435,105];revision='Extend the east plot and shorten usable time; preserve west plot and reed bed.';}
    const approved=before.areas.filter(a=>a.locked).map(a=>({id:a.id,sha256:hash(a)}));
    for(const item of approved)assert.equal(hash(after.areas.find(a=>a.id===item.id)),item.sha256);
    const deliveries=[];
    for(const [stage,p]of [['before',before],['after',after]]){
      const directory=join(root,p.id,stage),workspace=join(directory,'workspace'),output=join(directory,'delivery');await mkdir(directory,{recursive:true});await cp(fileURLToPath(new URL('../template/',import.meta.url)),workspace,{recursive:true});
      if(stage==='after'){const planned=planProject(p);p.log=await importFlight(recordedCSV(planned),'synthetic-acceptance-flight.csv',logMapping,p.origin);}
      await writeFile(join(workspace,'flight/project.json'),JSON.stringify(p,null,2)+'\n');const delivery=await exportFlight(workspace,output),plan=planProject(p);
      await writeFile(join(directory,'geometry.json'),JSON.stringify({project:p,region:plan.region,target:plan.target,covered:plan.covered,gaps:plan.gaps,photos:plan.photos,sorties:plan.sorties,camera:plan.camera,area:plan.area,coverage:plan.coverage}));
      const page=await browser.newPage({viewport:{width:1536,height:980}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.context().setOffline(true);await page.goto(pathToFileURL(join(output,'planner.html')).href);await page.waitForFunction(()=>window.vector?.plan);assert.equal(await page.evaluate(()=>vector.plan.photos.length),delivery.photos);await page.screenshot({path:join(directory,'studio.png')});
      if(stage==='after'){await page.locator('#evidence-tab').click();await page.locator('#show-coverage').check();await page.screenshot({path:join(directory,'evidence.png')});}
      await page.goto(pathToFileURL(join(output,'report.html')).href);await page.screenshot({path:join(directory,'report.png'),fullPage:true});await page.pdf({path:join(directory,'report.pdf'),format:'A4',printBackground:true});assert.deepEqual(errors,[]);await page.close();
      deliveries.push({...delivery,stage,geometry:join(directory,'geometry.json'),screenshot:join(directory,'studio.png'),report:join(directory,'report.pdf')});
    }
    results.push({title:before.title,revision,approved,deliveries});
  }
  await writeFile(join(root,'acceptance.json'),JSON.stringify({scope:'Three authored geometry briefs and revisions. Logs are synthetic test fixtures, not flown missions or customer trials.',results},null,2));console.log(JSON.stringify({root,results}));
}finally{await browser.close();}
