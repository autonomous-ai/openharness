import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {serve} from '../skills/openscad/scripts/serve-handoff.mjs';
const workspace=resolve(process.argv[2]),out=resolve(process.argv[3]);
if(!process.env.PLAYWRIGHT_MODULE)throw new Error('Set PLAYWRIGHT_MODULE to a locally installed Playwright module.');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const server=await serve(workspace),url='http://127.0.0.1:'+server.address().port;
const report=JSON.parse(await readFile(join(workspace,'handoff/checks.json')));
await mkdir(out,{recursive:true});
let browser;const evidence={title:report.title,sourceRevision:report.sourceRevision,viewports:[],downloads:[]};
try{
  browser=await chromium.launch({headless:true});
  for(const [device,width,height] of [['desktop',1600,1100],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);await page.getByRole('heading',{name:report.title,exact:true}).waitFor();
    assert.equal(await page.locator('[data-variant][aria-pressed=true]').getAttribute('data-variant'),report.design.preview.variant);
    await page.locator('.family-comparison summary').click();
    assert.equal(await page.locator('.family-comparison tbody tr:visible').count(),report.variants.length);
    await page.locator('.family-comparison summary').click();
    for(const variant of report.variants){
      await page.locator('[data-variant="'+variant.id+'"]').click();
      const panel=page.locator('[data-panel="'+variant.id+'"]');
      assert.equal(await panel.isVisible(),true);
      assert.equal(await page.locator('.variant:visible').count(),1);
      await panel.locator('img').first().waitFor();
      await page.waitForFunction(()=>[...document.querySelectorAll('.variant:not([hidden]) img')].every(image=>image.complete&&image.naturalWidth>0));
      assert.equal(await panel.locator('.part').count(),variant.parts.length);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'horizontal overflow');
      for(const [index,part] of variant.parts.entries()){
        await panel.locator('.part').nth(index).screenshot({path:join(out,device+'-'+variant.id+'-'+part.id+'.png')});
      }
      await panel.locator('details.checks summary').click();
      assert.equal(await panel.locator('.check:visible').count(),report.checks.filter(check=>check.variant===variant.id).length);
      await panel.locator('details.checks summary').click();
    }
    await page.locator('[data-variant="'+report.design.preview.variant+'"]').click();await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:join(out,device+'.png'),fullPage:true});
    if(device==='desktop')await page.screenshot({path:join(out,'store.jpg'),type:'jpeg',quality:90});
    if(device==='desktop'){
      const links=await page.locator('a').evaluateAll(items=>items.map(a=>({href:a.href,download:a.hasAttribute('download')})));
      for(const link of links){
        const response=await page.request.get(link.href);assert.equal(response.status(),200,link.href);
        const relative=new URL(link.href).pathname.slice(1);
        assert.deepEqual(await response.body(),await readFile(join(workspace,relative)));
      }
      for(const variant of report.variants){
        await page.locator('[data-variant="'+variant.id+'"]').click();
        for(const part of variant.parts){
          const link=page.locator('[data-panel="'+variant.id+'"] a[href="'+part.path.replace('handoff/','')+'"]');
          const pending=page.waitForEvent('download');await link.click();const download=await pending;
          assert.equal(await download.failure(),null);
          assert.deepEqual(await readFile(await download.path()),await readFile(join(workspace,part.path)));
          evidence.downloads.push(part.path);
        }
      }
      const pending=page.waitForEvent('download');await page.locator('.primary a').click();const download=await pending;
      assert.deepEqual(await readFile(await download.path()),await readFile(join(workspace,'handoff/project.zip')));
      evidence.downloads.push('handoff/project.zip');
      assert.equal((await page.request.get(url+'/model.scad')).status(),404);
      assert.equal((await page.request.get(url+'/.harness/mesh.json')).status(),404);
      assert.equal((await page.request.post(url+'/handoff/checks.json')).status(),405);
    }
    assert.deepEqual(errors,[]);evidence.viewports.push({width,height,variants:report.variants.length,errors});await page.close();
  }
  await writeFile(join(out,'browser-receipt.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{
  if(browser)await browser.close();await new Promise(done=>server.close(done));
}
