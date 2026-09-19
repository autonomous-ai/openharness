import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import { chromium, preview } from './helpers.mjs';
import { build } from '../../agents/quantum-studio/skills/quantum/scripts/build.mjs';
import { simulate, probabilities } from '../../agents/quantum-studio/skills/quantum/scripts/engine.mjs';

let browser;
before(async()=>{browser=await(await chromium()).launch({headless:true});});
after(async()=>{await browser?.close();});
const prepare=workspace=>build(workspace);
test('Quantum Studio steps through entanglement, edits phase, samples, undoes and exports a real circuit',async()=>{
  const run=await preview(browser,'store/agents/quantum-studio/template',{prepare});
  try{
    const frame=await run.open();
    await frame.locator('#circuit-name').filter({hasText:'Bell state'}).waitFor();
    const probability=bits=>frame.locator('[data-basis="'+bits+'"] .value').textContent();
    assert.equal(await probability('00'),'50.0%');
    assert.equal(await probability('11'),'50.0%');
    assert.match(await frame.locator('#state-note').textContent(),/Entangled/);
    assert.equal(await frame.locator('.purity b').first().textContent(),'0.500');
    await frame.getByRole('button',{name:/Bell pair/}).click();
    console.log('screenshot:',await run.screenshot('quantum-studio-desktop'));
    await frame.getByLabel('Circuit step',{exact:true}).fill('1');
    assert.equal(await probability('01'),'50.0%');
    assert.equal(await frame.locator('.purity b').first().textContent(),'1.000');
    await frame.getByRole('button',{name:/Interference/}).click();
    await frame.getByLabel('Rotation angle',{exact:true}).fill('180');
    assert.equal(await probability('1'),'100.0%');
    await frame.getByRole('button',{name:'Sample outcomes',exact:true}).click();
    assert.match(await probability('1'),/1024 shots/);
    await frame.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await probability('1'),'50.0%');
    await frame.getByRole('button',{name:'Redo',exact:true}).click();
    assert.equal(await probability('1'),'100.0%');
    const download=run.page.waitForEvent('download');
    await frame.getByRole('button',{name:/Save circuit/}).click();
    const cfg=JSON.parse(await readFile(await(await download).path(),'utf8'));
    assert.ok(Math.abs(probabilities(simulate(cfg))[1]-1)<1e-10);
    await frame.getByRole('button',{name:/GHZ state/}).click();
    assert.equal(await probability('111'),'50.0%');
    assert.equal(await frame.locator('.sphere').count(),3);
    await frame.getByLabel('Gate type').selectOption('X');
    await frame.getByLabel('Target qubit').selectOption('0');
    await frame.getByRole('button',{name:'+ Add gate',exact:true}).click();
    assert.equal(await probability('001'),'50.0%');
    await run.page.setViewportSize({width:390,height:844});
    assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    console.log('screenshot:',await run.screenshot('quantum-studio-mobile'));
    assert.deepEqual(run.errors,[]);
  }finally{await run.close();}
});
test('untrusted circuit strings are data in the actual browser',async()=>{
  const run=await preview(browser,'store/agents/quantum-studio/template',{prepare:async workspace=>{
    await writeFile(join(workspace,'circuit.json'),JSON.stringify({name:'</script><img src=x onerror=alert(1)>',qubits:['<b>q0</b>'],gates:[]}));
    await build(workspace);
  }});
  try{
    const frame=await run.open();
    await frame.locator('#circuit-name').filter({hasText:'</script>'}).waitFor();
    assert.equal(await frame.locator('img').count(),0);
    assert.equal(await frame.locator('#circuit b').count(),0);
    await frame.locator('#upload').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"qubits":["q0"],"gates":[{"gate":"H","target":-1}]}')});
    await frame.getByRole('alert').waitFor();
    assert.match(await frame.locator('#error').textContent(),/qubit index/);
    assert.equal(await frame.locator('#norm').textContent(),'1.0000','invalid edits leave the previous valid circuit intact');
    assert.deepEqual(run.errors,[]);
  }finally{await run.close();}
});
test('custom shot counts survive load, sampling, edits, undo and circuit export',async()=>{
  const run=await preview(browser,'store/agents/quantum-studio/template',{prepare:async ws=>{const file=join(ws,'circuit.json'),data=JSON.parse(await readFile(file,'utf8'));data.shots=73;await writeFile(file,JSON.stringify(data));await build(ws);}});
  try{const f=await run.open();assert.equal(await f.locator('#shots').inputValue(),'73');await f.locator('#measure').click();assert.match(await f.locator('#sample-status').textContent(),/^73 simulated shots/);await f.locator('#shots').selectOption('128');await f.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await f.locator('#shots').inputValue(),'73');const pending=run.page.waitForEvent('download');await f.getByRole('button',{name:/Save circuit/}).click();const download=await pending;assert.equal(JSON.parse(await readFile(await download.path(),'utf8')).shots,73);assert.deepEqual(run.errors,[]);}finally{await run.close();}
});
