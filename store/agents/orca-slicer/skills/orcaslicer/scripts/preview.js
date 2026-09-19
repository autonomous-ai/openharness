const $=id=>document.getElementById(id),data=JSON.parse($('config').textContent),canvas=$('path'),g=canvas.getContext('2d');
const palette=['#edb783','#b5d6c1','#73b8bd','#d4cf94','#d68b8e','#8aa9d8','#b49acc'];
let layer=Math.max(1,Math.round(data.layers.length*.7)),yaw=.6,pitch=.65,zoom=1,topView=false,timer=null,drag;
$('layers').textContent=data.layers.length;$('time').textContent=data.stats.time||'Not reported';$('filament').textContent=data.stats.filamentGrams!==null?data.stats.filamentGrams.toFixed(1)+' g':data.stats.filamentMm!==null?(data.stats.filamentMm/1000).toFixed(2)+' m':'Not reported';$('layer').max=data.layers.length;$('layer').value=layer;$('total-label').textContent='/ '+data.layers.length;$('config-view').textContent=JSON.stringify(data.config,null,2);$('moves').textContent=data.moves.toLocaleString()+' LINEAR MOVES PARSED';
$('notice').textContent=data.config.mode==='demo'?'DEMO PROFILE — Prusa MK3S, not your printer. This is a toolpath study, not a print-ready recommendation. Review the exact machine, material, temperatures, origin and first layer before printing.':'Sliced, not print-tested. Review machine-specific G-code, temperatures, bed boundaries and the first layer in OrcaSlicer before printing.';
for(const text of [...data.warnings,'Geometry preview does not model heater behavior, firmware limits, offsets, bed leveling, collisions, supports adequacy or mechanical printability.']){const li=document.createElement('li');li.textContent=text;$('warnings').append(li);}
function legend(){
  $('legend').replaceChildren();for(const [i,name]of ($('color').value==='speed'?['≤20 mm/s','100 mm/s','≥180 mm/s']:data.features).entries()){const row=document.createElement('span'),dot=document.createElement('i');dot.className='dot';dot.style.background=$('color').value==='speed'?['#8ac5df','#bdd495','#e69a6c'][i]:palette[i%palette.length];row.append(dot,document.createTextNode(name));$('legend').append(row);}
}
function draw(){
  const width=canvas.clientWidth,height=canvas.clientHeight,ratio=Math.min(devicePixelRatio||1,2);canvas.width=width*ratio;canvas.height=height*ratio;g.scale(ratio,ratio);g.clearRect(0,0,width,height);
  const bounds=$('custom').checked?data.bounds:(data.modelBounds||data.bounds),center=bounds.min.map((v,i)=>(v+bounds.max[i])/2),span=Math.max(1,...bounds.max.map((v,i)=>v-bounds.min[i]));const scale=Math.min(width-80,height-110)/span*.85*zoom;
  const project=p=>{const x=p[0]-center[0],y=p[1]-center[1],z=p[2]-center[2];if(topView)return [width/2+x*scale,height/2-y*scale];const xx=x*Math.cos(yaw)-y*Math.sin(yaw),yy=x*Math.sin(yaw)+y*Math.cos(yaw);return [width/2+xx*scale,height/2+(yy*Math.sin(pitch)-z*Math.cos(pitch))*scale];};
  const segment=(a,b)=>{const p=project(a),q=project(b);g.moveTo(...p);g.lineTo(...q);};
  g.lineWidth=.7;g.strokeStyle='#46636a35';g.beginPath();for(let i=-5;i<=5;i++){const v=i*span/10;segment([center[0]-span/2,center[1]+v,0],[center[0]+span/2,center[1]+v,0]);segment([center[0]+v,center[1]-span/2,0],[center[0]+v,center[1]+span/2,0]);}g.stroke();
  let displayed=0;const start=$('stack').checked?0:layer-1;
  for(let l=start;l<layer;l++){
    const active=l===layer-1,groups=new Map();
    for(const s of data.layers[l].segments){if((!s[8]&&!$('travel').checked)||(!$('custom').checked&&data.features[s[7]]==='Custom'))continue;const color=!s[8]?'#677d8744':!active?'#86abb033':$('color').value==='speed'?'hsl('+Math.max(20,205-s[6]*1.05)+',48%,66%)':palette[s[7]%palette.length];if(!groups.has(color))groups.set(color,[]);groups.get(color).push(s);displayed++;}
    for(const [color,segments]of groups){g.strokeStyle=color;g.lineWidth=active?1.35:.6;g.beginPath();for(const s of segments)segment(s.slice(0,3),s.slice(3,6));g.stroke();}
  }
  $('layer-label').textContent=layer;$('z-label').textContent='Z '+data.layers[layer-1].z.toFixed(2)+' MM';canvas.dataset.layer=String(layer);canvas.dataset.segments=String(displayed);canvas.dataset.projection=topView?'top':'isometric';$('previous').disabled=layer===1;$('next').disabled=layer===data.layers.length;
}
function setLayer(value){layer=Math.max(1,Math.min(data.layers.length,Number(value)));$('layer').value=layer;draw();}
$('layer').oninput=()=>setLayer($('layer').value);$('previous').onclick=()=>setLayer(layer-1);$('next').onclick=()=>setLayer(layer+1);
function stop(){clearInterval(timer);timer=null;$('play').textContent='Play layers';$('play').setAttribute('aria-pressed','false');}
$('play').onclick=()=>{if(timer){stop();return;}$('play').textContent='Pause';$('play').setAttribute('aria-pressed','true');timer=setInterval(()=>{if(layer===data.layers.length){stop();return;}setLayer(layer+1);},120);};
for(const id of ['iso','top'])$(id).onclick=()=>{topView=id==='top';$('iso').setAttribute('aria-pressed',String(!topView));$('top').setAttribute('aria-pressed',String(topView));draw();};
$('reset').onclick=()=>{yaw=.6;pitch=.65;zoom=1;draw();};for(const id of ['stack','travel','color','custom'])$(id).onchange=()=>{legend();draw();};
canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY};};canvas.onpointermove=e=>{if(!drag)return;yaw+=(e.clientX-drag.x)*.009;pitch=Math.max(.1,Math.min(1.5,pitch+(e.clientY-drag.y)*.007));drag={x:e.clientX,y:e.clientY};draw();};canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.3,Math.min(6,zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});canvas.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setLayer(layer+(e.key==='ArrowRight'?1:-1));}};
new ResizeObserver(draw).observe(canvas);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});legend();draw();
