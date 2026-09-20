import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSTL } from '../skills/openscad/scripts/mesh.mjs';
const a=[0,0,0],b=[1,0,0],c=[0,1,0],d=[0,0,1];
export const faces=[[a,c,b],[a,b,d],[a,d,c],[b,c,d]];
export function ascii(triangles=faces){return 'solid tetra\n'+triangles.map(face=>'facet normal 0 0 0\nouter loop\n'+face.map(v=>'vertex '+v.join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid tetra\n';}
test('ASCII and binary STL agree on real volume, bounds and closure',()=>{
  const binary=Buffer.alloc(84+faces.length*50);binary.writeUInt32LE(faces.length,80);
  faces.forEach((face,i)=>face.forEach((point,v)=>point.forEach((n,axis)=>binary.writeFloatLE(n,84+i*50+12+v*12+axis*4))));
  for(const bytes of [Buffer.from(ascii()),binary]){
    const report=inspectSTL(bytes);assert.equal(report.watertight,true);assert.equal(report.triangles,4);
    assert.ok(Math.abs(report.volumeMM3-1/6)<1e-12);assert.deepEqual(report.bounds.size,[1,1,1]);
  }
});
test('open surfaces, inconsistent winding, degenerate faces, empty and malformed exports cannot pass',()=>{
  assert.equal(inspectSTL(Buffer.from(ascii(faces.slice(0,3)))).watertight,false);
  assert.equal(inspectSTL(Buffer.from(ascii([faces[0].toReversed(),...faces.slice(1)]))).watertight,false);
  assert.equal(inspectSTL(Buffer.from(ascii([[a,a,a]]))).watertight,false);
  for(const input of ['', 'solid x\nendsolid x', 'not stl',ascii().replace('vertex 0 0 0','vertex NaN 0 0')])assert.throws(()=>inspectSTL(Buffer.from(input)));
});
