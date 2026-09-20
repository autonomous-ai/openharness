import test from 'node:test';
import assert from 'node:assert/strict';
import {harbor,courtyard,dungeon} from './fixtures.mjs';
import {validateProject,compileWorld,cellAt,meshWorld,localToWorld,worldToLocal,paintCells,objectCells,moveVisitor,fitsVisitor,navigationReport,clone} from '../template/studio/project.mjs';
import {exportGLB,exportVOX,importVOX,addImportedAsset} from '../template/studio/formats.mjs';
import validator from '../toolchain/node_modules/gltf-validator/index.js';
test('three authored briefs have clear starts, reachable destinations and valid standard 3D exports',async()=>{
  for(const p of [harbor(),courtyard(),dungeon()]){
    assert.deepEqual(navigationReport(p).issues,[],p.title);
    const result=await validator.validateBytes(exportGLB(p),{maxIssues:20});assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues.messages));
    const glb=exportGLB(p),v=new DataView(glb.buffer),json=JSON.parse(new TextDecoder().decode(glb.slice(20,20+v.getUint32(12,true))));assert.equal(json.nodes.length,p.objects.filter(o=>!o.hidden).length);
    assert.equal(json.extras.voxelSizeMeters,p.unit);assert.equal(json.nodes.find(n=>n.name===p.objects.at(-1).name).extras.objectId,p.objects.at(-1).id);
    const round=importVOX(exportVOX(p)),world=compileWorld(p);assert.deepEqual(round.size,world.size);assert.deepEqual(round.cells,world.cells);assert.equal(round.materials.find(m=>m.id===1).color,p.materials[0].color);
  }
});
test('asymmetric assets rotate with a reversible coordinate mapping, retain unrelated objects and export alone',async()=>{
  const p=harbor(),id='boat',o=p.objects.find(o=>o.id===id),before=JSON.stringify(p.objects.filter(o=>o.id!==id));
  for(let r=0;r<4;r++){o.rotation=r;for(const point of [[0,0,0],[2,1,8],[5,3,14]])assert.deepEqual(worldToLocal(o,...localToWorld(o,...point)),point);}
  o.rotation=1;const at=localToWorld(o,2,1,8);paintCells(p,id,at,8);assert.equal(cellAt(compileWorld(p),...at),8);assert.equal(o.rotation,0);assert.equal(JSON.stringify(p.objects.filter(o=>o.id!==id)),before);
  const round=importVOX(exportVOX(p,{objectId:id}));assert.deepEqual(round.size,o.size);assert.deepEqual(round.cells,objectCells(o));
  const valid=await validator.validateBytes(exportGLB(p,{objectId:id}),{});assert.equal(valid.issues.numErrors,0);
});
test('source import preserves palette and geometry and rejects truncated data and oversized objects',()=>{
  const p=harbor(),vox=exportVOX(p,{objectId:'boat'}),asset=importVOX(vox),insert=addImportedAsset(p,asset,{origin:[65,4,1],name:'Supplied skiff'});
  assert.equal(insert.project.objects.at(-1).name,'Supplied skiff');assert.equal(insert.project.materials.length,p.materials.length);
  assert.throws(()=>importVOX(vox.slice(0,-1)),/Truncated/);assert.throws(()=>addImportedAsset(p,asset,{origin:[79,0,0]}),/outside/);
  const transformed=new Uint8Array(vox.length+12);transformed.set(vox);transformed.set(new TextEncoder().encode('nTRN'),vox.length);new DataView(transformed.buffer).setUint32(16,transformed.length-20,true);assert.throws(()=>importVOX(transformed),/transforms/);
  const broken=clone(p);broken.objects[0].boxes[0][6]=254;assert.throws(()=>validateProject(broken),/Invalid voxel box/);
});
test('a standard VOX transform graph preserves asymmetric orientation when imported as a movable asset',()=>{
  const p=harbor(),base=exportVOX(p,{objectId:'boat'}),int=n=>{const b=Buffer.alloc(4);b.writeInt32LE(n);return b;},string=s=>Buffer.concat([int(Buffer.byteLength(s)),Buffer.from(s)]),dict=o=>Buffer.concat([int(Object.keys(o).length),...Object.entries(o).flatMap(([k,v])=>[string(k),string(v)])]),chunk=(id,body)=>Buffer.concat([Buffer.from(id),int(body.length),int(0),body]);
  const transform=chunk('nTRN',Buffer.concat([int(0),dict({_name:'Supplied skiff'}),int(1),int(-1),int(-1),int(1),dict({_r:'17',_t:'20 12 4'})]));
  const shape=chunk('nSHP',Buffer.concat([int(1),dict({}),int(1),int(0),dict({})])),bytes=Buffer.concat([base,transform,shape]);bytes.writeUInt32LE(bytes.length-20,16);
  const imported=importVOX(bytes),original=importVOX(base);assert.deepEqual(imported.size,[15,4,6]);
  for(let y=0;y<4;y++)for(let z=0;z<15;z++)for(let x=0;x<6;x++)assert.equal(imported.cells[(y*6+5-x)*15+z],original.cells[(y*15+z)*6+x]);
  assert.equal(imported.source.transforms.length,1);
});
test('sculpting expands an object without shifting existing cells and respects locks',()=>{
  const p=harbor(),o=p.objects.find(o=>o.id==='crates'),world=compileWorld(p),at=[o.origin[0]-1,o.origin[1],o.origin[2]];
  paintCells(p,o.id,at,8);assert.equal(cellAt(compileWorld(p),...at),8);assert.equal(cellAt(compileWorld(p),43,4,28),cellAt(world,43,4,28));
  assert.throws(()=>paintCells(p,'headland',[0,4,0],5),/unlocked/);paintCells(p,o.id,at,0);assert.equal(cellAt(compileWorld(p),...at),0);validateProject(p);
  const before=objectCells(o).filter(Boolean).length;paintCells(p,o.id,[42,4,28],8,2,{existingOnly:true});assert.equal(objectCells(o).filter(Boolean).length,before,'painting cannot fill empty space');
});
test('visitor travels in meters, collides with walls and lands without penetrating the ground',()=>{
  const p=harbor(),world=compileWorld(p);let visitor={position:[31.5,4,46.5],yaw:Math.PI,velocity:0,grounded:true};
  for(let i=0;i<120;i++)visitor=moveVisitor(world,visitor,{forward:1});assert.ok(Math.abs(visitor.position[2]-26.5)<.1);assert.ok(fitsVisitor(world,visitor.position));
  const north={position:[31.5,4,46.5],yaw:Math.PI,velocity:0,grounded:true};assert.ok(moveVisitor(world,north,{right:1}).position[0]>north.position[0],'D moves to camera-right when looking north');assert.ok(moveVisitor(world,{...north,yaw:0},{right:1}).position[0]<north.position[0],'D moves to camera-right when looking south');
  let jumper={position:[31.5,4,46.5],yaw:0,velocity:0,grounded:true},highest=4;
  for(let i=0;i<150;i++){jumper=moveVisitor(world,jumper,{jump:i===0});highest=Math.max(highest,jumper.position[1]);assert.ok(fitsVisitor(world,jumper.position));}
  assert.ok(highest>6);assert.ok(Math.abs(jumper.position[1]-4)<.002);assert.equal(jumper.grounded,true);
  let walker={position:[24.5,4,12.5],yaw:-Math.PI/2,velocity:0,grounded:true};for(let i=0;i<300;i++)walker=moveVisitor(world,walker,{forward:1,sprint:true});assert.ok(walker.position[0]>22);assert.ok(fitsVisitor(world,walker.position));
});
test('mesh face normals match triangle winding and buried surfaces are removed',()=>{
  const p=harbor();for(const g of meshWorld(p)){for(let f=0;f<g.indices.length;f+=6){const [a,b,c]=g.indices.slice(f,f+3).map(i=>g.positions.slice(i*3,i*3+3)),u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],normal=g.normals.slice(g.indices[f]*3,g.indices[f]*3+3);assert.ok(cross.reduce((n,v,i)=>n+v*normal[i],0)>0);}}
});
