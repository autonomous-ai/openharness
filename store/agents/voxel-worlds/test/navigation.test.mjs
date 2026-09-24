import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProject,compileWorld,navigationReport,moveVisitor,fitsVisitor} from '../template/studio/project.mjs';

function stairs(unit=.25) {
  return validateProject({
    spec:'tidelands/2',id:'stairs',title:'Quarter-meter stairs',brief:'Walk up four small risers to an upper landing.',size:[40,24,12],unit,light:.3,
    materials:[{id:1,name:'Stone',color:'#777777',solid:true,opacity:1,emission:0}],
    objects:[{id:'steps',name:'Steps',origin:[0,0,0],size:[40,8,12],rotation:0,hidden:false,locked:false,edits:[],
      boxes:[[0,0,0,40,1,12,1],...[0,1,2,3].map(i=>[12+i*3,1+i,0,28-i*3,1,12,1])]}],
    spawn:{position:[5.5,1,6.5],yaw:Math.PI/2},
    stops:[{id:'landing',name:'Upper landing',description:'The top of the stairs.',position:[30.5,5,6.5]}]
  });
}

test('routes follow the visitor footprint up and down small stairs',()=>{
  for(const unit of [.2,.25,.3]){
    const p=stairs(unit),world=compileWorld(p),report=navigationReport(p,world);
    assert.deepEqual(report.issues,[],`ascending at ${unit} m per voxel`);
    let visitor={...p.spawn,velocity:0,grounded:true};
    for(let i=0;i<Math.ceil(26*unit/3*60);i++)visitor=moveVisitor(world,visitor,{forward:1});
    assert.ok(visitor.position[0]>30 && Math.abs(visitor.position[1]-5)<.01,JSON.stringify(visitor));
    assert.ok(fitsVisitor(world,visitor.position));
    p.spawn={position:[30.5,5,6.5],yaw:-Math.PI/2};
    p.stops=[{id:'bottom',name:'Bottom of stairs',description:'The start of the stairs.',position:[5.5,1,6.5]}];
    assert.deepEqual(navigationReport(p,world).issues,[],`descending at ${unit} m per voxel`);
    visitor={...p.spawn,velocity:0,grounded:true};
    for(let i=0;i<Math.ceil(26*unit/3*60);i++)visitor=moveVisitor(world,visitor,{forward:1});
    assert.ok(visitor.position[0]<5 && Math.abs(visitor.position[1]-1)<.01,JSON.stringify(visitor));
    assert.equal(visitor.grounded,true);assert.ok(fitsVisitor(world,visitor.position));
  }
});

test('route checks still reject a high riser, a wide gap and insufficient headroom',()=>{
  const high=stairs();high.objects[0].boxes=[[0,0,0,40,1,12,1],[12,1,0,28,4,12,1]];
  const gap=stairs();gap.objects[0].boxes=[[0,0,0,12,1,12,1],[18,0,0,22,5,12,1]];
  const low=stairs();low.objects[0].boxes.push([10,7,0,18,1,12,1]);
  for(const [name,p] of [['high riser',high],['wide gap',gap],['low ceiling',low]]){
    const report=navigationReport(p);
    assert.equal(report.spawnClear,true,name);
    assert.equal(report.stops[0].reachable,false,name);
  }
});

test('a visitor can stand beside a riser with its leading edge supported by the step',()=>{
  const p=stairs();p.spawn.position=[11.5,2,6.5];
  const world=compileWorld(p);
  assert.equal(fitsVisitor(world,p.spawn.position),true);
  assert.equal(fitsVisitor(world,[11.5,1.99,6.5]),false);
  const report=navigationReport(p,world);
  assert.equal(report.spawnClear,true);
  assert.equal(report.stops[0].reachable,true);
});
