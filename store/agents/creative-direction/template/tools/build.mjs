#!/usr/bin/env node
import { readFile,writeFile,mkdir,realpath } from 'node:fs/promises';
import { resolve,extname,sep,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateProject } from '../studio/project.mjs';
export async function readProject(workspace) {
  const root=await realpath(workspace),base=await realpath(resolve(root,'board'));
  if(!base.startsWith(root+sep))throw new Error('The board folder must stay inside the workspace.');
  const source=await realpath(resolve(base,'project.json'));
  if(!source.startsWith(base+sep))throw new Error('The project file must stay inside board/.');
  const project=JSON.parse(await readFile(source,'utf8'));
  async function local(file){const path=await realpath(resolve(base,file));if(!path.startsWith(base+sep))throw new Error(`Keep assets inside board/: ${file}`);return path;}
  for(const a of project.assets??[]){
    if(!a.file)continue;
    const path=await local(a.file),mime={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(path).toLowerCase()];
    if(!mime)throw new Error(`Unsupported image: ${a.file}`);
    const data=await readFile(path);if(data.length>10000000)throw new Error('Use images smaller than 10 MB.');
    if(mime==='image/svg+xml'&&/<(?:script|foreignObject)\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|javascript:|\/\/)/i.test(data.toString()))throw new Error('Use a self-contained SVG without scripts or remote resources.');
    a.data=`data:${mime};base64,${data.toString('base64')}`;delete a.file;
  }
  for(const f of project.fonts??[]){
    if(f.file){const path=await local(f.file),type=extname(path).slice(1);if(!['ttf','otf','woff','woff2'].includes(type))throw new Error('Unsupported font format.');const bytes=await readFile(path);if(bytes.length>8000000)throw new Error('Font exceeds 8 MB.');f.data=`data:font/${type};base64,${bytes.toString('base64')}`;delete f.file;}
    if(f.licenseFile){f.license=await readFile(await local(f.licenseFile),'utf8');delete f.licenseFile;}
  }
  if(project.website?.file){project.website.html=await readFile(await local(project.website.file),'utf8');delete project.website.file;}
  return validateProject(project);
}
export async function buildBrand(workspace,{check=false}={}){
  const root=resolve(workspace),read=name=>readFile(resolve(root,name),'utf8');
  if(!check){await mkdir(resolve(root,'.harness'),{recursive:true});await writeFile(resolve(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'board/index.html',summary:'Building brand project · review pending'}));}
  const project=await readProject(root);delete project.revision;
  project.revision=createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const [shell,css,model,archive,app,icon]=await Promise.all(['shell.html','style.css','project.mjs','archive.mjs','app.js','icon.svg'].map(n=>read('studio/'+n)));
  const js=source=>source.replace(/^export /gm,'').replace(/<\/script/gi,'<\\/script');
  const html=shell.replace('/* STUDIO_CSS */',()=>css).replace('/* BRAND_MODEL */',()=>js(model+'\n'+archive)).replace('/* STUDIO_APP */',()=>js(app)).replace('"BRAND_DATA"',()=>JSON.stringify(project).replace(/</g,'\\u003c')).replace('<!-- BRAND_ICON -->',()=>icon).replace('<!-- FAVICON -->',()=>`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`);
  const out=resolve(root,'board/index.html');
  if(check){if(await readFile(out,'utf8')!==html)throw new Error('Preview is stale. Run node tools/build.mjs.');}
  else {await writeFile(out,html);await writeFile(resolve(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'board/index.html',summary:`${project.title} · review the actual brand and exported files`,findings:[{severity:'info',kind:'review_pending',message:'A successful build does not establish visual quality or readiness to launch.'}]},null,2)+'\n');}
  return {title:project.title,revision:project.revision,directions:project.directions.length,boards:project.directions.reduce((n,d)=>n+d.boards.length,0)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildBrand(resolve(dirname(fileURLToPath(import.meta.url)),'..'),{check:process.argv.includes('--check')})));
