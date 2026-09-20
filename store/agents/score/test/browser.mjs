// Opt-in acceptance through the same opaque-origin viewer used in Harness.
// Does not overwrite the builder's readiness verdict.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createHtmlViewer} from '../../../viewers/isolated-web-viewer/viewer.mjs';

const workspace=resolve(process.argv[2]),out=resolve(process.argv[3]);
await mkdir(out,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const server=await createHtmlViewer(workspace);server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true});
const errors=[],report={workspace,passed:false,downloads:[],screenshots:[]};
try {
  const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(response.status()+' '+response.url());});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?file=score.html');
  const frame=page.frameLocator('#preview');
  await frame.locator('#title').waitFor();
  await frame.locator('#pages img').evaluateAll(images=>Promise.all(images.map(img=>img.decode())));
  assert.match(await page.locator('#preview').getAttribute('sandbox'),/allow-downloads/);
  await frame.locator('#play').click();await page.waitForTimeout(450);
  assert.equal(await frame.locator('#play').getAttribute('aria-pressed'),'true');
  assert.ok(Number(await frame.locator('#roll').getAttribute('data-position'))>.2);
  const signal=await frame.locator('body').evaluate(async()=>{
    const analyser=audio.createAnalyser();master.connect(analyser);
    await new Promise(resolve=>setTimeout(resolve,120));
    const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);master.disconnect(analyser);
    return {state:audio.state,rms:Math.sqrt(values.reduce((sum,x)=>sum+x*x,0)/values.length)};
  });
  assert.equal(signal.state,'running');assert.ok(signal.rms>1e-6);report.liveAudio=signal;
  await frame.locator('#seek').fill('1.25');await frame.locator('#seek').dispatchEvent('input');
  await page.waitForTimeout(100);
  assert.ok(Number(await frame.locator('#roll').getAttribute('data-held'))>0,'Seeking resumes sustained notes');
  await frame.locator('#play').click();
  const first=frame.locator('.player').first(),id=await first.getAttribute('data-player');
  await first.locator('[data-control=solo]').click();
  assert.equal(await first.getAttribute('data-audible'),'true');
  for(const row of await frame.locator('.player').all())if(await row.getAttribute('data-player')!==id)assert.equal(await row.getAttribute('data-audible'),'false');
  await first.locator('[data-control=solo]').click();
  await first.locator('[data-control=muted]').click();assert.equal(await first.getAttribute('data-audible'),'false');
  await first.locator('[data-control=muted]').click();
  await frame.locator('#speed').fill('0.75');await frame.locator('#speed').dispatchEvent('input');
  assert.equal(await frame.locator('#speed-value').textContent(),'0.75×');
  await frame.locator('#loop-start').fill('2');await frame.locator('#loop-end').fill('2');await frame.locator('#loop-end').dispatchEvent('change');await frame.locator('#loop').check();
  await frame.locator('#count-in').check();
  const downloaded=async(selector,name)=>{
    const event=page.waitForEvent('download');await frame.locator(selector).click();const download=await event;
    assert.equal(await download.failure(),null);await download.saveAs(join(out,name));return readFile(join(out,name));
  };
  const settings=await downloaded('#save-settings','listening.json');
  assert.equal(JSON.parse(settings).speed,.75);
  await frame.locator('#speed').fill('1.25');await frame.locator('#speed').dispatchEvent('input');
  await frame.locator('#load-settings').setInputFiles(join(out,'listening.json'));
  await frame.locator('#status').filter({hasText:'Listening setup restored'}).waitFor();
  assert.equal(await frame.locator('#speed-value').textContent(),'0.75×');
  assert.equal(await frame.locator('#loop').isChecked(),true);
  const bad={...JSON.parse(settings),sourceRevision:'wrong'};await writeFile(join(out,'wrong-setup.json'),JSON.stringify(bad));
  await frame.locator('#load-settings').setInputFiles(join(out,'wrong-setup.json'));
  await frame.locator('#error').filter({hasText:'different source revision'}).waitFor();
  assert.equal(await frame.locator('#speed-value').textContent(),'0.75×');
  const config=await frame.locator('#config').textContent(),data=JSON.parse(config);
  const bar=data.ensemble.meter[0]*4/data.ensemble.meter[1]*60/data.ensemble.quarterBpm;
  await frame.locator('#play').click();
  await page.waitForTimeout(Math.ceil(2*bar/.75*1000+300));
  const loopPosition=Number(await frame.locator('#roll').getAttribute('data-position'));
  assert.equal(await frame.locator('#play').getAttribute('aria-pressed'),'true');
  assert.ok(loopPosition>=bar && loopPosition<=2*bar,'Playback loops within selected bars');
  await frame.locator('#play').click();report.loopPosition=loopPosition;
  const wav=await downloaded('#audio-export','mix.wav');
  assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.equal(wav.subarray(8,12).toString(),'WAVE');
  const wavSeconds=wav.readUInt32LE(40)/2/22050;
  assert.ok(Math.abs(wavSeconds-(2*bar/.75+.01))<1/22050);
  let energy=0,peak=0;for(let p=44;p<wav.length;p+=2){const v=wav.readInt16LE(p);energy+=v*v;peak=Math.max(peak,Math.abs(v));}
  assert.ok(energy>0);assert.ok(peak<32767);report.wav={seconds:wavSeconds,peak,rms:Math.sqrt(energy/((wav.length-44)/2))};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const project=await downloaded('#project','project.zip');assert.equal(hash(project),hash(await readFile(join(workspace,'score-project.zip'))));
  report.downloads.push('score-project.zip');
  for(const doc of data.documents){
    await frame.locator('#document').selectOption(doc.id);await frame.locator('#pages img').evaluateAll(images=>Promise.all(images.map(img=>img.decode())));
    assert.equal(await frame.locator('#pages').getAttribute('data-document'),doc.id);
    const bytes=await downloaded('#pdf',doc.id+'.pdf');assert.equal(hash(bytes),hash(await readFile(join(workspace,doc.pdf))));report.downloads.push(doc.pdf);
  }
  for(const item of data.practice){
    const bytes=await downloaded('a[href="'+item.path+'"]',item.path.split('/').at(-1));
    assert.equal(hash(bytes),hash(await readFile(join(workspace,item.path))));report.downloads.push(item.path);
  }
  // WAV must reflect the mix, not silently export muted parts.
  for(const button of await frame.locator('.player [data-control=muted]').all())await button.click();
  await frame.locator('#audio-export').click();await frame.locator('#error').filter({hasText:'mix is silent'}).waitFor();
  for(const button of await frame.locator('.player [data-control=muted]').all())await button.click();
  await frame.locator('#document').selectOption('score');await frame.locator('#loop').uncheck();await frame.locator('#count-in').uncheck();await frame.locator('#restart').click();
  await frame.locator('#pages img').evaluateAll(images=>Promise.all(images.map(img=>img.decode())));
  await frame.locator('body').evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:join(out,'desktop.png'),fullPage:true});report.screenshots.push('desktop.png');
  await page.screenshot({path:join(out,'store.jpg'),type:'jpeg',quality:88,fullPage:false});report.screenshots.push('store.jpg');
  await frame.locator('#document').selectOption(data.documents[1].id);
  await frame.locator('#pages img').evaluateAll(images=>Promise.all(images.map(img=>img.decode())));
  await frame.locator('body').evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:join(out,'part.png'),fullPage:false});report.screenshots.push('part.png');
  await page.screenshot({path:join(out,'part.jpg'),type:'jpeg',quality:88,fullPage:false});report.screenshots.push('part.jpg');
  await page.setViewportSize({width:390,height:844});
  await frame.locator('#title').waitFor();
  const overflow=await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  assert.equal(overflow,false,'No mobile horizontal overflow');
  await frame.locator('#play').click();await page.waitForTimeout(350);assert.equal(await frame.locator('#play').getAttribute('aria-pressed'),'true');await frame.locator('#play').click();
  await frame.locator('body').evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:join(out,'mobile.png'),fullPage:true});report.screenshots.push('mobile.png');
  await frame.locator('.score-view').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'mobile-score.png'),fullPage:false});report.screenshots.push('mobile-score.png');
  await frame.locator('.below').evaluate(node=>node.scrollIntoView({block:'start'}));
  await page.screenshot({path:join(out,'mobile-pack.png'),fullPage:false});report.screenshots.push('mobile-pack.png');
  assert.deepEqual(errors,[]);report.passed=true;console.log(JSON.stringify(report,null,2));
} finally {
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.errors=errors;await writeFile(join(out,'browser-proof.json'),JSON.stringify(report,null,2)+'\n');
}
