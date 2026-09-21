import {parseGcode} from './gcode.mjs';
const $=id=>document.getElementById(id),report=JSON.parse($('report').textContent),canvas=$('path'),g=canvas.getContext('2d');
const palette=['#edb783','#b5d6c1','#73b8bd','#d4cf94','#d68b8e','#8aa9d8','#b49acc'];
let data=null,selected=null,layer=1,yaw=.6,pitch=.65,zoom=1,topView=false,timer=null,drag,request=0;
const artifactRevision=report.plans.map(p=>p.sha256.gcode).join(':');
$('title').textContent=report.title;$('brief').textContent=report.brief;$('assumptions').textContent=report.assumptions;
$('notice').textContent=(report.machine.context==='example'?'EXAMPLE MACHINE — NOT YOUR PRINTER. ':'USER-SUPPLIED MACHINE BRIEF — NOT PHYSICALLY VERIFIED. ')+'Native slices have been checked and reopened. Review the actual printer, plate, material, custom code and first layer in OrcaSlicer before printing.';
$('machine').textContent=report.machine.label+' · '+report.machine.nozzleMM+' mm nozzle · '+report.machine.material+' · '+report.machine.bedType+' · '+report.machine.bedMM.join(' × ')+' mm';
$('limits').textContent=report.limitations;$('revision').textContent='SAVED SOURCE '+report.revision.slice(0,16)+' · ORCA '+report.engine.version;
function time(seconds){const minutes=Math.round(seconds/60);return Math.floor(minutes/60)+'h '+minutes%60+'m';}
for(const plan of report.plans){
 const button=document.createElement('button');button.className='plan';button.dataset.plan=plan.id;button.setAttribute('aria-pressed','false');
 const name=document.createElement('span');name.className='name';name.textContent=plan.label;
 const metrics=document.createElement('span');metrics.className='numbers';
 for(const [value,unit] of [[time(plan.stats.timeSeconds),'EST.'],[plan.stats.filamentGrams.toFixed(1),'g']]){const span=document.createElement('span'),small=document.createElement('small');span.textContent=value;small.textContent=unit;span.append(small);metrics.append(span);}
 const settings=document.createElement('span');settings.className='settings';settings.textContent=plan.layerHeightMM+' mm · '+plan.wallLoops+' walls · '+plan.infillPercent+'% '+plan.infillPattern+' · '+plan.layers+' layers';
 const delta=document.createElement('span');delta.className='delta';const base=report.plans[0],dt=plan.stats.timeSeconds-base.stats.timeSeconds,dg=plan.stats.filamentGrams-base.stats.filamentGrams;
 delta.textContent=plan===base?'Comparison baseline · estimates, not measurements':(dt>=0?'+':'')+Math.round(dt/60)+' min / '+(dg>=0?'+':'')+dg.toFixed(1)+' g vs '+base.label;
 button.append(name,metrics,settings,delta);button.onclick=()=>select(plan.id);$('plans').append(button);
}
function list(id,items){$(id).replaceChildren(...items.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));}
function stop(){clearInterval(timer);timer=null;$('play').textContent='Play layers';$('play').setAttribute('aria-pressed','false');}
function legend(){
 $('legend').replaceChildren();if(!data)return;
 for(const [i,name]of ($('color').value==='speed'?['≤20 mm/s','100 mm/s','≥180 mm/s']:data.features).entries()){const row=document.createElement('span'),dot=document.createElement('i');dot.className='dot';dot.style.background=$('color').value==='speed'?['#8ac5df','#bdd495','#e69a6c'][i]:palette[i%palette.length];row.append(dot,document.createTextNode(name));$('legend').append(row);}
}
async function select(id){
 const turn=++request;stop();data=null;selected=report.plans.find(p=>p.id===id);if(!selected)throw new Error('Unknown saved plan.');
 for(const button of $('plans').children)button.setAttribute('aria-pressed',String(button.dataset.plan===id));
 $('plan-title').textContent=selected.label;$('plan-description').textContent=selected.description;
 for(const key of ['gcode','project','settings'])$(key).href=selected[key];
 $('check-count').textContent=selected.checks.length+' checks. Native project reopened.';
 $('thermal').textContent=selected.temperatures.map(t=>'Line '+t.line+' · '+t.command+' '+t.heater+' target '+t.target+' °C'+(t.wait?' · wait command':'')).join('\n')+'\n\nModel/support centerline bounds (mm):\n'+JSON.stringify(selected.bounds)+'\n\nAll commanded motion, including purge and parking (mm):\n'+JSON.stringify(selected.fullMotionBounds)+'\n\nThese are commands, not measured temperatures or firmware simulation.';
 list('checks',selected.checks.map(c=>'✓ '+c.name+' — '+c.detail));list('warnings',selected.warnings);
 $('status').textContent='Loading and verifying '+selected.label+' G-code…';canvas.dataset.ready='false';draw();
 try{
  const expected=selected,response=await fetch(expected.gcode);if(!response.ok)throw new Error('Could not load G-code; serve this project over its loopback URL.');
  const buffer=await response.arrayBuffer();if(buffer.byteLength>32*1024*1024)throw new Error('Toolpath exceeds the 32 MiB inspection limit.');
  if(!crypto.subtle)throw new Error('Integrity checks require a localhost or HTTPS browser context.');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==expected.sha256.gcode)throw new Error('G-code changed since its checked receipt. Rebuild the project.');
  await new Promise(resolve=>requestAnimationFrame(resolve));if(turn!==request)return;
  const parsed=parseGcode(new TextDecoder().decode(buffer));if(turn!==request)return;
  data=parsed;layer=Math.max(1,Math.round(data.layers.length*.72));$('layer').max=data.layers.length;$('layer').value=layer;$('total-label').textContent='/ '+data.layers.length;
  $('moves').textContent=data.moves.toLocaleString()+' ACTUAL MOVES';$('status').textContent='SHA-256 verified · drag to orbit · scroll to zoom';canvas.dataset.ready='true';canvas.dataset.plan=id;legend();draw();
 }catch(error){if(turn!==request)return;$('status').textContent=error.message;canvas.dataset.error=error.message;draw();}
}
function draw(){
 const width=canvas.clientWidth,height=canvas.clientHeight,ratio=Math.min(devicePixelRatio||1,2);canvas.width=width*ratio;canvas.height=height*ratio;g.scale(ratio,ratio);g.clearRect(0,0,width,height);if(!data)return;
 const full=$('full').checked,bounds=full?data.motionBounds:$('custom').checked?data.bounds:data.modelBounds,center=bounds.min.map((v,i)=>(v+bounds.max[i])/2),span=Math.max(1,...bounds.max.map((v,i)=>v-bounds.min[i]));
 const scale=Math.max(1,Math.min(width-70,height-100))/span*.88*zoom;
 const project=p=>{const x=p[0]-center[0],y=p[1]-center[1],z=p[2]-center[2];if(topView)return [width/2+x*scale,height/2-y*scale];const xx=x*Math.cos(yaw)-y*Math.sin(yaw),yy=x*Math.sin(yaw)+y*Math.cos(yaw);return [width/2+xx*scale,height/2+(yy*Math.sin(pitch)-z*Math.cos(pitch))*scale];};
 const segment=(a,b)=>{const p=project(a),q=project(b);g.moveTo(...p);g.lineTo(...q);};
 g.lineWidth=.7;g.strokeStyle='#50778040';g.beginPath();for(let i=-5;i<=5;i++){const v=i*span/10;segment([center[0]-span/2,center[1]+v,0],[center[0]+span/2,center[1]+v,0]);segment([center[0]+v,center[1]-span/2,0],[center[0]+v,center[1]+span/2,0]);}g.stroke();
 let displayed=0;const rows=full?[{segments:data.motions}]:data.layers.slice($('stack').checked?0:layer-1,layer);
 for(const [index,row] of rows.entries()){
  const active=full||index===rows.length-1,groups=new Map();
  for(const s of row.segments){
   if(!full&&((!s[8]&&!$('travel').checked)||(!$('custom').checked&&data.features[s[7]]==='Custom')))continue;
   const color=!s[8]?'#9fb7c14a':!active?'#94bdc138':$('color').value==='speed'?'hsl('+Math.max(20,Math.round((205-s[6]*1.05)/10)*10)+',48%,66%)':palette[s[7]%palette.length];
   if(!groups.has(color))groups.set(color,[]);groups.get(color).push(s);displayed++;
  }
  for(const [color,segments]of groups){g.strokeStyle=color;g.lineWidth=active?1.2:.65;g.beginPath();for(const s of segments)segment(s.slice(0,3),s.slice(3,6));g.stroke();}
 }
 $('layer-label').textContent=full?'All':layer;$('z-label').textContent=full?'PURGE → MODEL → PARK':'Z '+data.layers[layer-1].z.toFixed(2)+' MM';
 canvas.dataset.layer=String(layer);canvas.dataset.segments=String(displayed);canvas.dataset.projection=topView?'top':'isometric';canvas.dataset.full=String(full);
 $('layer').disabled=full;$('previous').disabled=full||layer===1;$('next').disabled=full||layer===data.layers.length;$('play').disabled=full;
}
function setLayer(value){if(!data)return;layer=Math.max(1,Math.min(data.layers.length,Number(value)));$('layer').value=layer;draw();}
$('layer').oninput=()=>setLayer($('layer').value);$('previous').onclick=()=>setLayer(layer-1);$('next').onclick=()=>setLayer(layer+1);
$('play').onclick=()=>{if(timer){stop();return;}if(!data)return;$('play').textContent='Pause';$('play').setAttribute('aria-pressed','true');timer=setInterval(()=>{if(layer===data.layers.length){stop();return;}setLayer(layer+1);},180);};
for(const id of ['iso','top'])$(id).onclick=()=>{topView=id==='top';$('iso').setAttribute('aria-pressed',String(!topView));$('top').setAttribute('aria-pressed',String(topView));draw();};
$('reset').onclick=()=>{yaw=.6;pitch=.65;zoom=1;draw();};for(const id of ['stack','travel','color','custom','full'])$(id).onchange=()=>{stop();legend();draw();};
canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY};};canvas.onpointermove=e=>{if(!drag)return;yaw+=(e.clientX-drag.x)*.009;pitch=Math.max(.1,Math.min(1.5,pitch+(e.clientY-drag.y)*.007));drag={x:e.clientX,y:e.clientY};draw();};canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.3,Math.min(6,zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});
canvas.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setLayer(layer+(e.key==='ArrowRight'?1:-1));}};
$('save-review').onclick=()=>{
 if(!data){$('review-status').textContent='Wait for a verified toolpath before saving.';return;}
 const state={spec:1,revision:report.revision,artifactRevision,plan:selected.id,notes:$('notes').value,layer,yaw,pitch,zoom,topView,options:Object.fromEntries(['stack','travel','custom','full'].map(k=>[k,$(k).checked])),color:$('color').value};
 const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)+'\n'],{type:'application/json'}));link.href=url;link.download='strata-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('review-status').textContent='Review exported for this exact source and toolpath revision.';
};
$('restore-button').onclick=()=>$('restore-review').click();
$('restore-review').onchange=async()=>{
 const file=$('restore-review').files[0];try{
  if(!file||file.size>65536)throw new Error('Choose a review JSON under 64 KiB.');const state=JSON.parse(await file.text());
  if(state.spec!==1||state.revision!==report.revision||state.artifactRevision!==artifactRevision)throw new Error('Review belongs to a different source or toolpath revision.');
  if(!report.plans.some(p=>p.id===state.plan)||typeof state.notes!=='string'||state.notes.length>12000||!Number.isInteger(state.layer)||state.layer<1||typeof state.topView!=='boolean'||!['feature','speed'].includes(state.color)||!state.options||['stack','travel','custom','full'].some(k=>typeof state.options[k]!=='boolean'))throw new Error('Invalid review values.');
  for(const [key,min,max]of [['yaw',-100000,100000],['pitch',.1,1.5],['zoom',.3,6]])if(!Number.isFinite(state[key])||state[key]<min||state[key]>max)throw new Error('Invalid view values.');
  await select(state.plan);if(!data||selected.id!==state.plan)throw new Error('Review plan did not load or selection changed.');if(state.layer>data.layers.length)throw new Error('Review layer exceeds this toolpath.');
  $('notes').value=state.notes;yaw=state.yaw;pitch=state.pitch;zoom=state.zoom;topView=state.topView;for(const key of ['stack','travel','custom','full'])$(key).checked=state.options[key];$('color').value=state.color;
  $('iso').setAttribute('aria-pressed',String(!topView));$('top').setAttribute('aria-pressed',String(topView));setLayer(state.layer);legend();$('review-status').textContent='Review restored. No print has been approved or started.';
 }catch(error){$('review-status').textContent=error.message;}finally{$('restore-review').value='';}
};
new ResizeObserver(draw).observe(canvas);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});select(report.selectedPlan);
