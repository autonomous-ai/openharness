import {mkdtemp,cp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {harbor,courtyard,dungeon} from './fixtures.mjs';
import {exportWorld} from '../template/tools/export.mjs';
import {exportGLB} from '../template/studio/formats.mjs';
import {compileWorld,navigationReport} from '../template/studio/project.mjs';
import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {GLTFLoader} from '../toolchain/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import {VOXLoader} from '../toolchain/node_modules/three/examples/jsm/loaders/VOXLoader.js';
import {Box3,Vector3} from '../toolchain/node_modules/three/build/three.module.js';
import {build} from '../toolchain/node_modules/esbuild/lib/main.js';
import {browserPath} from '../toolchain/browser.mjs';
import validator from '../toolchain/node_modules/gltf-validator/index.js';
const packageRoot=fileURLToPath(new URL('../',import.meta.url)),root=process.env.VOXEL_ACCEPTANCE_ROOT||await mkdtemp(join(tmpdir(),'tidelands-acceptance-'));await mkdir(root,{recursive:true});process.env.VOXEL_DSH_DIR=packageRoot;
const browser=await chromium.launch({executablePath:await browserPath(),headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:960}}),report=[];
const arrayBuffer=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),digest=b=>createHash('sha256').update(b).digest('hex');
const cases=[{make:harbor,target:'boat',approved:'bakery',revision:'Move the skiff east; retain the approved bakery.',edit:o=>{o.origin[0]+=2;}},{make:courtyard,target:'canopy',approved:'pavilion',revision:'Raise the reading canopy by 1.2 m, keeping the pavilion unchanged.',edit:o=>{o.size[1]+=3;o.boxes[0][1]+=3;for(const b of o.boxes.slice(1))b[4]+=3;}},{make:dungeon,target:'west-wing',approved:'east-wing',revision:'Widen the west passage entrance while preserving the east treasury.',edit:o=>{o.boxes[4][0]-=1;o.boxes[4][3]+=2;}}];
try{
  for(const item of cases){
    const workspace=join(root,item.make().id);await cp(join(packageRoot,'template'),workspace,{recursive:true});let project=item.make();const approved=JSON.stringify(project.objects.find(o=>o.id===item.approved)),assetHash=digest(exportGLB(project,{objectId:item.approved}));
    for(const phase of ['before','after']){
      if(phase==='after')item.edit(project.objects.find(o=>o.id===item.target));await writeFile(join(workspace,'world/project.json'),JSON.stringify(project,null,2)+'\n');const delivery=join(workspace,phase);await exportWorld(workspace,delivery);assert.deepEqual(navigationReport(project).issues,[]);
      const glb=await readFile(join(delivery,project.id+'.glb')),vox=await readFile(join(delivery,project.id+'.vox')),validation=await validator.validateBytes(new Uint8Array(glb),{});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages));
      const parsed=await new GLTFLoader().parseAsync(arrayBuffer(glb),''),names=parsed.scene.children.map(n=>n.userData.objectId);assert.deepEqual(names.sort(),project.objects.filter(o=>!o.hidden).map(o=>o.id).sort());
      const bounds=new Box3().setFromObject(parsed.scene),size=bounds.getSize(new Vector3()).toArray();assert.ok(size[0]<=project.size[0]*project.unit+.0001);assert.ok(size[1]<=project.size[1]*project.unit+.0001);assert.ok(size[2]<=project.size[2]*project.unit+.0001);
      const supplied=new VOXLoader().parse(arrayBuffer(vox));assert.equal(supplied.chunks.length,1);assert.deepEqual(supplied.chunks[0].size,{x:project.size[0],y:project.size[2],z:project.size[1]});assert.equal(supplied.chunks[0].data.length/4,compileWorld(project).count);
      assert.equal(JSON.stringify(project.objects.find(o=>o.id===item.approved)),approved);assert.equal(digest(exportGLB(project,{objectId:item.approved})),assetHash);
      await page.goto(pathToFileURL(join(delivery,'studio.html')).href);await page.waitForFunction(()=>window.tidelands);await page.waitForTimeout(600);await page.screenshot({path:join(delivery,'studio.png')});
      const script=`import * as T from 'three';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';const bytes=Uint8Array.from(atob(${JSON.stringify(glb.toString('base64'))}),c=>c.charCodeAt(0));const result=await new GLTFLoader().parseAsync(bytes.buffer,'');const scene=new T.Scene();scene.background=new T.Color('#e6e8df');scene.add(result.scene);const box=new T.Box3().setFromObject(result.scene),center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3()),span=Math.max(...size.toArray()),camera=new T.PerspectiveCamera(42,innerWidth/innerHeight,.01,1000);camera.position.copy(center).add(new T.Vector3(span,span*.8,span*1.2));camera.lookAt(center);scene.add(new T.HemisphereLight('#ffffff','#757b73',2));const sun=new T.DirectionalLight('#ffe8ca',3);sun.position.set(span,span*2,span);scene.add(sun);const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);document.body.append(renderer.domElement);renderer.render(scene,camera);window.imported={objects:result.scene.children.length,bounds:size.toArray()};`;
      const built=await build({stdin:{contents:script,resolveDir:join(packageRoot,'toolchain')},bundle:true,write:false,format:'esm',minify:true,target:'es2022'});const imported=join(delivery,'independent-glb-preview.html');await writeFile(imported,'<!doctype html><meta charset="utf-8"><title>Independent GLB import</title><style>body{margin:0;overflow:hidden}</style><script type="module">'+built.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')+'</script>');await page.goto(pathToFileURL(imported).href);await page.waitForFunction(()=>window.imported);await page.screenshot({path:join(delivery,'independent-glb.png')});
      report.push({id:project.id,phase,brief:project.brief,revision:item.revision,delivery,glbErrors:validation.issues.numErrors,glbWarnings:validation.issues.numWarnings,independentlyImportedObjects:names.length,physicalBoundsMeters:size,voxCells:supplied.chunks[0].data.length/4,approvedAsset:item.approved,approvedAssetSHA256:assetHash,navigation:navigationReport(project)});
    }
  }
  await writeFile(join(root,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,cases:report.length,report:join(root,'acceptance.json')}));
}finally{await browser.close();}
