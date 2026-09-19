const $=id=>document.getElementById(id),data=JSON.parse($('config').textContent),midi=data.midi;
$('title').textContent=data.title;$('page-count').textContent=data.pages.length;$('note-count').textContent=midi.notes.length;
for(const [i,page]of data.pages.entries()){const img=document.createElement('img');img.src=page;img.alt='Engraved score, page '+(i+1);$('pages').append(img);}
const fmt=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
$('duration').textContent=fmt(midi.duration);$('seek').max=midi.duration;
let audio,master,playing=false,position=0,origin=0,originTime=0,speed=1,index=0,voices=new Set();
const now=()=>playing?Math.min(midi.duration,origin+(audio.currentTime-originTime)*speed):position;
function silence(){for(const voice of voices){try{voice.stop();}catch{}}voices.clear();}
function pause(){position=now();playing=false;silence();$('play').textContent='Play sketch';$('play').setAttribute('aria-pressed','false');$('status').textContent='Paused';draw();}
async function play(){
 try{if(!audio){audio=new AudioContext();master=audio.createGain();master.gain.value=Number($('volume').value);master.connect(audio.destination);}await audio.resume();if(position>=midi.duration)position=0;origin=position;originTime=audio.currentTime;index=midi.notes.findIndex(n=>n.start>=position-.001);if(index<0)index=midi.notes.length;playing=true;$('play').textContent='Pause';$('play').setAttribute('aria-pressed','true');$('status').textContent='Playing MIDI sketch';$('error').textContent='';}
 catch(error){$('error').textContent='Audio unavailable: '+error.message;pause();}
}
function sound(note,when,duration){
 const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.type='triangle';oscillator.frequency.value=440*2**((note.pitch-69)/12);
 const peak=Math.min(.1,note.velocity/127*.09),end=when+Math.max(.03,duration);gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(peak,when+.012);gain.gain.exponentialRampToValueAtTime(Math.max(.0001,peak*.35),Math.max(when+.02,end-.03));gain.gain.linearRampToValueAtTime(0,end+.07);oscillator.connect(gain);gain.connect(master);oscillator.start(when);oscillator.stop(end+.08);voices.add(oscillator);oscillator.onended=()=>{voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};
}
function seek(value){const was=playing;if(was)pause();position=Math.max(0,Math.min(midi.duration,Number(value)));if(was)void play();draw();}
$('play').onclick=()=>playing?pause():void play();$('restart').onclick=()=>seek(0);$('seek').oninput=()=>seek($('seek').value);$('speed').oninput=()=>{const was=playing;if(was)pause();speed=Number($('speed').value);$('speed-value').textContent=speed.toFixed(2)+'×';if(was)void play();};$('volume').oninput=()=>{if(master)master.gain.setTargetAtTime(Number($('volume').value),audio.currentTime,.03);};$('zoom').oninput=()=>{$('pages').style.width=$('zoom').value+'%';};
const canvas=$('roll'),g=canvas.getContext('2d'),low=Math.min(...midi.notes.map(n=>n.pitch))-2,high=Math.max(...midi.notes.map(n=>n.pitch))+2;
function draw(){const w=canvas.clientWidth,h=canvas.clientHeight,ratio=Math.min(devicePixelRatio||1,2);canvas.width=w*ratio;canvas.height=h*ratio;g.scale(ratio,ratio);g.fillStyle='#27493d';for(let i=0;i<9;i++)g.fillRect(i*w/8,0,1,h);const t=now();for(const n of midi.notes){g.fillStyle=n.start<=t&&n.start+n.duration>t?'#f3cc8e':n.track%2?'#97bba1':'#d7d7a2';g.fillRect(n.start/midi.duration*w,(high-n.pitch)/(high-low)*h,Math.max(2,n.duration/midi.duration*w-1),Math.max(2,h/(high-low)-1));}g.fillStyle='#fff6d8';g.fillRect(t/midi.duration*w,0,1.5,h);$('position').textContent=fmt(t);$('seek').value=t;canvas.dataset.position=t.toFixed(3);canvas.dataset.playing=String(playing);}
setInterval(()=>{if(!playing)return;const t=now();while(index<midi.notes.length&&midi.notes[index].start<t+.16*speed){const n=midi.notes[index++];sound(n,Math.max(audio.currentTime,originTime+(n.start-origin)/speed),n.duration/speed);}if(t>=midi.duration){pause();position=midi.duration;$('status').textContent='Finished';}},40);
function frame(){if(playing)draw();requestAnimationFrame(frame);}new ResizeObserver(draw).observe(canvas);draw();requestAnimationFrame(frame);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing)pause();});
