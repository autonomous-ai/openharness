import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, preview } from './helpers.mjs';
let browser;
before(async()=>{browser=await(await chromium()).launch({headless:true});});
after(async()=>{await browser?.close();});
test('Atlas loads fully offline, filters and selects features, pans, zooms, measures and exports actual GeoJSON',async()=>{
  const run=await preview(browser,'store/agents/gis/template');
  try{
    const requests=[];
    await run.context.route('**/*',route=>{const url=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(url.hostname)){requests.push(url.href);return route.abort();}return route.continue();});
    const frame=await run.open();await frame.locator('#count').filter({hasText:'4'}).waitFor();
    await frame.locator('.leaflet-overlay-pane path[fill="#e5ead8"]').first().waitFor({state:'attached'});
    assert.equal(await frame.locator('.leaflet-overlay-pane path[fill="#e5ead8"]').count(),177);
    assert.equal(await frame.locator('#error').isVisible(),false);
    console.log('screenshot:',await run.screenshot('gis-desktop'));
    await frame.getByLabel('Search features').fill('Hanoi');assert.equal(await frame.locator('#count').textContent(),'1');
    await frame.locator('.feature').click();assert.equal(await frame.locator('#details h2').textContent(),'Hanoi');
    const download=run.page.waitForEvent('download');await frame.locator('#export').click();
    const file=await download;const exported=JSON.parse(await readFile(await file.path(),'utf8'));
    assert.equal(exported.features.length,1);assert.deepEqual(exported.features[0].geometry.coordinates,[105.8342,21.0278]);
    await frame.getByLabel('Search features').fill('nowhere');assert.equal(await frame.locator('#empty').isVisible(),true);
    assert.equal(await frame.locator('#export').isDisabled(),true);
    await frame.getByLabel('Search features').fill('');await frame.locator('#fit').click();
    const before=await frame.locator('#bounds-label').textContent();await frame.getByRole('button',{name:'Zoom in',exact:true}).click();
    assert.notEqual(await frame.locator('#bounds-label').textContent(),before);
    const map=frame.locator('#map'),box=await map.boundingBox();
    const panBefore=await frame.locator('#bounds-label').textContent();
    await run.page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await run.page.mouse.down();await run.page.mouse.move(box.x+box.width*.6,box.y+box.height*.55,{steps:5});await run.page.mouse.up();
    await frame.locator('#bounds-label').filter({hasText:panBefore}).waitFor({state:'hidden',timeout:5000});
    assert.notEqual(await frame.locator('#bounds-label').textContent(),panBefore);
    await frame.locator('#measure').click();
    await map.click({position:{x:box.width*.35,y:box.height*.4}});await map.click({position:{x:box.width*.65,y:box.height*.6}});
    assert.match(await frame.locator('#measurement').textContent(),/km · great-circle estimate/);
    await frame.locator('#clear-measure').click();assert.match(await frame.locator('#measurement').textContent(),/Tap two/);
    await run.page.setViewportSize({width:390,height:844});
    await frame.locator('#map').scrollIntoViewIfNeeded();
    assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    console.log('screenshot:',await run.screenshot('gis-mobile'));
    assert.deepEqual(requests,[]);assert.deepEqual(run.errors,[]);
  }finally{await run.close();}
});
test('Atlas imports points, lines and polygons safely, rejects malformed data, and preserves the previous valid layer',async()=>{
  const run=await preview(browser,'store/agents/gis/template');
  try{
    const frame=await run.open();await frame.locator('#count').filter({hasText:'4'}).waitFor();
    const name='<img src=x onerror="window.injected=1">';
    const features=[{type:'Feature',properties:{name},geometry:{type:'Point',coordinates:[0,0]}},{type:'Feature',properties:{name:'Route'},geometry:{type:'LineString',coordinates:[[0,0],[1,1]]}},{type:'Feature',properties:{name:'Area'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}];
    await frame.locator('#upload').setInputFiles({name:'my places.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features}))});
    await frame.locator('#count').filter({hasText:'3'}).waitFor();
    await frame.locator('.feature').first().click();assert.equal(await frame.locator('#details h2').textContent(),name);
    assert.equal(await frame.locator('#details img').count(),0);
    await frame.locator('#type').selectOption('Polygon');assert.equal(await frame.locator('#count').textContent(),'1');
    await frame.locator('#upload').setInputFiles({name:'bad.geojson',mimeType:'application/geo+json',buffer:Buffer.from('{bad')});
    await frame.locator('#error').waitFor();assert.match(await frame.locator('#error').textContent(),/previous layer is unchanged/);
    assert.equal(await frame.locator('#count').textContent(),'1');
    assert.deepEqual(run.errors,[]);
  }finally{await run.close();}
});
