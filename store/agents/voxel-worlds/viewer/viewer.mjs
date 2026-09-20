// Local workspace bridge: explicit project saves, optimistic revision checks, recoverable history.
import { createServer } from 'node:http';
import { readFile,writeFile,mkdir,rename,realpath,readdir,stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve,join,dirname,basename,relative,sep,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { readProject,buildWorld } from '../template/tools/build.mjs';
import { validateProject,meshWorld } from '../template/studio/project.mjs';
const hash=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
export async function createWorldViewer(workspace,{home=homedir()}={}){
  const root=await realpath(workspace),homeRoot=await realpath(home);let saving=false;
  async function current(){const project=await readProject(root);delete project.revision;project.revision=hash(project);return project;}
  async function picked(raw){
    let name=String(raw??'').trim();if((name.startsWith('"')&&name.endsWith('"'))||(name.startsWith("'")&&name.endsWith("'")))name=name.slice(1,-1);
    if(name.startsWith('file://'))name=fileURLToPath(name);else name=name.replace(/\\ /g,' ');
    if(name==='~')name=homeRoot;else if(name.startsWith('~/'))name=join(homeRoot,name.slice(2));
    const actual=await realpath(resolve(name)),rel=relative(homeRoot,actual);
    if(rel.startsWith('..')||rel.split(sep).some(s=>s.startsWith('.')||s==='Library')||!actual.startsWith(homeRoot+sep))throw new Error('Choose a project inside your home folder, outside hidden folders and Library.');
    if(!actual.toLowerCase().endsWith('.tidelands.json'))throw new Error('Choose a saved .tidelands.json project.');
    const info=await stat(actual);if(!info.isFile()||info.size>12000000)throw new Error('Choose a project file smaller than 12 MB.');
    return validateProject(JSON.parse(await readFile(actual,'utf8')));
  }
  async function recent(){
    const files=[];
    for(const folder of ['Downloads','Desktop','Documents']){
      const path=join(homeRoot,folder);let list=[];try{list=await readdir(path,{withFileTypes:true});}catch{continue;}
      for(const entry of list.slice(0,3000)){if(!entry.isFile()||entry.name.startsWith('.')||!entry.name.toLowerCase().endsWith('.tidelands.json'))continue;const file=join(path,entry.name),info=await stat(file).catch(()=>null);if(info&&info.size<=12000000)files.push({name:entry.name,path:file,folder:'~/'+folder,mtime:info.mtimeMs});}
    }return files.sort((a,b)=>b.mtime-a.mtime).slice(0,30);
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    const send=(code,body,type='application/json')=>{res.writeHead(code,{'content-type':type});res.end(type==='application/json'?JSON.stringify(body):body);};
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host??''))return send(403,{error:'Loopback only.'});
    const origin='http://'+req.headers.host;
    if((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Same-origin requests only.'});
    let path;try{path=decodeURIComponent(new URL(req.url,origin).pathname);}catch{return send(400,{error:'Invalid path.'});}
    const mutation=['PUT','POST'].includes(req.method);
    if(mutation&&(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')))return send(403,{error:'Use the local studio to save or open a project.'});
    async function body(){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12000000)throw new Error('Request exceeds 12 MB.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));}
    try{
      if(path==='/api/project'&&req.method==='GET')return send(200,{project:await current()});
      if(path==='/api/project'&&req.method==='PUT'){
        if(saving)return send(409,{project:await current(),error:'Another save is in progress.'});
        const project=validateProject(await body());meshWorld(project);delete project.revision;saving=true;
        try{
          const before=await current();if(req.headers['if-match']!==before.revision)return send(409,{project:before,error:'The source changed. Keep both versions until you choose.'});
          const history=join(root,'.harness/history');await mkdir(history,{recursive:true});
          await writeFile(join(history,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.tidelands.json'),JSON.stringify(before));
          const target=join(root,'world/project.json'),temporary=target+'.'+randomUUID()+'.tmp';
          await writeFile(temporary,JSON.stringify(project,null,2)+'\n');await rename(temporary,target);await buildWorld(root);
          return send(200,{project:await current()});
        }finally{saving=false;}
      }
      if(path==='/api/files'&&req.method==='GET')return send(200,{files:await recent()});
      if(path==='/api/open'&&req.method==='POST')return send(200,{project:await picked((await body()).path)});
      if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'Method not allowed.'});
      if(path==='/'){const html=await readFile(join(root,'world/index.html'));return send(200,req.method==='HEAD'?'':html,'text/html; charset=utf-8');}
      if(!path.startsWith('/files/'))return send(404,{error:'Not found.'});
      const name=path.slice(7);if(name.split(/[\\/]/).some(s=>s.startsWith('.')||s==='node_modules'))return send(404,{error:'Not found.'});
      const file=await realpath(join(root,name));if(!file.startsWith(root+sep)||relative(root,file).split(sep).some(s=>s.startsWith('.')))return send(404,{error:'Not found.'});
      const info=await stat(file);if(!info.isFile()||info.size>48000000)return send(413,{error:'File unavailable or too large.'});
      const mime={'.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.pdf':'application/pdf','.json':'application/json','.ttf':'font/ttf'}[extname(file)]??'application/octet-stream';
      return send(200,req.method==='HEAD'?'':await readFile(file),mime==='application/json'?'application/json; charset=utf-8':mime);
    }catch(error){return send(400,{error:error.code==='ENOENT'?'That file is not available.':error.message});}
  });
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.env.HARNESS_WORKSPACE)throw new Error('HARNESS_WORKSPACE is required.');
  const port=Number(process.env.HARNESS_VIEWER_PORT);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('HARNESS_VIEWER_PORT must be valid.');
  const server=await createWorldViewer(process.env.HARNESS_WORKSPACE);server.listen(port,'127.0.0.1',()=>console.log(`[tidelands] http://127.0.0.1:${port}/`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close();});
}
