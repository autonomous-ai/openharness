import {test} from 'node:test';import assert from 'node:assert/strict';import {cp} from 'node:fs/promises';import {chromium,preview} from './helpers.mjs';
test('real Godot export plays through all pickups, pauses, restarts and supports narrow screens',{skip:!process.env.GODOT_QA_WORKSPACE},async()=>{
  const browser=await(await chromium()).launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const p=await preview(browser,null,{file:'build/web/index.html',context:{viewport:{width:1600,height:1100}},prepare:ws=>cp(process.env.GODOT_QA_WORKSPACE+'/build',ws+'/build',{recursive:true})});
  try{
    const f=await p.open();await f.locator('#game-state[data-ready="true"]').waitFor({state:'attached',timeout:120000});await f.locator('#loading').waitFor({state:'hidden'});const canvas=f.locator('#canvas');
    for(const [i,[x,y]]of [[450,350],[700,200],[930,350],[750,525],[430,530],[230,190]].entries()){
      const box=await canvas.boundingBox();await canvas.click({position:{x:x/1200*box.width,y:y/700*box.height}});await f.locator('#game-state[data-collected="'+(i+1)+'"]').waitFor({state:'attached',timeout:15000});
    }
    assert.equal(await f.locator('#game-state').getAttribute('data-won'),'true');await f.locator('#restart').click();assert.equal(await f.locator('#collected').textContent(),'0');await f.locator('#pause').click();assert.equal(await f.locator('#pause').getAttribute('aria-pressed'),'true');const before=await f.locator('#game-state').getAttribute('data-x');await canvas.press('ArrowRight');assert.equal(await f.locator('#game-state').getAttribute('data-x'),before);await f.locator('#pause').click();
    await canvas.focus();await p.page.keyboard.down('ArrowRight');await f.locator('#game-state').evaluate(async el=>{const start=Number(el.dataset.x);await new Promise((resolve,reject)=>{const at=performance.now();function tick(){if(Number(el.dataset.x)>start+25)resolve();else if(performance.now()-at>4000)reject(new Error('keyboard did not move player'));else requestAnimationFrame(tick);}tick();});});await p.page.keyboard.up('ArrowRight');
    console.log(await p.screenshot('godot-studio-desktop'));await p.page.setViewportSize({width:390,height:844});assert.equal(await f.locator('html').evaluate(x=>x.scrollWidth<=x.clientWidth),true);await f.locator('#restart').click();const box=await canvas.boundingBox();await canvas.click({position:{x:450/1200*box.width,y:350/700*box.height}});await f.locator('#game-state[data-collected="1"]').waitFor({state:'attached',timeout:15000});console.log(await p.screenshot('godot-studio-mobile'));assert.deepEqual(p.errors,[]);
  }finally{await p.close();await browser.close();}
});
