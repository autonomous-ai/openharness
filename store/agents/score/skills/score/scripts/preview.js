const $=id=>document.getElementById(id), data=JSON.parse($('config').textContent), midi=data.midi, spec=data.ensemble;
const colors=['#8eaf80','#deb375','#82acbe','#ba97bd','#bf907d','#a5aa6a','#93abb8','#c39797'];
const mixes=new Map(data.players.map(player=>[player.id,{muted:false,solo:false,gain:1}]));
const fmt=seconds=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
const barSeconds=spec?spec.meter[0]*4/spec.meter[1]*60/spec.quarterBpm:null;
const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
$('title').textContent=data.title; document.title=data.title+' · Folio';
$('brief').textContent=spec?.brief||'A local engraved score and a synthetic sketch of its exported notes.';
$('badge').textContent=data.checked?spec.bars+' bars · '+data.players.length+' players · '+data.checks.length+' checks passed':'Legacy engraving · player brief not checked';
$('duration').textContent=fmt(Math.round(midi.duration)); $('seek').max=midi.duration;
$('revision').textContent='SOURCE '+data.sourceRevision.slice(0,12);
$('project').hidden=!data.checked; $('loop-controls').hidden=!spec;
$('checks-title').textContent=data.checked?'The brief meets the notes.':'Engraving only.';
$('practice-description').textContent=spec?'Download note-only MIDI at '+spec.practice.speed+'× speed, with '+spec.practice.countInBars+' count-in bar(s). “Without” leaves room for the missing player. Browser mix changes do not alter these files.':'Add ensemble.json to prepare checked individual parts and practice exports.';
for (const doc of data.documents) {
  const option=text('option',doc.label); option.value=doc.id; $('document').append(option);
}
function showDocument() {
  const doc=data.documents.find(item=>item.id===$('document').value);
  $('pages').replaceChildren(); $('pdf').href=doc.pdf;
  $('pdf').textContent=doc.id==='score'?'Print full score ↓':'Print this part ↓';
  for (const [i,path] of doc.pages.entries()) {
    const image=document.createElement('img'); image.src=path; image.alt=doc.label+', engraved page '+(i+1); $('pages').append(image);
  }
  $('pages').dataset.document=doc.id;
}
$('document').onchange=showDocument; showDocument();
$('zoom').onchange=()=>{$('pages').style.width=$('zoom').value+'%';};
for (const item of data.practice) {
  const link=text('a',item.label+' ↓'); link.href=item.path; link.download=''; $('practice').append(link);
}
for (const item of data.staves) {
  const player=data.players.find(p=>p.id===item.player), row=document.createElement('div'); row.className='check';
  row.append(text('b',player.label+' · '+item.allowed.join('–')),text('span',item.notes+' notes · '+(item.writtenShift?'written '+(item.writtenShift>0?'+':'')+item.writtenShift+' semitones from concert pitch':'concert-pitch notation')));
  $('ranges').append(row);
}
for (const check of data.checks) {
  const row=document.createElement('div'); row.className='check';
  row.append(text('b',(check.passed?'✓ ':'✕ ')+check.id),text('span',check.detail)); $('checks').append(row);
}
for (const assumption of spec?.assumptions||[]) $('assumptions').append(text('li',assumption));
if(spec){$('loop-start').max=spec.bars;$('loop-end').max=spec.bars;$('loop-end').value=Math.min(4,spec.bars);}
function audible(id) {
  const mix=mixes.get(id); return !mix.muted && (![...mixes.values()].some(item=>item.solo) || mix.solo);
}
function color(id){return colors[data.players.findIndex(player=>player.id===id)%colors.length];}
for (const player of data.players) {
  const row=document.createElement('div'); row.className='player'; row.dataset.player=player.id;
  const label=text('b',player.label), dot=document.createElement('span'); dot.className='dot'; dot.style.background=color(player.id); label.prepend(dot); row.append(label);
  for (const [key,title] of [['muted','Mute'],['solo','Solo']]) {
    const button=text('button',title); button.dataset.control=key; button.setAttribute('aria-label',title+' '+player.label); button.setAttribute('aria-pressed','false');
    button.onclick=()=>{mixes.get(player.id)[key]=!mixes.get(player.id)[key];syncMix();rearm();}; row.append(button);
  }
  const gain=document.createElement('input'); gain.type='range';gain.min=0;gain.max=1;gain.step=.05;gain.value=1;gain.setAttribute('aria-label',player.label+' volume');
  gain.oninput=()=>{mixes.get(player.id).gain=Number(gain.value);rearm();}; row.append(gain); $('players').append(row);
}
function syncMix() {
  for(const row of $('players').children){
    const mix=mixes.get(row.dataset.player);
    for(const button of row.querySelectorAll('button'))button.setAttribute('aria-pressed',String(mix[button.dataset.control]));
    row.querySelector('input').value=mix.gain;
    row.dataset.audible=String(audible(row.dataset.player));
  }
  draw();
}
let audio,master,playing=false,position=0,origin=0,originTime=0,speed=1,index=0,voices=new Set(),held=[];
const rawTime=()=>playing?origin+(audio.currentTime-originTime)*speed:position;
const bounds=()=>spec&&$('loop').checked?[(Number($('loop-start').value)-1)*barSeconds,Number($('loop-end').value)*barSeconds]:[0,midi.duration];
const now=()=>Math.max(originTime&&playing?origin:0,Math.min(bounds()[1],rawTime()));
function silence() { for(const voice of voices){try{voice.stop();}catch{}} voices.clear(); }
function pause() {
  position=now(); playing=false; silence(); $('play').textContent='▶ Listen'; $('play').setAttribute('aria-pressed','false'); $('status').textContent='Paused'; draw();
}
function output(context,volume) {
  const gain=context.createGain(),compressor=context.createDynamicsCompressor();
  gain.gain.value=volume; compressor.threshold.value=-8;compressor.knee.value=8;compressor.ratio.value=12;
  gain.connect(compressor);compressor.connect(context.destination);return gain;
}
function tone(context,destination,note,when,duration,level,live=false) {
  if(duration<=0 || level<=0)return;
  const oscillator=context.createOscillator(),gain=context.createGain(),end=when+duration;
  oscillator.type='triangle'; oscillator.frequency.value=440*2**((note.pitch-69)/12);
  const peak=note.velocity/127*.10*level,attack=Math.min(.012,duration/4),release=Math.min(.03,duration/3);
  gain.gain.setValueAtTime(0,when); gain.gain.linearRampToValueAtTime(peak,when+attack);
  gain.gain.linearRampToValueAtTime(peak*.6,Math.max(when+attack,end-release));gain.gain.linearRampToValueAtTime(0,end);
  oscillator.connect(gain);gain.connect(destination);oscillator.start(when);oscillator.stop(end+.002);
  if(live)voices.add(oscillator);
  oscillator.onended=()=>{voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};
}
function click(context,destination,when,accent,live=false) {
  tone(context,destination,{pitch:accent?91:86,velocity:100},when,.055,.8,live);
}
function countIn(context,destination,start,tempoSpeed,live=false) {
  if(!spec)return;
  const compound=spec.meter[1]===8 && spec.meter[0]>=6 && spec.meter[0]%3===0, pulses=spec.meter[0]/(compound?3:1);
  for(let beat=0;beat<pulses;beat++)click(context,destination,start+beat*barSeconds/pulses/tempoSpeed,beat===0,live);
}
function arm(at,time) {
  silence();origin=position=at;originTime=time;
  index=midi.notes.findIndex(note=>note.start>=at-1e-8);if(index<0)index=midi.notes.length;
  held=midi.notes.filter(note=>note.start<at-1e-8 && note.start+note.duration>at);
  for(const note of held)if(audible(note.player))tone(audio,master,note,time,Math.min(note.start+note.duration-at,bounds()[1]-at)/speed,mixes.get(note.player).gain,true);
}
async function play(withCountIn=true) {
  try {
    if(!audio){audio=new AudioContext();master=output(audio,Number($('volume').value));}
    await audio.resume();
    const [start,end]=bounds(); if(position<start || position>=end)position=start;
    const count=withCountIn&&spec&&$('count-in').checked?barSeconds/speed:0;
    arm(position,audio.currentTime+.025+count);
    if(count)countIn(audio,master,audio.currentTime+.025,speed,true);
    playing=true;$('play').textContent='Ⅱ Pause';$('play').setAttribute('aria-pressed','true');$('error').textContent='';
    schedule();draw();
  }catch(error){$('error').textContent='Audio unavailable: '+error.message;if(playing)pause();}
}
function rearm() {
  if(playing){const at=now();arm(at,audio.currentTime+.015);}draw();
}
function seek(value) {
  const [start,end]=bounds();position=Math.max(start,Math.min(end,Number(value)));
  if(playing)arm(position,audio.currentTime+.015);draw();
}
function loopChanged() {
  const a=Number($('loop-start').value), b=Number($('loop-end').value);
  if(!Number.isInteger(a)||!Number.isInteger(b)||a<1||b<a||b>spec.bars){
    $('error').textContent='Choose complete bars from 1 to '+spec.bars+', with the last bar at or after the first.';
    $('loop').checked=false;rearm();return;
  }
  $('error').textContent=''; const at=now(), [start,end]=bounds();seek(at<start||at>=end?start:at);
}
$('play').onclick=()=>playing?pause():void play();
$('restart').onclick=()=>seek(bounds()[0]);
$('seek').oninput=()=>seek($('seek').value);
$('speed').oninput=()=>{const at=now();speed=Number($('speed').value);$('speed-value').textContent=speed.toFixed(2)+'×';if(playing)arm(at,audio.currentTime+.015);};
$('volume').oninput=()=>{if(master)master.gain.setTargetAtTime(Number($('volume').value),audio.currentTime,.02);};
for(const id of ['loop','loop-start','loop-end'])$(id).onchange=loopChanged;
function schedule() {
  if(!playing)return;
  const [start,end]=bounds(), raw=rawTime();
  if(raw>=end) {
    if(spec&&$('loop').checked){arm(start,audio.currentTime+.01);}
    else{pause();position=midi.duration;$('status').textContent='Finished';draw();return;}
  }
  $('status').textContent=rawTime()<origin?'Count-in…':'Playing synthetic sketch';
  while(index<midi.notes.length && midi.notes[index].start<Math.min(end,rawTime()+.15*speed)){
    const note=midi.notes[index++];if(!audible(note.player))continue;
    const when=Math.max(audio.currentTime,originTime+(note.start-origin)/speed),until=originTime+(Math.min(note.start+note.duration,end)-origin)/speed;
    tone(audio,master,note,when,until-when,mixes.get(note.player).gain,true);
  }
}
setInterval(schedule,25);
const canvas=$('roll'),g=canvas.getContext('2d'),low=Math.min(...midi.notes.map(n=>n.pitch))-2,high=Math.max(...midi.notes.map(n=>n.pitch))+2;
function draw() {
  const w=canvas.clientWidth,h=canvas.clientHeight,ratio=Math.min(devicePixelRatio||1,2);
  canvas.width=w*ratio;canvas.height=h*ratio;g.scale(ratio,ratio);
  const t=now();
  if(spec&&$('loop').checked){const [a,b]=bounds();g.fillStyle='#345643';g.fillRect(a/midi.duration*w,0,(b-a)/midi.duration*w,h);}
  g.fillStyle='#4a6452';const divisions=spec?.bars||8;
  for(let i=0;i<divisions;i++)g.fillRect(i*w/divisions,0,1,h);
  for(const note of midi.notes){
    g.globalAlpha=audible(note.player)?1:.15;
    g.fillStyle=note.start<=t&&note.start+note.duration>t?'#f7ddb0':color(note.player);
    g.fillRect(note.start/midi.duration*w,(high-note.pitch)/(high-low)*h,Math.max(2,note.duration/midi.duration*w-1),Math.max(2,h/(high-low)-1));
  }
  g.globalAlpha=1;g.fillStyle='#fff5dc';g.fillRect(t/midi.duration*w,0,1.5,h);
  $('position').textContent=fmt(t);$('seek').value=t;
  $('bar-position').textContent=spec?'BAR '+Math.min(spec.bars,Math.floor(t/barSeconds)+1)+' / '+spec.bars:'';
  canvas.dataset.position=t.toFixed(3);canvas.dataset.playing=String(playing);canvas.dataset.voices=voices.size;canvas.dataset.held=held.length;
}
function download(blob,name){
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function settings(){
  return {spec:1,sourceRevision:data.sourceRevision,speed,volume:Number($('volume').value),position:now(),loop:!!spec&&$('loop').checked,firstBar:Number($('loop-start').value),lastBar:Number($('loop-end').value),countIn:!!spec&&$('count-in').checked,document:$('document').value,mix:Object.fromEntries(mixes)};
}
$('save-settings').onclick=()=>download(new Blob([JSON.stringify(settings(),null,2)+'\n'],{type:'application/json'}),'folio-listening.json');
$('restore-settings').onclick=()=>$('load-settings').click();
$('load-settings').onchange=async()=>{
  try{
    const file=$('load-settings').files[0];if(!file)return;if(file.size>32768)throw new Error('Setup file is too large.');
    const saved=JSON.parse(await file.text());
    if(saved.spec!==1||saved.sourceRevision!==data.sourceRevision)throw new Error('This listening setup belongs to a different source revision.');
    if(!Number.isFinite(saved.speed)||saved.speed<.25||saved.speed>1.5||!Number.isFinite(saved.volume)||saved.volume<0||saved.volume>1||!Number.isFinite(saved.position)||saved.position<0||saved.position>midi.duration)throw new Error('Invalid listening values.');
    if(!data.documents.some(doc=>doc.id===saved.document)||typeof saved.loop!=='boolean'||typeof saved.countIn!=='boolean')throw new Error('Invalid score selection.');
    if(spec&&(!Number.isInteger(saved.firstBar)||!Number.isInteger(saved.lastBar)||saved.firstBar<1||saved.lastBar<saved.firstBar||saved.lastBar>spec.bars))throw new Error('Invalid loop range.');
    for(const player of data.players){
      const mix=saved.mix?.[player.id];
      if(!mix||typeof mix.muted!=='boolean'||typeof mix.solo!=='boolean'||!Number.isFinite(mix.gain)||mix.gain<0||mix.gain>1)throw new Error('Invalid player mix.');
    }
    if(playing)pause();speed=saved.speed;position=saved.position;
    $('speed').value=speed;$('speed-value').textContent=speed.toFixed(2)+'×';$('volume').value=saved.volume;
    if(master)master.gain.value=saved.volume;
    $('loop').checked=saved.loop;$('count-in').checked=saved.countIn;
    $('loop-start').value=saved.firstBar;$('loop-end').value=saved.lastBar;$('document').value=saved.document;
    for(const player of data.players)mixes.set(player.id,{...saved.mix[player.id]});
    showDocument();syncMix();seek(position);$('status').textContent='Listening setup restored';$('error').textContent='';
  }catch(error){$('error').textContent=error.message;}finally{$('load-settings').value='';}
};
$('audio-export').onclick=async()=>{
  const button=$('audio-export');button.disabled=true;$('error').textContent='';
  try{
    const [start,end]=bounds(),factor=speed,count=spec&&$('count-in').checked?barSeconds/factor:0,duration=(end-start)/factor+count;
    if(duration>180)throw new Error('WAV exports are limited to 3 minutes. Select a shorter bar loop or a faster speed.');
    if(![...mixes.keys()].some(id=>audible(id)&&mixes.get(id).gain>0)||Number($('volume').value)===0)throw new Error('The mix is silent. Unmute a voice and raise its volume.');
    const context=new OfflineAudioContext(1,Math.ceil((duration+.01)*22050),22050),destination=output(context,Number($('volume').value));
    for(const note of midi.notes){
      if(!audible(note.player)||note.start>=end||note.start+note.duration<=start)continue;
      const from=Math.max(start,note.start),to=Math.min(end,note.start+note.duration);
      tone(context,destination,note,(from-start)/factor+count,(to-from)/factor,mixes.get(note.player).gain);
    }
    if(count)countIn(context,destination,0,factor);
    button.textContent='Rendering audio…';
    const rendered=await context.startRendering(),samples=rendered.getChannelData(0),bytes=new ArrayBuffer(44+samples.length*2),view=new DataView(bytes);
    const ascii=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
    ascii(0,'RIFF');view.setUint32(4,36+samples.length*2,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,22050,true);view.setUint32(28,44100,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
    download(new Blob([bytes],{type:'audio/wav'}),(data.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'folio')+'-sketch.wav');
    $('status').textContent='WAV sketch saved';
  }catch(error){$('error').textContent=error.message;}finally{button.disabled=false;button.textContent='Save this mix as WAV ↓';}
};
function frame(){if(playing)draw();requestAnimationFrame(frame);}
new ResizeObserver(draw).observe(canvas);syncMix();draw();requestAnimationFrame(frame);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing)pause();});
