#!/usr/bin/env node
import {readFile,writeFile,mkdir,realpath,access} from 'node:fs/promises';
import {resolve,join,sep,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateProject,digest} from '../studio/project.mjs';
export async function readProject(workspace){const root=await realpath(workspace);const files=await Promise.all(['project.json','rules.mjs'].map(async n=>{const f=await realpath(join(root,'game',n));if(!f.startsWith(join(root,'game')+sep))throw new Error('Keep source inside game/.');return readFile(f,'utf8');}));return validateProject({...JSON.parse(files[0]),rules:files[1]});}
export async function toolsDirectory(){for(const path of [process.env.GAME_DSH_DIR&&join(process.env.GAME_DSH_DIR,'toolchain'),fileURLToPath(new URL('../../toolchain/',import.meta.url))].filter(Boolean)){try{await access(join(path,'node_modules/esbuild/lib/main.js'));return path;}catch{}}throw new Error('Run Game Master setup. Set GAME_DSH_DIR when building an installed workspace.');}
export async function buildGame(workspace,{check=false,project:provided}={}){
 const root=resolve(workspace),project=provided?validateProject(provided):await readProject(root);project.revision=await digest(project);
 const tools=await toolsDirectory(),{build}=await import(pathToFileURL(join(tools,'node_modules/esbuild/lib/main.js')).href);
 await build({logLevel:'silent',stdin:{contents:project.rules,sourcefile:'rules.mjs',loader:'js'},bundle:true,write:false,format:'esm',plugins:[{name:'offline-rules',setup(b){b.onResolve({filter:/.*/},()=>({errors:[{text:'Rules must be self-contained: imports are not supported.'}]}));}}]});
 const worker=await build({entryPoints:[join(root,'studio/worker.js')],bundle:true,write:false,format:'iife',minify:true,target:'es2022'});
 const app=await build({entryPoints:[join(root,'studio/app.js')],bundle:true,write:false,format:'iife',minify:true,target:'es2022'});
 const [shell,css,icon]=await Promise.all(['shell.html','style.css','icon.svg'].map(n=>readFile(join(root,'studio',n),'utf8')));
 const html=shell.replace('/* STUDIO_CSS */',()=>css).replace('<!-- RELAY_ICON -->',()=>icon).replace('<!-- FAVICON -->',()=>`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`).replace('RELAY_DATA',()=>JSON.stringify({project,worker:worker.outputFiles[0].text}).replace(/</g,'\\u003c')).replace('/* RELAY_APP */',()=>app.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
 if(provided)return{html,project};const target=join(root,'game/index.html');if(check){if(await readFile(target,'utf8')!==html)throw new Error('Game studio is stale. Run node tools/build.mjs.');}else{await writeFile(target,html);await mkdir(join(root,'.harness'),{recursive:true});await writeFile(join(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'game/index.html',summary:project.title+' built; actual play and physical delivery review pending'})+'\n');}return{title:project.title,revision:project.revision};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildGame(resolve(dirname(fileURLToPath(import.meta.url)),'..'),{check:process.argv.includes('--check')})));
