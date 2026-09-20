import {test} from 'node:test';
import assert from 'node:assert/strict';
import {number,vector} from '../skills/openscad/scripts/expression.mjs';
import {regionFor,regionScad} from '../skills/openscad/scripts/design.mjs';
import {dependencies,partCall,projection} from '../skills/openscad/scripts/native.mjs';
import {inspectSTL,binarySTL} from '../skills/openscad/scripts/mesh.mjs';

test('saved briefs reject unknown fields, unsafe sources, weakened contracts and ambiguous delivery IDs',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {validateDesign}=await import('../skills/openscad/scripts/design.mjs');
  const fixture=JSON.parse(await readFile(new URL('../template/design.json',import.meta.url)));
  assert.equal(validateDesign(fixture).variants.length,3);
  const mutations=[
    d=>d.unchecked=true,
    d=>d.sourceFiles.push('../private.txt'),
    d=>d.sourceFiles.push('handoff/parts/private.stl'),
    d=>d.parameters.columns.value=2.5,
    d=>d.variants[0].values.unknown=1,
    d=>d.parts[0].shells=0,
    d=>d.parts[0].views.top.at='process.exit()',
    d=>d.checks.splice(0,1),
    d=>d.checks[0].tolerance=5,
    d=>d.checks[0].id='tray-topology',
    d=>d.checks[1].region.size[0]='0',
    d=>d.variants[1].values.width=1000,
    d=>d.process.bedMM[0]=-1,
    d=>d.preview.part='unknown'
  ];
  for(const mutate of mutations){const invalid=structuredClone(fixture);mutate(invalid);assert.throws(()=>validateDesign(invalid));}
  const collision=structuredClone(fixture);
  collision.parts.push({...structuredClone(collision.parts[0]),id:'compact-tray'});
  collision.variants.push({id:'everyday-compact',label:'Collision',values:{},notes:[]});
  assert.throws(()=>validateDesign(collision),/Ambiguous variant\/part/);
  const input=structuredClone(fixture),result=validateDesign(input);
  result.variants[0].values.width=100;assert.equal(input.variants[0].values.width,150);
});

test('requirement arithmetic is bounded, has precedence and never evaluates JavaScript',()=>{
  assert.equal(number('(width-(columns+1)*wall)/columns',{width:180,columns:3,wall:2.4}),56.800000000000004);
  assert.equal(number(' -2 * (3 + +4) / 2 '),-7);
  assert.deepEqual(vector([1,'2+3',6],{}),[1,5,6]);
  for(const value of ['unknown','1/0','(1+2','1+2)','1 2','process.exit()','width.constructor','Math.max(1,2)','1e100','2**4','a[0]','1;2']){
    assert.throws(()=>number(value,{width:1}));
  }
  assert.throws(()=>vector([0,1,1],{},'probe',{positive:true}),/positive/);
});
test('repeated box/cylinder probes are numeric and finite, with correct axis orientation',()=>{
  const region=regionFor({shape:'box',origin:[1,2,3],size:['wall',4,5],repeat:[{count:2,step:[10,0,0]},{count:2,step:[0,20,0]}]},{wall:2});
  assert.deepEqual(region.origins,[[1,2,3],[1,22,3],[11,2,3],[11,22,3]]);
  assert.match(regionScad(region),/translate\(\[11,22,3\]\) cube\(\[2,4,5\]\)/);
  assert.match(regionScad(regionFor({shape:'cylinder',origin:[0,0,0],radius:4,height:10,axis:'x'},{})),/rotate\(\[0,90,0\]\)/);
  assert.throws(()=>regionFor({shape:'box',origin:[0,0,0],size:[1,1,1],repeat:[{count:32,step:[1,0,0]},{count:32,step:[0,1,0]}]},{}),/64 repeated/);
});
test('native dependency receipts handle escaped paths and named module calls ignore top-level preview',()=>{
  assert.deepEqual(dependencies('/tmp/output.stl: \\\n\t/tmp/space\\ here/model.scad \\\n\t/tmp/source.scad\n'),['/tmp/space here/model.scad','/tmp/source.scad']);
  assert.throws(()=>dependencies('no receipt'),/Invalid/);
  assert.equal(partCall('tray',{width:100,depth:60}),'part(id="tray",width=100,depth=60);');
  assert.match(projection('/tmp/model.stl','front',10),/rotate\(\[-90,0,0\]\) translate\(\[0,-10,0\]\)/);
});
test('mesh reports connected surface shells and signed volume; translation preserves actual size',()=>{
  const a=[0,0,0],b=[1,0,0],c=[0,1,0],d=[0,0,1],faces=[[a,c,b],[a,b,d],[a,d,c],[b,c,d]];
  const moved=faces.map(face=>face.map(point=>point.map((value,axis)=>value+(axis===0?5:0))));
  const report=inspectSTL(binarySTL([...faces,...moved]));
  assert.equal(report.shells.length,2);assert.equal(report.watertight,true);
  assert.ok(Math.abs(report.volumeMM3-1/3)<1e-7);
  const shifted=inspectSTL(binarySTL(faces,[-2,3,4]));
  assert.deepEqual(shifted.bounds,{min:[-2,3,4],max:[-1,4,5],size:[1,1,1]});
  assert.ok(Math.abs(shifted.volumeMM3-1/6)<1e-7);
  assert.ok(inspectSTL(binarySTL(faces.map(face=>face.toReversed()))).orientedVolumeMM3<0);
});
