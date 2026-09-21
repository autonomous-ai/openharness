import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp,cp,readFile,writeFile,rm,mkdir,readdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlightViewer } from '../viewer/viewer.mjs';
process.env.DRONE_DSH_DIR=fileURLToPath(new URL('../',import.meta.url));
const template=fileURLToPath(new URL('../template',import.meta.url));
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'vector-viewer-')),ws=join(dir,'workspace'),home=join(dir,'home');await cp(template,ws,{recursive:true});await mkdir(join(home,'Downloads'),{recursive:true});const server=await createFlightViewer(ws,{home});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;try{await fn({ws,home,base});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}}
test('workspace save roundtrips real browser data, rebuilds output and rejects stale revisions',()=>fixture(async({ws,base})=>{
  const before=(await(await fetch(base+'/api/project')).json()).project,edited=structuredClone(before);edited.title='New survey title';
  const put=p=>fetch(base+'/api/project',{method:'PUT',headers:{origin:base,'content-type':'application/json','if-match':before.revision},body:JSON.stringify(p)});
  const response=await put(edited);assert.equal(response.status,200);const after=(await response.json()).project;assert.notEqual(after.revision,before.revision);
  assert.equal(JSON.parse(await readFile(join(ws,'flight/project.json'))).title,'New survey title');assert.match(await readFile(join(ws,'flight/index.html'),'utf8'),/New survey title/);
  const history=await readdir(join(ws,'.harness/history'));assert.equal(history.length,1);assert.equal(JSON.parse(await readFile(join(ws,'.harness/history',history[0]))).title,'Alder Orchard');
  const stale=await put(before);assert.equal(stale.status,409);assert.equal((await stale.json()).project.title,'New survey title');
}));
test('invalid project cannot overwrite the workspace and cross-origin writes are refused',()=>fixture(async({ws,base})=>{
  const before=await readFile(join(ws,'flight/project.json'),'utf8');
  for(const origin of ['https://foreign.example',undefined]){const r=await fetch(base+'/api/project',{method:'PUT',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:'{}'});assert.equal(r.status,403);}
  const invalid=await fetch(base+'/api/project',{method:'PUT',headers:{origin:base,'content-type':'application/json'},body:'{}'});assert.equal(invalid.status,400);
  assert.equal(await readFile(join(ws,'flight/project.json'),'utf8'),before);
  const rejectedHost=await new Promise((resolve,reject)=>{get(base+'/api/project',{headers:{host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
  assert.equal(rejectedHost,403);
  assert.equal((await fetch(base+'/files/.harness/verdict.json')).status,404);
}));
test('a failed build leaves source and previous preview intact; infeasible drafts can still be saved',()=>fixture(async({ws,base})=>{
  const before=(await(await fetch(base+'/api/project')).json()).project,source=await readFile(join(ws,'flight/project.json'),'utf8'),preview=await readFile(join(ws,'flight/index.html'),'utf8'),app=await readFile(join(ws,'studio/app.js'),'utf8');
  const put=p=>fetch(base+'/api/project',{method:'PUT',headers:{origin:base,'content-type':'application/json','if-match':before.revision},body:JSON.stringify(p)});
  await writeFile(join(ws,'studio/app.js'),'this is invalid JavaScript !');const bad=await put({...before,title:'Should not save'});assert.equal(bad.status,400);assert.equal(await readFile(join(ws,'flight/project.json'),'utf8'),source);assert.equal(await readFile(join(ws,'flight/index.html'),'utf8'),preview);
  await writeFile(join(ws,'studio/app.js'),app);const p=structuredClone(before);p.home=[-100,-100];assert.equal((await put(p)).status,200,'infeasible planning geometry remains editable and saveable');
}));
test('native picker opens only an explicitly selected visible home project',()=>fixture(async({ws,home,base})=>{
  const project=(await(await fetch(base+'/api/project')).json()).project,chosen=join(home,'Downloads','A survey.vector.json');await writeFile(chosen,JSON.stringify(project));
  const files=(await(await fetch(base+'/api/files')).json()).files;assert.equal(files.length,1);assert.equal(files[0].name,'A survey.vector.json');
  const open=path=>fetch(base+'/api/open',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({path})});
  assert.equal((await open('"~/Downloads/A survey.vector.json"')).status,200);
  const secret=join(home,'.hidden');await mkdir(secret);await writeFile(join(secret,'private.vector.json'),JSON.stringify(project));assert.equal((await open(join(secret,'private.vector.json'))).status,400);
  await writeFile(join(ws,'outside.vector.json'),JSON.stringify(project));await symlink(join(ws,'outside.vector.json'),join(home,'Downloads','link.vector.json'));assert.equal((await open(join(home,'Downloads','link.vector.json'))).status,400);
  assert.equal(JSON.parse(await readFile(join(ws,'flight/project.json'))).title,'Alder Orchard','opening a file does not save over the workspace');
}));
