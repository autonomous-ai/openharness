import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,cp,readFile,writeFile,rm,mkdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateProject,renderBoard,direction,contrast,websiteHTML,identityFiles,restoreApproved } from '../template/studio/project.mjs';
import { readProject,buildBrand } from '../template/tools/build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),template=join(root,'template');
const original=await readProject(template);
test('the brief has two original geometry systems and six real applications each',()=>{
  assert.equal(original.directions.length,2);assert.equal(original.directions[0].boards.length,6);
  assert.notDeepEqual(original.directions[0].symbols,original.directions[1].symbols);
  assert.notEqual(renderBoard(original,'wordmark').svg,renderBoard(original,'wordmark',{directionId:original.directions[1].id}).svg);
});
test('shared copy revises every identity without changing geometry or approved material',()=>{
  const p=structuredClone(original),geometry=JSON.stringify(p.directions);p.copy.name='North & South <Bakery>';
  for(const d of p.directions){assert.match(renderBoard(p,'wordmark',{directionId:d.id}).svg,/North &amp;/);}
  assert.equal(JSON.stringify(p.directions),geometry);assert.equal(p.copy.contact,original.copy.contact);
});
test('local text edits remain local and long text raises a usable layout warning',()=>{
  const p=structuredClone(original),d=direction(p);d.boards.find(b=>b.id==='wordmark').layers.find(l=>l.id==='name').text='One local name';
  assert.match(renderBoard(p,'wordmark').svg,/One/);assert.match(renderBoard(p,'bread-label').svg,/Morrow/);
  p.copy.name='A very long bakery name '.repeat(20);assert.ok(renderBoard(p,'bread-label').warnings.some(w=>w.kind==='text-overflow'));
});
test('renders editable text, embedded fonts and vector paths with correct dimensions',()=>{
  const r=renderBoard(original,'wordmark');assert.equal(r.width,1600);assert.equal(r.height,650);
  assert.match(r.svg,/<text/);assert.match(r.svg,/<path/);assert.match(r.svg,/data:font\/ttf;base64/);assert.equal(r.svg.includes('<script'),false);
  assert.ok(contrast('#000000','#ffffff')>20.99);
});
test('validation catches broken bindings, missing fonts and invalid production data',()=>{
  for(const mutate of [p=>p.copy.name=42,p=>p.fonts[0].license='',p=>p.directions[0].boards[0].layers[1].text='{{missing}}',p=>p.website.href='javascript:alert(1)',p=>p.directions[0].colors.ink='url(http://remote)',p=>p.directions[0].boards[0].width=0,p=>p.directions[0].symbols.mark.paths[0].d='<script>']){const p=structuredClone(original);mutate(p);assert.throws(()=>validateProject(p));}
});
test('website exports real copy and a functional declared contact link without a fake signup',()=>{
  const p=structuredClone(original);p.copy.headline='User-owned headline';const html=websiteHTML(p);
  assert.match(html,/User-owned headline/);assert.match(html,/href="mailto:hello@morrow.example"/);assert.match(html,/@media\(max-width:700px\)/);assert.equal(html.includes('<form'),false);
});
test('logo exports retain rotated artwork and reject colliding filenames',()=>{
  const p=structuredClone(original),d=direction(p),b=d.boards[0];
  b.layers=[{id:'test',type:'rect',x:300,y:100,width:200,height:100,rotation:90,fill:'$ink'}];d.logos=[{id:'test',board:b.id,layers:['test']}];
  assert.match(identityFiles(p).find(([name])=>name==='logos/test-ink.svg')[1],/viewBox="326 26 149 248"|viewBox="326 26 148 248"/);
  d.logos[0].id=Object.keys(d.symbols)[0];assert.throws(()=>validateProject(p),/unique/);
});
test('approved versions keep their own valid typography and reject corrupt saved designs',()=>{
  const p=structuredClone(original);p.approvals=[{at:new Date().toISOString(),copy:structuredClone(p.copy),assets:[],fonts:structuredClone(p.fonts),direction:structuredClone(direction(p))}];
  assert.equal(validateProject(p).approvals.length,1);p.approvals[0].direction.boards[0].layers[0].symbol='missing';assert.throws(()=>validateProject(p),/Missing symbol/);
});
test('restoring an approval preserves materials and bindings introduced by another direction',()=>{
  const p=structuredClone(original),saved={at:new Date().toISOString(),copy:structuredClone(p.copy),assets:[],fonts:structuredClone(p.fonts),direction:structuredClone(direction(p))};
  p.copy.new_caption='A later direction';p.copy.name='Changed name';p.directions[1].boards[0].layers.find(l=>l.type==='text').text='{{new_caption}}';
  p.assets.push({id:'new_photo',name:'Later supplied image',data:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>').toString('base64')});
  const restored=restoreApproved(p,saved);assert.equal(restored.copy.name,original.copy.name);assert.equal(restored.copy.new_caption,'A later direction');assert.equal(restored.assets[0].id,'new_photo');assert.deepEqual(restored.directions[1],p.directions[1]);
});
test('the actual build detects stale source, and importing a saved project retains history',async()=>{
  const ws=await mkdtemp(join(tmpdir(),'forme-source-'));try{
    await cp(template,ws,{recursive:true});await buildBrand(ws,{check:true});
    const path=join(ws,'board/project.json'),before=await readFile(path,'utf8'),p=JSON.parse(before);p.copy.name='New source name';await writeFile(path,JSON.stringify(p));
    await assert.rejects(buildBrand(ws,{check:true}),/stale/);await buildBrand(ws);await buildBrand(ws,{check:true});
    const saved=structuredClone(original);saved.copy.name='Saved browser name';await writeFile(join(ws,'saved.forme.json'),JSON.stringify(saved));
    const imported=spawnSync(process.execPath,[join(ws,'tools/import-project.mjs'),join(ws,'saved.forme.json')],{encoding:'utf8'});assert.equal(imported.status,0,imported.stderr);
    const report=JSON.parse(imported.stdout);assert.equal(JSON.parse(await readFile(join(report.backup,'project.json'))).copy.name,'New source name');
    assert.equal((await readProject(ws)).copy.name,'Saved browser name');await buildBrand(ws,{check:true});
  }finally{await rm(ws,{recursive:true,force:true});}
});
test('source assets cannot escape the workspace through symlinks',async()=>{
  const ws=await mkdtemp(join(tmpdir(),'forme-assets-'));try{
    await cp(template,ws,{recursive:true});const outside=join(ws,'outside.svg');await writeFile(outside,'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await symlink(outside,join(ws,'board/escape.svg'));const p=JSON.parse(await readFile(join(ws,'board/project.json'),'utf8'));p.assets=[{id:'logo',name:'Logo',file:'escape.svg'}];await writeFile(join(ws,'board/project.json'),JSON.stringify(p));
    await assert.rejects(readProject(ws),/inside board/);
  }finally{await rm(ws,{recursive:true,force:true});}
});
