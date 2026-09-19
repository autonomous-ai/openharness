'use strict';
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const original = validateCircuit(JSON.parse($('circuit-config').textContent));
const PRESETS = {
  bell:{name:'Bell pair',qubits:['q0','q1'],gates:[{gate:'H',target:0},{gate:'CX',control:0,target:1}],shots:1024},
  ghz:{name:'GHZ state',qubits:['q0','q1','q2'],gates:[{gate:'H',target:0},{gate:'CX',control:0,target:1},{gate:'CX',control:1,target:2}],shots:1024},
  phase:{name:'Interference',qubits:['q0'],gates:[{gate:'H',target:0},{gate:'RZ',target:0,theta:Math.PI/2},{gate:'H',target:0}],shots:1024}
};
let current=clone(original), step=current.gates.length, selected=-1, past=[], future=[], activePreset='source', counts=null, state, camera={x:.35,y:.65};
const rotation = gate => ['RX','RY','RZ'].includes(gate);
const dual = gate => ['CX','CZ','SWAP'].includes(gate);
function node(tag,attrs={},text) {
  const el=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);
  if(text!==undefined)el.textContent=text;
  return el;
}
function message(error) { $('error').hidden=!error; $('error').textContent=error?.message||''; }
function edit(next) {
  try {
    const clean=validateCircuit(next);
    past.push(clone(current));if(past.length>64)past.shift();future=[];
    current=clean;step=current.gates.length;counts=null;message(null);
    $('edited').textContent='Exploration · save to keep';
    configure();render();
  } catch(error){message(error);}
}
function configure() {
  const shots=String(current.shots);
  if(![...$('shots').options].some(option=>option.value===shots))$('shots').append(node('option',{value:shots},shots));
  $('shots').value=shots;
  for(const id of ['target','control']){
    const previous=$(id).value;
    $(id).replaceChildren(...current.qubits.map((name,i)=>node('option',{value:i},name)));
    $(id).value=Number(previous)<current.qubits.length?previous:'0';
    if(!$(id).value)$(id).value=id==='target'&&current.qubits.length>1?'1':'0';
  }
  if(dual($('gate').value) && $('target').value===$('control').value && current.qubits.length>1) $('control').value=String((Number($('target').value)+1)%current.qubits.length);
  syncComposer();
}
function syncComposer() {
  $('control-wrap').hidden=!dual($('gate').value);
  $('theta-wrap').hidden=!rotation($('gate').value);
  $('theta-label').textContent=$('theta').value+'°';
  $('add').disabled=dual($('gate').value) && (current.qubits.length<2 || $('target').value===$('control').value);
}
function render() {
  const started=performance.now();
  state=simulate(current,step);
  const probabilitiesNow=probabilities(state);
  $('norm').textContent=probabilitiesNow.reduce((sum,p)=>sum+p,0).toFixed(4);
  $('circuit-name').textContent=current.name;
  $('step').max=current.gates.length;$('step').value=step;
  $('step-label').textContent='Step '+step+' / '+current.gates.length;
  $('back').disabled=step===0;$('forward').disabled=step===current.gates.length;
  $('undo').disabled=!past.length;$('redo').disabled=!future.length;$('remove').disabled=selected<0;
  document.querySelectorAll('[data-preset]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.preset===activePreset)));
  $('description').textContent=activePreset==='bell'?'Two qubits. Individually uncertain, perfectly correlated together. Step back to see where entanglement begins.':activePreset==='ghz'?'Three qubits share one state. Only 000 and 111 can appear when you measure the final circuit.':activePreset==='phase'?'Phase is invisible in a probability chart—until gates make the paths interfere. Select RZ and turn its angle.':'Build a circuit. Follow a qubit. Watch possibilities become probabilities.';
  $('experiment').textContent=activePreset==='phase'?'Select the RZ gate, move its angle slider, then go to the final step. At 0° the result is 0; at 180° it is 1. Interference turns phase into a measurable difference.':'Move the step slider back before the first controlled gate. Each qubit is pure. Move forward again: the arrows shrink as the qubits become entangled.';
  const last=current.gates[step-1];
  $('step-story').textContent=!last?'Start: every qubit is in |0⟩.':last.gate==='measure'?'Terminal readout marker: the views show the premeasurement state. Sample outcomes to see simulated results.':last.gate==='H'?'H creates or recombines superposition on '+current.qubits[last.target]+'.':last.gate==='CX'?'CX flips '+current.qubits[last.target]+' only in branches where '+current.qubits[last.control]+' is 1.':rotation(last.gate)?last.gate+' rotates '+current.qubits[last.target]+' by '+(last.theta*180/Math.PI).toFixed(0)+'°.':'Applied '+last.gate+' to '+current.qubits[last.target]+'.';
  drawCircuit();drawSpheres();drawProbabilities();drawAmplitudes();
  $('runtime').textContent=(performance.now()-started).toFixed(1)+' ms · '+(1<<current.qubits.length)+' amplitudes';
}
function drawCircuit() {
  $('circuit').replaceChildren(...current.qubits.map((name,q)=>{
    const row=node('div',{class:'lane'});row.append(node('span',{class:'qlabel',title:name},name));
    for(let i=0;i<Math.max(4,current.gates.length+1);i++){
      const op=current.gates[i],cell=node('div',{class:'wire '+(i<step?'past':'future')});
      if(op && (op.target===q || (dual(op.gate)&&op.control===q))){
        const isControl=dual(op.gate)&&op.control===q;
        if(dual(op.gate)&&q===Math.min(op.control,op.target)){
          const line=node('span',{class:'connector'});line.style.height=(Math.abs(op.control-op.target)*61)+'px';cell.append(line);
        }
        const symbol=isControl?(op.gate==='SWAP'?'×':''):op.gate==='CX'?'⊕':op.gate==='SWAP'?'×':op.gate==='measure'?'M':op.gate;
        const button=node('button',{class:'gate '+(isControl&&op.gate!=='SWAP'?'control-gate ':'')+(dual(op.gate)&&!isControl?'target-gate ':'')+(selected===i?'selected':''),'aria-label':name+' step '+(i+1)+': '+op.gate,title:'Inspect '+op.gate+' after step '+(i+1)},symbol);
        button.onclick=()=>{
          selected=i;step=i+1;counts=null;
          if(op.gate!=='measure'){
            $('gate').value=op.gate;$('target').value=String(op.target);
            if(dual(op.gate))$('control').value=String(op.control);
            if(rotation(op.gate))$('theta').value=String(Math.round(op.theta*180/Math.PI));
            syncComposer();
          }
          render();
        };
        cell.append(button);
      }
      if(q===current.qubits.length-1 && op)cell.append(node('span',{class:'step-number'},i+1));
      row.append(cell);
    }
    return row;
  }));
}
function project(vec,cx,cy,r) {
  const [x,y,z]=vec, c=Math.cos(camera.y),s=Math.sin(camera.y);
  const xx=x*c-y*s,yy=x*s+y*c;
  const zz=z*Math.cos(camera.x)-yy*Math.sin(camera.x),depth=z*Math.sin(camera.x)+yy*Math.cos(camera.x);
  const perspective=1/(1-depth*.08);
  return [cx+xx*r*perspective,cy-zz*r*perspective,depth];
}
function sphere(canvas,vector) {
  const ratio=Math.min(devicePixelRatio||1,2),size=240;
  canvas.width=size*ratio;canvas.height=size*ratio;
  const g=canvas.getContext('2d');g.scale(ratio,ratio);
  const cx=120,cy=118,r=84;
  const gradient=g.createRadialGradient(91,82,3,cx,cy,98);
  gradient.addColorStop(0,'#31414b');gradient.addColorStop(.75,'#1a2a35');gradient.addColorStop(1,'#16212b');
  g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.fillStyle=gradient;g.fill();
  const path=(make,stroke,dash=[])=>{
    g.beginPath();g.strokeStyle=stroke;g.lineWidth=.8;g.setLineDash(dash);
    for(let j=0;j<=120;j++){const p=project(make(j/120*Math.PI*2),cx,cy,r);j?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]);}g.stroke();g.setLineDash([]);
  };
  for(const latitude of [-.66,-.33,0,.33,.66])path(t=>[Math.cos(t)*Math.sqrt(1-latitude**2),Math.sin(t)*Math.sqrt(1-latitude**2),latitude],'#8aa6b331');
  for(const angle of [0,Math.PI/4,Math.PI/2,Math.PI*3/4])path(t=>[Math.cos(t)*Math.cos(angle),Math.cos(t)*Math.sin(angle),Math.sin(t)],'#8aa6b334');
  g.strokeStyle='#8aa6b34a';g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.stroke();
  for(const [v,label] of [[[0,0,1],'|0⟩'],[[0,0,-1],'|1⟩'],[[1,0,0],'x'],[[0,1,0],'y']]){
    const p=project(v,cx,cy,r*1.14);g.fillStyle='#8fa6b5';g.font='11px ui-monospace,monospace';g.textAlign='center';g.fillText(label,p[0],p[1]+3);
  }
  const p=project([vector.x,vector.y,vector.z],cx,cy,r);
  g.strokeStyle='#ffb26b';g.lineWidth=2.1;g.beginPath();g.moveTo(cx,cy);g.lineTo(p[0],p[1]);g.stroke();
  const glow=g.createRadialGradient(p[0],p[1],0,p[0],p[1],15);glow.addColorStop(0,'#ffb26b50');glow.addColorStop(1,'#ffb26b00');
  g.fillStyle=glow;g.fillRect(p[0]-15,p[1]-15,30,30);g.fillStyle='#ffd0a0';g.beginPath();g.arc(p[0],p[1],3.7,0,Math.PI*2);g.fill();
}
function drawSpheres() {
  let mixed=0;
  $('spheres').replaceChildren(...current.qubits.map((name,q)=>{
    const vector=bloch(state,q);if(vector.purity<.999999)mixed++;
    const card=node('div',{class:'sphere'}),canvas=node('canvas',{role:'img','aria-label':name+' Bloch sphere; purity '+vector.purity.toFixed(3)});
    card.append(node('span',{class:'qubit-name'},name),canvas);
    sphere(canvas,vector);
    const purity=node('div',{class:'purity'});purity.append(document.createTextNode('Purity '),node('b',{},vector.purity.toFixed(3)),document.createTextNode(vector.purity<.999999?' · mixed':' · pure'));
    card.append(purity,node('div',{class:'values'},'x '+vector.x.toFixed(2)+'  y '+vector.y.toFixed(2)+'  z '+vector.z.toFixed(2)));
    let drag;
    canvas.onpointerdown=event=>{canvas.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY};};
    canvas.onpointermove=event=>{
      if(!drag)return;
      camera.y+=(event.clientX-drag.x)*.012;camera.x=Math.max(-1.2,Math.min(1.2,camera.x+(event.clientY-drag.y)*.008));drag={x:event.clientX,y:event.clientY};
      document.querySelectorAll('.sphere canvas').forEach((cv,index)=>sphere(cv,bloch(state,index)));
    };
    canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
    return card;
  }));
  $('state-note').replaceChildren();
  $('state-note').append(node('strong',{},mixed?'Entangled, not broken. ':'A pure local state. '),document.createTextNode(mixed?'An arrow inside the sphere means that qubit cannot be described independently as a pure state. The full circuit is still a normalized pure state.':'An arrow on the surface describes a pure qubit. Its direction encodes relative phase and the probabilities of 0 and 1.'));
}
function drawProbabilities() {
  const probs=probabilities(state);
  $('probabilities').replaceChildren(...probs.map((p,i)=>{
    const row=node('div',{class:'prob-row','data-basis':basisLabel(i,current.qubits.length)});
    row.append(node('span',{class:'ket'},'|'+basisLabel(i,current.qubits.length)+'⟩'));
    const track=node('div',{class:'bar'}),bar=node('div',{class:'expected'});
    bar.style.width=Math.max(0,Math.min(100,p*100))+'%';track.append(bar);
    if(counts){const observed=node('div',{class:'observed'});observed.style.width=counts[i]/counts.reduce((a,b)=>a+b,0)*100+'%';track.append(observed);}
    const label=node('span',{class:'value'},(p*100).toFixed(1)+'%');
    if(counts)label.append(node('br'),node('small',{},counts[i]+' shots'));
    row.append(track,label);return row;
  }));
  $('basis-order').textContent='Bit order: |'+[...current.qubits].reverse().join(' ')+ '⟩ · q0 is the rightmost bit';
  $('sample-status').textContent=counts?counts.reduce((a,b)=>a+b,0)+' simulated shots · light bars show frequencies':'Exact probabilities before readout · ideal, noiseless simulation';
}
function drawAmplitudes() {
  const amplitudes=[];
  for(let i=0;i<state.length/2;i++){
    const real=state[2*i],imag=state[2*i+1];
    if(real*real+imag*imag<1e-12)continue;
    const phase=Math.atan2(imag,real),row=node('div',{class:'amplitude'}),left=node('span',{},'|'+basisLabel(i,current.qubits.length)+'⟩  '+real.toFixed(3)+(imag<0?' − ':' + ')+Math.abs(imag).toFixed(3)+'i');
    const right=node('span',{class:'phase'});
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','24');svg.setAttribute('height','24');svg.setAttribute('viewBox','0 0 24 24');
    const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx','12');circle.setAttribute('cy','12');circle.setAttribute('r','9');circle.setAttribute('fill','none');circle.setAttribute('stroke','#8abadd55');
    const line=document.createElementNS(svg.namespaceURI,'line');
    for(const [key,value] of Object.entries({x1:12,y1:12,x2:12+Math.cos(phase)*8,y2:12-Math.sin(phase)*8,stroke:'#ffb26b','stroke-width':1.5}))line.setAttribute(key,value);
    svg.append(circle,line);right.append(svg,document.createTextNode((phase*180/Math.PI).toFixed(0)+'°'));row.append(left,right);amplitudes.push(row);
  }
  $('amplitudes').replaceChildren(...amplitudes);
}
$('gate').replaceChildren(...GATE_NAMES.map(name=>node('option',{value:name},name)));
for(const id of ['gate','target','control'])$(id).onchange=()=>{if(id==='gate')selected=-1;syncComposer();$('remove').disabled=selected<0;};
$('theta').oninput=()=>{
  syncComposer();
  if(selected>=0 && rotation(current.gates[selected].gate)){
    const keep=selected,next=clone(current);next.gates[selected].theta=Number($('theta').value)*Math.PI/180;
    edit(next);selected=keep;render();
  }
};
$('add').onclick=()=>{
  const next=clone(current),gate=$('gate').value,op={gate,target:Number($('target').value)};
  if(dual(gate))op.control=Number($('control').value);
  if(rotation(gate))op.theta=Number($('theta').value)*Math.PI/180;
  const readout=next.gates.findIndex(op=>op.gate==='measure');
  next.gates.splice(readout<0?next.gates.length:readout,0,op);
  selected=-1;activePreset='';edit(next);
};
$('remove').onclick=()=>{if(selected<0)return;const next=clone(current);next.gates.splice(selected,1);selected=-1;activePreset='';edit(next);};
function setStep(value){step=Number(value);counts=null;selected=-1;render();}
$('step').oninput=event=>setStep(event.target.value);
$('back').onclick=()=>setStep(Math.max(0,step-1));
$('forward').onclick=()=>setStep(Math.min(current.gates.length,step+1));
$('undo').onclick=()=>{if(!past.length)return;future.push(clone(current));current=past.pop();step=current.gates.length;selected=-1;counts=null;activePreset='';configure();render();};
$('redo').onclick=()=>{if(!future.length)return;past.push(clone(current));current=future.pop();step=current.gates.length;selected=-1;counts=null;configure();render();};
document.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{
  activePreset=button.dataset.preset;selected=-1;
  edit(activePreset==='source'?original:PRESETS[activePreset]);
  if(activePreset==='phase'){$('gate').value='RZ';$('theta').value='90';selected=1;syncComposer();render();}
});
$('measure').onclick=()=>{counts=sampleShots(state,Number($('shots').value));drawProbabilities();};
$('shots').onchange=()=>edit({...current,shots:Number($('shots').value)});
$('import').onclick=()=>$('upload').click();
$('upload').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>1024*1024)throw new Error('Choose a circuit JSON smaller than 1 MB.');
    const next=JSON.parse(await file.text());validateCircuit(next);activePreset='';selected=-1;edit(next);
  }catch(error){message(error);}
  event.target.value='';
};
$('download').onclick=()=>{
  const blob=new Blob([JSON.stringify(current,null,2)+'\n'],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=node('a',{href:url,download:'circuit.json'});link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  $('edited').textContent='Exported · replace circuit.json to persist';
};
configure();render();
