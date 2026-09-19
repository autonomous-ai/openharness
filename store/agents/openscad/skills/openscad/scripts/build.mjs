import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSTL } from './mesh.mjs';
export async function findExecutable(candidates){
  for(const candidate of candidates.filter(Boolean))for(const file of candidate.includes('/')?[candidate]:(process.env.PATH||'').split(delimiter).map(dir=>join(dir,candidate))){
    try{await access(file,constants.X_OK);return file;}catch{}
  }
  throw new Error('OpenSCAD not found. Set OPENSCAD_BIN or run harness dsh doctor autonomous/openscad.');
}
export async function build(workspace,{bin}={}){
  const state=join(workspace,'.harness');await mkdir(state,{recursive:true});
  const atomic=async(path,value)=>{const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,value);await rename(temporary,path);};
  const verdict=value=>atomic(join(state,'verdict.json'),JSON.stringify({spec:1,...value,updatedAt:new Date().toISOString()},null,2)+'\n');
  let temporary;
  try{
    await verdict({ready:false,summary:'Rendering and inspecting the mesh',findings:[],artifact:null});
    const executable=bin||await findExecutable([process.env.OPENSCAD_BIN,process.env.OPENSCAD_TOOLCHAIN&&join(process.env.OPENSCAD_TOOLCHAIN,'openscad-cli'),'openscad','/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD']);
    await access(join(workspace,'model.scad'));
    temporary=await mkdtemp(join(state,'openscad-'));
    const result=spawnSync(executable,['-o',join(temporary,'part.stl'),join(workspace,'model.scad')],{cwd:workspace,encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
    await atomic(join(state,'build.log'),(result.stdout||'')+(result.stderr||''));
    if(result.error||result.status!==0)throw new Error('OpenSCAD failed: '+(result.error?.message||'exit '+result.status)+'. See .harness/build.log.');
    const mesh=await readFile(join(temporary,'part.stl')),report=inspectSTL(mesh);
    if(!report.watertight||report.volumeMM3<=0)throw new Error('Mesh inspection failed: '+report.nonManifoldEdges+' open/non-manifold edges and '+report.degenerateTriangles+' degenerate triangles.');
    await atomic(join(workspace,'part.stl'),mesh);await atomic(join(state,'mesh.json'),JSON.stringify(report,null,2)+'\n');
    await verdict({ready:true,summary:report.triangles.toLocaleString()+' triangles · closed mesh · '+report.bounds.size.map(n=>n.toFixed(1)).join(' × ')+' mm',findings:[{severity:'info',kind:'manufacturing',message:'Closed-mesh checks do not certify wall thickness, strength, overhangs or fit. Review for the intended printer and material.'}],artifact:'part.stl'});
    return report;
  }catch(error){await verdict({ready:false,summary:'OpenSCAD build failed',findings:[{severity:'error',kind:'build',message:error.message}],artifact:null});throw error;}
  finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await build(resolve(process.env.HARNESS_WORKSPACE||process.cwd()));console.log('Verified part.stl: '+report.triangles+' triangles, '+report.volumeMM3.toFixed(1)+' mm³');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
