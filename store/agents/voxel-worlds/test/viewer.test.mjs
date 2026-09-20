import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp,cp,readFile,writeFile,rm,mkdir,readdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldViewer } from '../viewer/viewer.mjs';
const template=fileURLToPath(new URL('../template',import.meta.url));
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'tidelands-viewer-')),ws=join(dir,'workspace'),home=join(dir,'home');await cp(template,ws,{recursive:true});await mkdir(join(home,'Downloads'),{recursive:true});const server=await createWorldViewer(ws,{home});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;try{await fn({ws,home,base});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}}
test('workspace save roundtrips real browser data, rebuilds output and rejects stale revisions',()=>fixture(async({ws,base})=>{
  const before=(await(await fetch(base+'/api/project')).json()).project,edited=structuredClone(before);edited.title='New harbor title';
  const put=p=>fetch(base+'/api/project',{method:'PUT',headers:{origin:base,'content-type':'application/json','if-match':before.revision},body:JSON.stringify(p)});
  const response=await put(edited);assert.equal(response.status,200);const after=(await response.json()).project;assert.notEqual(after.revision,before.revision);
  assert.equal(JSON.parse(await readFile(join(ws,'world/project.json'))).title,'New harbor title');assert.match(await readFile(join(ws,'world/index.html'),'utf8'),/New harbor title/);
  const history=await readdir(join(ws,'.harness/history'));assert.equal(history.length,1);assert.equal(JSON.parse(await readFile(join(ws,'.harness/history',history[0]))).title,'Lantern Quay');
  const stale=await put(before);assert.equal(stale.status,409);assert.equal((await stale.json()).project.title,'New harbor title');
}));
test('invalid project cannot overwrite the workspace and cross-origin writes are refused',()=>fixture(async({ws,base})=>{
  const before=await readFile(join(ws,'world/project.json'),'utf8');
  for(const origin of ['https://foreign.example',undefined]){const r=await fetch(base+'/api/project',{method:'PUT',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:'{}'});assert.equal(r.status,403);}
  const invalid=await fetch(base+'/api/project',{method:'PUT',headers:{origin:base,'content-type':'application/json'},body:'{}'});assert.equal(invalid.status,400);
  assert.equal(await readFile(join(ws,'world/project.json'),'utf8'),before);
  const rejectedHost=await new Promise((resolve,reject)=>{get(base+'/api/project',{headers:{host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
  assert.equal(rejectedHost,403);
  assert.equal((await fetch(base+'/files/.harness/verdict.json')).status,404);
}));
test('native picker opens only an explicitly selected visible home project',()=>fixture(async({ws,home,base})=>{
  const project=(await(await fetch(base+'/api/project')).json()).project,chosen=join(home,'Downloads','A world.tidelands.json');await writeFile(chosen,JSON.stringify(project));
  const files=(await(await fetch(base+'/api/files')).json()).files;assert.equal(files.length,1);assert.equal(files[0].name,'A world.tidelands.json');
  const open=path=>fetch(base+'/api/open',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({path})});
  assert.equal((await open('"~/Downloads/A world.tidelands.json"')).status,200);
  const secret=join(home,'.hidden');await mkdir(secret);await writeFile(join(secret,'private.tidelands.json'),JSON.stringify(project));assert.equal((await open(join(secret,'private.tidelands.json'))).status,400);
  await writeFile(join(ws,'outside.tidelands.json'),JSON.stringify(project));await symlink(join(ws,'outside.tidelands.json'),join(home,'Downloads','link.tidelands.json'));assert.equal((await open(join(home,'Downloads','link.tidelands.json'))).status,400);
  assert.equal(JSON.parse(await readFile(join(ws,'world/project.json'))).title,'Lantern Quay','opening a file does not save over the workspace');
}));
