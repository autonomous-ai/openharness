import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCircuit,simulate,probabilities,bloch,sampleShots,basisLabel } from '../skills/quantum/scripts/engine.mjs';
const circuit=(gates,n=1)=>({qubits:Array.from({length:n},(_,i)=>'q'+i),gates});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,a+' != '+b);

test('bitstrings use q0 as the rightmost bit; named gates produce known complex amplitudes',()=>{
  assert.deepEqual(probabilities(simulate(circuit([{gate:'X',target:0}],3))),[0,1,0,0,0,0,0,0]);
  assert.equal(basisLabel(1,3),'001');
  const y=simulate(circuit([{gate:'Y',target:0}]));
  close(y[2],0);close(y[3],1);
  const h=simulate(circuit([{gate:'H',target:0}]));
  close(h[0],Math.SQRT1_2);close(h[2],Math.SQRT1_2);
});
test('Bloch poles and complex phase signs are correct',()=>{
  close(bloch(simulate(circuit([])),0).z,1);
  close(bloch(simulate(circuit([{gate:'X',target:0}])),0).z,-1);
  close(bloch(simulate(circuit([{gate:'H',target:0}])),0).x,1);
  close(bloch(simulate(circuit([{gate:'H',target:0},{gate:'S',target:0}])),0).y,1);
});
test('Bell and GHZ states have the correct joint probabilities and locally mixed states',()=>{
  const bell=simulate(circuit([{gate:'H',target:0},{gate:'CX',control:0,target:1}],2));
  const p=probabilities(bell);
  close(p[0],.5);close(p[3],.5);close(p[1]+p[2],0);
  for(const q of [0,1]){close(bloch(bell,q).length,0);close(bloch(bell,q).purity,.5);}
  const ghz=simulate(circuit([{gate:'H',target:0},{gate:'CX',control:0,target:1},{gate:'CX',control:1,target:2}],3));
  close(probabilities(ghz)[0],.5);close(probabilities(ghz)[7],.5);
  const partial=new Float64Array([Math.sqrt(.8),0,0,0,0,0,Math.sqrt(.2),0]);
  close(bloch(partial,0).length,.6);close(bloch(partial,0).purity,.68);
});
test('inverse pairs, phase interference, controlled Z and SWAP preserve the expected state',()=>{
  for(const [gate,inverse] of [['H','H'],['X','X'],['Y','Y'],['Z','Z'],['S','SDG'],['T','TDG']]){
    close(simulate(circuit([{gate,target:0},{gate:inverse,target:0}]))[0],1);
  }
  for(const gate of ['RX','RY','RZ']){
    const state=simulate(circuit([{gate,target:0,theta:.723},{gate,target:0,theta:-.723}]));
    close(state[0],1);close(state[2],0);
  }
  const interference=simulate(circuit([{gate:'H',target:0},{gate:'RZ',target:0,theta:Math.PI},{gate:'H',target:0}]));
  close(probabilities(interference)[1],1);
  close(probabilities(simulate(circuit([{gate:'X',target:0},{gate:'SWAP',control:0,target:1}],2)))[2],1);
  const cz=simulate(circuit([{gate:'X',target:0},{gate:'X',target:1},{gate:'CZ',control:0,target:1}],2));
  close(cz[6],-1);
});
test('invalid targets, controls, angles, matrices and mid-circuit measurements fail explicitly',()=>{
  for(const gates of [[{gate:'H',target:-1}],[{gate:'H',target:1.5}],[{gate:'H',target:8}],[{gate:'CX',control:0,target:0}],[{gate:'CX',target:1}],[{gate:'RY',target:0,theta:NaN}],[{gate:'bogus',target:0,matrix:[1]}],[{gate:'measure',target:0},{gate:'H',target:1}]]){
    assert.throws(()=>simulate(circuit(gates,2)));
  }
  assert.throws(()=>validateCircuit({qubits:['a','a'],gates:[]}));
  assert.throws(()=>simulate(circuit([]),-1));
  assert.throws(()=>validateCircuit(circuit([],9)));
});
test('terminal readout is explicitly premeasurement; Born-rule shots match deterministic and Bell states',()=>{
  const state=simulate(circuit([{gate:'H',target:0},{gate:'CX',control:0,target:1},{gate:'measure',target:0},{gate:'measure',target:1}],2));
  let sample=0;
  assert.deepEqual(sampleShots(state,100,()=>((sample++)+.5)/100),[50,0,0,50]);
  assert.deepEqual(sampleShots(simulate(circuit([{gate:'X',target:0}])),10),[0,10]);
  assert.throws(()=>sampleShots(state,0));
  assert.throws(()=>sampleShots(state,10,()=>1));
});
test('stepping inspects the actual intermediate state',()=>{
  const cfg=circuit([{gate:'H',target:0},{gate:'CX',control:0,target:1}],2);
  close(probabilities(simulate(cfg,0))[0],1);
  close(probabilities(simulate(cfg,1))[1],.5);
  close(bloch(simulate(cfg,1),0).purity,1);
  close(bloch(simulate(cfg,2),0).purity,.5);
});
