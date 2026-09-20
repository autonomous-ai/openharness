import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp,mkdir,mkdtemp,readFile,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBrandViewer } from '../viewer/viewer.mjs';
import { buildBrand } from '../template/tools/build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export async function brandBrowser({browser,output}){
  const scratch=await mkdtemp(join(tmpdir(),'forme-browser-')),ws=join(scratch,'workspace'),home=join(scratch,'home');
  await cp(join(root,'template'),ws,{recursive:true});await mkdir(join(home,'Downloads'),{recursive:true});await mkdir(output,{recursive:true});
  execFileSync(join(root,'toolchain/init-workspace.sh'),[ws]);
  const server=await createBrandViewer(ws,{home});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  async function download(click,name){const pending=page.waitForEvent('download');await click();const d=await pending;assert.equal(await d.failure(),null);const path=join(output,name??d.suggestedFilename());await d.saveAs(path);return path;}
  try{
    await page.goto(base);await page.locator('body[data-ready=true]').waitFor();
    assert.equal(await page.locator('#save-project').textContent(),'Save to workspace');
    const icon=await page.locator('.wordmark svg').boundingBox();assert.ok(icon.y<66&&icon.height<=30,'studio icon stays in the header');
    await page.screenshot({path:join(output,'creative-direction-studio.png'),fullPage:true});
    const original=await page.evaluate(()=>forme.getProject());
    await page.locator('[data-view=identity]').click();await page.locator('[data-copy=name]').fill('Morrow & Co.');await page.locator('[data-copy=name]').press('Tab');
    assert.equal(await page.evaluate(()=>forme.getProject().copy.name),'Morrow & Co.');
    assert.ok(await page.evaluate(()=>forme.getSVG('wordmark').includes('Morrow &amp; Co.')));
    const before=await page.evaluate(()=>forme.getSVG('wordmark'));
    await page.locator('[data-color=accent]').fill('#efbc45');await page.locator('[data-color=accent]').dispatchEvent('change');
    assert.ok(await page.evaluate(()=>forme.getSVG('wordmark'))!==before,'color change reaches the rendered artwork');
    await page.locator('#undo').click();assert.ok(await page.evaluate(()=>forme.getSVG('wordmark'))===before,'undo restores the complete artwork');
    await page.locator('#approve').click();assert.equal(await page.evaluate(()=>forme.getProject().approvals.length),1);
    await page.locator('[data-view=collection]').click();await page.locator('[data-board=wordmark]').click();await page.locator('[data-layer-select=name]').click();
    await page.locator('#unlink-text').click();await page.locator('#layer-text').fill('Morrow local');await page.locator('#layer-text').press('Tab');
    assert.match(await page.evaluate(()=>forme.getSVG('wordmark')),/Morrow local/);assert.match(await page.evaluate(()=>forme.getSVG('bread-label')),/Morrow &amp; Co./);
    await page.locator('#undo').click();await page.locator('#undo').click();
    await page.locator('[data-layer-select=sunrise]').click();const oldPosition=await page.evaluate(()=>forme.getProject().directions[0].boards[0].layers[0].x);
    const rect=await page.locator('#stage [data-layer=sunrise]').boundingBox();await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+24,rect.y+rect.height/2,{steps:5});await page.mouse.up();
    assert.ok(await page.evaluate(x=>forme.getProject().directions[0].boards[0].layers[0].x>x,oldPosition));
    await page.locator('#undo').click();assert.equal(await page.evaluate(()=>forme.getProject().directions[0].boards[0].layers[0].x),oldPosition);
    await page.locator('#lock-layer').check();const locked=await page.evaluate(()=>forme.getProject().directions[0].boards[0].layers[0]);assert.equal(locked.locked,true);await page.locator('#lock-layer').uncheck();
    let releasePoll,markPoll;const heldPoll=new Promise(r=>markPoll=r),release=new Promise(r=>releasePoll=r);let delayPoll=true;
    await page.route('**/api/project',async route=>{if(route.request().method()==='GET'&&delayPoll){delayPoll=false;const response=await route.fetch();markPoll();await release;await route.fulfill({response});}else await route.continue();});
    await heldPoll;
    await page.locator('#save-project').click();await page.getByText('Saved. The agent can read your edits now.',{exact:true}).waitFor();
    const stalePollResponse=page.waitForResponse(r=>r.url()===base+'/api/project'&&r.request().method()==='GET');releasePoll();await stalePollResponse;await page.unroute('**/api/project');
    assert.equal(await page.locator('#revision-notice').isVisible(),false,'a stale poll cannot replace a successful save with the old source');
    const savedSource=JSON.parse(await readFile(join(ws,'board/project.json'),'utf8'));assert.equal(savedSource.copy.name,'Morrow & Co.');assert.equal(savedSource.copy.address,original.copy.address);
    savedSource.copy.headline='Fresh from the agent.';await writeFile(join(ws,'board/project.json'),JSON.stringify(savedSource));await buildBrand(ws);
    await page.locator('#revision-notice:not([hidden])').waitFor({timeout:10000});await page.locator('#use-source').click();
    assert.equal(await page.evaluate(()=>forme.getProject().copy.headline),'Fresh from the agent.');await page.locator('#undo').click();assert.equal(await page.evaluate(()=>forme.getProject().copy.headline),original.copy.headline);
    await page.locator('#save-project').click();await page.getByText('Saved. The agent can read your edits now.',{exact:true}).waitFor();
    await page.locator('[data-view=compare]').click();await page.locator('.compare svg').nth(11).waitFor();assert.ok(await page.locator('.compare svg').count()>=12);
    await page.locator('#restore-approved').click();assert.equal(await page.evaluate(()=>forme.getProject().copy.name),'Morrow & Co.');
    await page.locator('[data-view=website]').click();await page.locator('#mobile-preview').click();const website=page.frameLocator('iframe');assert.match(await website.locator('h1').textContent(),/Good bread/);
    await page.locator('[data-view=collection]').click();const kit=await download(()=>page.locator('#export-kit').click(),'forme-brand-kit.zip');
    const verification=JSON.parse(execFileSync('python3',['-c',`import json,sys,zipfile,struct,xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 project=json.loads(z.read('project.forme.json'))
 assert project['copy']['name']=='Morrow & Co.'
 assert len([n for n in z.namelist() if n.startswith('artwork/') and n.endswith('.svg')])==6
 assert len([n for n in z.namelist() if n.startswith('artwork/') and n.endswith('.png')])==6
 assert 'website/index.html' in z.namelist()
 assert 'logos/wordmark-ink.svg' in z.namelist()
 assert 'logos/mark-paper.svg' in z.namelist()
 assert 'logos/mark-paper.png' in z.namelist()
 assert len([n for n in z.namelist() if n.endswith('.ttf')])==2
 for board in project['directions'][0]['boards']:
  svg=ET.fromstring(z.read('artwork/'+board['id']+'.svg'))
  assert int(svg.attrib['width'])==board['width']
  assert struct.unpack('>II',z.read('artwork/'+board['id']+'.png')[16:24])==(board['width']*2,board['height']*2)
 z.extract('studio.html',sys.argv[2]);z.extract('project.forme.json',sys.argv[2]);z.extract('website/index.html',sys.argv[2])
 print(json.dumps({'files':len(z.namelist()),'artboards':6,'independentZipSvgPng':True}))`,kit,output],{encoding:'utf8'}));
    const offline=await context.newPage();await offline.goto(pathToFileURL(join(output,'studio.html')).href);await offline.locator('body[data-ready=true]').waitFor();assert.equal(await offline.evaluate(()=>forme.getProject().copy.name),'Morrow & Co.');assert.equal(await offline.locator('#save-project').textContent(),'Save project');await offline.close();
    const launch=await context.newPage();await launch.setViewportSize({width:390,height:844});await launch.goto(pathToFileURL(join(output,'website/index.html')).href);await launch.evaluate(()=>document.fonts.ready);assert.ok(await launch.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await launch.locator('a.cta').getAttribute('href'),'mailto:hello@morrow.example');await launch.screenshot({path:join(output,'creative-direction-website-mobile.png'),fullPage:true});await launch.close();
    await cp(join(output,'project.forme.json'),join(home,'Downloads','My brand.forme.json'));await page.locator('#open-project').click();await page.locator('#recent-files button').first().click();assert.equal(await page.evaluate(()=>forme.getProject().copy.name),'Morrow & Co.');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'creative-direction-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.setViewportSize({width:1600,height:1100});await page.evaluate(()=>forme.chooseDirection('neighborhood-note'));
    const warnings=await page.evaluate(async()=>{const p=forme.getProject();return (await Promise.all(p.directions.find(d=>d.id===p.active).boards.map(b=>forme.deliver(b.id,1)))).flatMap(r=>r.warnings);});assert.deepEqual(warnings,[]);
    await page.screenshot({path:join(output,'creative-direction-alternate.png'),fullPage:true});assert.deepEqual(errors,[]);
    return {id:'creative-direction',ok:true,checks:['fresh workspace','shared copy and color','local overrides','direct dragging','undo','layer lock','disk save and backup','source conflict and draft recovery','approved comparison','native project picker','portable studio','responsive exported website','both authored directions'],...verification};
  }finally{await context.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let chromium;try{({chromium}=await import(process.env.PLAYWRIGHT_MODULE||new URL('../toolchain/node_modules/playwright-core/index.mjs',import.meta.url).href));}catch{({chromium}=await import(new URL('../../../tools/experience-tests/node_modules/playwright-core/index.mjs',import.meta.url).href));}
  const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined,channel:process.env.BROWSER_EXECUTABLE?undefined:'chrome',headless:true});
  try{console.log(JSON.stringify(await brandBrowser({browser,output:process.env.EXPERIENCE_OUTPUT||fileURLToPath(new URL('../../../../work/experience-evidence',import.meta.url))}),null,2));}finally{await browser.close();}
}
