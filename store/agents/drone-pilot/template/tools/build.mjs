#!/usr/bin/env node
import {readFile,writeFile,mkdir,realpath,access} from 'node:fs/promises';
import {resolve,join,sep,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validateProject} from '../studio/project.mjs';
import {verifyFlightSource} from '../studio/log.mjs';
export async function readProject(workspace){
  const root=await realpath(workspace),source=await realpath(join(root,'flight/project.json'));
  if(!source.startsWith(root+sep)||!source.startsWith(join(root,'flight')+sep))throw new Error('Keep project source inside flight/.');
  const project=validateProject(JSON.parse(await readFile(source,'utf8')));delete project.revision;await verifyFlightSource(project);return project;
}
export async function toolsDirectory(){
  const candidates=[process.env.DRONE_DSH_DIR&&join(process.env.DRONE_DSH_DIR,'toolchain'),fileURLToPath(new URL('../../toolchain/',import.meta.url))].filter(Boolean);
  for(const path of candidates){try{await access(join(path,'node_modules/esbuild/lib/main.js'));return path;}catch{}}
  throw new Error('Vector build tools are missing. Run Drone Pilot setup, then use DRONE_DSH_DIR for an installed workspace.');
}
export async function buildFlight(workspace,{check=false,project:provided}={}){
  const root=resolve(workspace),project=provided?validateProject(provided):await readProject(root);delete project.revision;await verifyFlightSource(project);project.revision=createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const tools=await toolsDirectory(),{build}=await import(pathToFileURL(join(tools,'node_modules/esbuild/lib/main.js')).href);
  const bundle=await build({entryPoints:[join(root,'studio/app.js')],bundle:true,write:false,format:'iife',minify:true,target:'es2022',legalComments:'eof',nodePaths:[join(tools,'node_modules')]});
  const [shell,css,icon,boost,jsbn]=await Promise.all(['shell.html','style.css','icon.svg','vendor/LICENSE-BOOST.txt','vendor/LICENSE-JSBN.txt'].map(n=>readFile(join(root,'studio',n),'utf8')));
  const licenses='Clipper 6.4.2 / JavaScript port 6.4.2.2\nCopyright Angus Johnson 2010–2017; Timo Kähkönen 2012–2017.\nUnmodified clipper-lib 6.4.2 from https://github.com/junmer/clipper-lib\n\n'+boost+'\n\nJSBN subset within Clipper:\n'+jsbn;
  const html=shell.replace('/* STUDIO_CSS */',()=>css).replace('<!-- VECTOR_ICON -->',()=>icon).replace('<!-- FAVICON -->',()=>`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`).replace('VECTOR_DATA',()=>JSON.stringify({project,licenses}).replace(/</g,'\\u003c')).replace('/* VECTOR_APP */',()=>bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
  if(provided)return {html,project};
  const target=join(root,'flight/index.html');
  if(check){if(await readFile(target,'utf8')!==html)throw new Error('Flight studio is stale. Run node tools/build.mjs.');}
  else{await writeFile(target,html);await mkdir(join(root,'.harness'),{recursive:true});await writeFile(join(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'flight/index.html',summary:project.title+' · editable survey built; geometry, browser and delivery review pending',findings:[{severity:'info',kind:'review_pending',message:'A build does not establish a usable survey or verified flight. Review the actual inputs, outputs and model limitations.'}]},null,2)+'\n');}
  return {title:project.title,revision:project.revision,areas:project.areas.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildFlight(resolve(dirname(fileURLToPath(import.meta.url)),'..'),{check:process.argv.includes('--check')})));
