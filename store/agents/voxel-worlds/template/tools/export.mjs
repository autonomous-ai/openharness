#!/usr/bin/env node
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProject,buildWorld} from './build.mjs';
import {exportGLB,exportVOX} from '../studio/formats.mjs';
import {navigationReport} from '../studio/project.mjs';
import {zipFiles} from '../studio/archive.mjs';
export async function exportWorld(workspace,output=join(workspace,'delivery')){
  await buildWorld(workspace);const p=await readProject(workspace),html=await readFile(join(workspace,'world/index.html'),'utf8'),files=[[p.id+'.tidelands.json',JSON.stringify(p,null,2)],[p.id+'.glb',exportGLB(p)],[p.id+'.vox',exportVOX(p)],['studio.html',html],['walkthrough.html',html.replace(/(<script id="world-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify({project:p,mode:'walk'}).replace(/</g,'\\u003c')+b)],['walking-check.json',JSON.stringify(navigationReport(p),null,2)],['README.md',`# ${p.title}\n\n${p.brief}\n\nOpen studio.html to edit or walkthrough.html to explore offline. GLB preserves named visible meshes, Y up, meters. VOX flattens the world into a single voxel model and palette, Z up. Keep the .tidelands.json source for all objects, settings, materials and destinations.\n\nOne voxel = ${p.unit} meters. A 1.7 m visitor is simulated. Route checks are finite geometry checks; walk the actual result. No game rules or physical construction validation is implied.\n\n${p.notes}\n`]];
  await mkdir(output,{recursive:true});for(const [name,body]of files)await writeFile(join(output,name),body);await writeFile(join(output,p.id+'-world-kit.zip'),new Uint8Array(await zipFiles(files).arrayBuffer()));return {title:p.title,output,files:files.map(([name])=>name)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');console.log(JSON.stringify(await exportWorld(root,process.argv[2]?resolve(process.argv[2]):undefined)));}
