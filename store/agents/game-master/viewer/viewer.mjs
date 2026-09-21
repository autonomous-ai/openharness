// Local workspace bridge: explicit project saves, optimistic revision checks, recoverable history.
import { createServer } from 'node:http';
import { readFile,writeFile,mkdir,rename,realpath,stat } from 'node:fs/promises';
import { resolve,join,relative,sep,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readProject,buildGame } from '../template/tools/build.mjs';
import { validateProject,digest } from '../template/studio/project.mjs';
export async function createGameViewer(workspace){
  const root=await realpath(workspace);let saving=false;
  async function current(){const project=await readProject(root);delete project.revision;project.revision=await digest(project);return project;}
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    const send=(code,body,type='application/json')=>{res.writeHead(code,{'content-type':type});res.end(type==='application/json'?JSON.stringify(body):body);};
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host??''))return send(403,{error:'Loopback only.'});
    const origin='http://'+req.headers.host;
    if((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Same-origin requests only.'});
    let path;try{path=decodeURIComponent(new URL(req.url,origin).pathname);}catch{return send(400,{error:'Invalid path.'});}
    const mutation=['PUT','POST'].includes(req.method);
    if(mutation&&(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')))return send(403,{error:'Use the local studio to save or open a project.'});
    async function body(){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>3000000)throw new Error('Request exceeds 3 MB.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));}
    try{
      if(path==='/api/project'&&req.method==='GET')return saving?send(503,{error:'Source save in progress.'}):send(200,{project:await current()});
      if(path==='/api/project'&&req.method==='PUT'){
        if(saving)return send(409,{project:await current(),error:'Another save is in progress.'});
        const project=validateProject(await body());delete project.revision;saving=true;
        try{
          const before=await current();if(req.headers['if-match']!==before.revision)return send(409,{project:before,error:'The source changed. Keep both versions until you choose.'});
          const built=await buildGame(root,{project});
          const latest=await current();if(latest.revision!==before.revision)return send(409,{project:latest,error:'The source changed during the build. Keep both versions until you choose.'});
          const history=join(root,'.harness/history');await mkdir(history,{recursive:true});
          await writeFile(join(history,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.relay.json'),JSON.stringify(before));
          const target=join(root,'game/project.json'),temporary=target+'.'+randomUUID()+'.tmp';
          const source={...project};delete source.rules;delete source.revision;
          await writeFile(temporary,JSON.stringify(source,null,2)+'\n');
          const ruleTarget=join(root,'game/rules.mjs'),ruleTemporary=ruleTarget+'.'+randomUUID()+'.tmp';await writeFile(ruleTemporary,project.rules);
          const preview=join(root,'game/index.html'),previewTemporary=preview+'.'+randomUUID()+'.tmp';await writeFile(previewTemporary,built.html);
          await rename(ruleTemporary,ruleTarget);await rename(temporary,target);await rename(previewTemporary,preview);
          await writeFile(join(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'game/index.html',summary:'Source saved; playtest and physical delivery review pending'}));
          return send(200,{project:await current()});
        }finally{saving=false;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'Method not allowed.'});
      if(path==='/'){const html=await readFile(join(root,'game/index.html'));return send(200,req.method==='HEAD'?'':html,'text/html; charset=utf-8');}
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
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  if(!process.env.HARNESS_WORKSPACE)throw new Error('HARNESS_WORKSPACE is required.');
  const port=Number(process.env.HARNESS_VIEWER_PORT);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('HARNESS_VIEWER_PORT must be valid.');
  const server=await createGameViewer(process.env.HARNESS_WORKSPACE);server.listen(port,'127.0.0.1',()=>console.log(`[relay] http://127.0.0.1:${port}/`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close();});
}
