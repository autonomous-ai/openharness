import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {join} from 'node:path';import {readFile,writeFile} from 'node:fs/promises';import {chromium,preview,root} from './helpers.mjs';
test('Habitat traces day/night, threshold crossing, YAML export and mobile layout',async()=>{
  const browser=await(await chromium()).launch({headless:true});
  const p=await preview(browser,'store/agents/home-assistant/template',{file:'dashboard.html',prepare:async ws=>{const r=spawnSync(process.execPath,[join(root,'store/agents/home-assistant/skills/home-assistant/scripts/build.mjs')],{cwd:ws,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}});
  try{
    const f=await p.open();await f.locator('#simulate').click();assert.equal(await f.locator('#outcome').getAttribute('data-status'),'would-run');await f.locator('#day').click();await f.locator('#simulate').click();assert.equal(await f.locator('#outcome').getAttribute('data-status'),'blocked');
    await f.getByRole('tab',{name:/fresh air/}).click();await f.locator('#simulate').click();assert.equal(await f.locator('#outcome').getAttribute('data-status'),'would-run');await f.locator('#event-from').fill('1100');await f.locator('#simulate').click();assert.equal(await f.locator('#outcome').getAttribute('data-status'),'no-trigger');
    await f.getByRole('tab',{name:/warmer welcome/}).click();await f.locator('#night').click();await f.locator('#simulate').click();await f.locator('body').evaluate(()=>window.scrollTo(0,0));console.log(await p.screenshot('home-assistant-desktop'));
    await f.locator('summary').click();const pending=p.page.waitForEvent('download');await f.locator('#download').click();const download=await pending;assert.equal(await readFile(await download.path(),'utf8'),await readFile(join(p.workspace,'automations.yaml'),'utf8'));
    await p.page.setViewportSize({width:390,height:844});assert.equal(await f.locator('html').evaluate(x=>x.scrollWidth<=x.clientWidth),true);console.log(await p.screenshot('home-assistant-mobile'));assert.deepEqual(p.errors,[]);
  }finally{await p.close();await browser.close();}
});
test('Habitat renders hostile aliases as text and unsupported duration as unknown',async()=>{
 const browser=await(await chromium()).launch({headless:true});const p=await preview(browser,null,{file:'dashboard.html',prepare:async ws=>{
   await writeFile(join(ws,'automations.yaml'),JSON.stringify([{id:'x',alias:'</script><img src=x onerror="window.pwned=1">',triggers:[{trigger:'state',entity_id:'person.demo',to:'home',for:'00:02:00'}],actions:[{action:'light.turn_on'}]}]));const r=spawnSync(process.execPath,[join(root,'store/agents/home-assistant/skills/home-assistant/scripts/build.mjs')],{cwd:ws,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }});try{const f=await p.open();await f.locator('#simulate').click();assert.equal(await f.locator('#outcome').getAttribute('data-status'),'unknown');assert.equal(await f.locator('body').evaluate(()=>window.pwned),undefined);assert.equal(await f.locator('img').count(),0);assert.deepEqual(p.errors,[]);}finally{await p.close();await browser.close();}
});
