#!/usr/bin/env node
import {readFile,writeFile,mkdir,realpath,access} from 'node:fs/promises';
import {resolve,join,sep,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validateProject,compileWorld,meshWorld} from '../studio/project.mjs';
export async function readProject(workspace){
  const root=await realpath(workspace),source=await realpath(join(root,'world/project.json'));
  if(!source.startsWith(root+sep)||!source.startsWith(join(root,'world')+sep))throw new Error('Keep the project source inside world/.');
  const project=validateProject(JSON.parse(await readFile(source,'utf8')));delete project.revision;return project;
}
export async function toolsDirectory(){
  const candidates=[process.env.VOXEL_DSH_DIR&&join(process.env.VOXEL_DSH_DIR,'toolchain'),fileURLToPath(new URL('../../toolchain/',import.meta.url))].filter(Boolean);
  for(const path of candidates){try{await access(join(path,'node_modules/esbuild/lib/main.js'));return path;}catch{}}
  throw new Error('Voxel Worlds build tools are missing. Run its setup script, then use VOXEL_DSH_DIR for an installed workspace.');
}
export async function buildWorld(workspace,{check=false}={}){
  const root=resolve(workspace);if(!check){await mkdir(join(root,'.harness'),{recursive:true});await writeFile(join(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'world/index.html',summary:'Building the editable world; browser review pending'}));}
  const project=await readProject(root),world=compileWorld(project);meshWorld(project,world);project.revision=createHash('sha256').update(JSON.stringify(project)).digest('hex');
  const tools=await toolsDirectory(),{build}=await import(pathToFileURL(join(tools,'node_modules/esbuild/lib/main.js')).href);
  const bundle=await build({entryPoints:[join(root,'studio/app.js')],bundle:true,write:false,format:'iife',minify:true,target:'es2022',legalComments:'eof',nodePaths:[join(tools,'node_modules')]});
  const [shell,css,icon]=await Promise.all(['shell.html','style.css','icon.svg'].map(n=>readFile(join(root,'studio',n),'utf8')));
  const html=shell.replace('/* STUDIO_CSS */',()=>css).replace('<!-- WORLD_ICON -->',()=>icon).replace('<!-- FAVICON -->',()=>`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`).replace('WORLD_DATA',()=>JSON.stringify({project,mode:'edit'}).replace(/</g,'\\u003c')).replace('/* WORLD_APP */',()=>bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script'));
  const target=join(root,'world/index.html');if(check){if(await readFile(target,'utf8')!==html)throw new Error('World preview is stale. Run node tools/build.mjs.');}else{await writeFile(target,html);await writeFile(join(root,'.harness/verdict.json'),JSON.stringify({spec:1,ready:false,artifact:'world/index.html',summary:project.title+' · editable world built; walking and export review pending',findings:[{severity:'info',kind:'review_pending',message:'A build does not establish usability or visual quality. Walk the actual world and reopen the exported geometry.'}]},null,2)+'\n');}
  return {title:project.title,revision:project.revision,objects:project.objects.length,voxels:world.count};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildWorld(resolve(dirname(fileURLToPath(import.meta.url)),'..'),{check:process.argv.includes('--check')})));
