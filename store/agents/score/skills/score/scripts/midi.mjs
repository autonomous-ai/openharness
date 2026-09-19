// Standard MIDI File reader for note timing and a deliberately simple synth preview.
export function parseMidi(input){
  const b=Buffer.from(input);let p=0;
  const need=n=>{if(p+n>b.length)throw new Error('Truncated MIDI.');};
  const u8=()=>{need(1);return b[p++];},u16=()=>u8()*256+u8(),u32=()=>u16()*65536+u16();
  const tag=()=>String.fromCharCode(u8(),u8(),u8(),u8());
  if(tag()!=='MThd'||u32()!==6)throw new Error('Invalid MIDI header.');
  const format=u16(),count=u16(),division=u16();if(format>1||!count||count>64||!division||(division&0x8000))throw new Error('Only type 0/1 PPQ MIDI is supported.');
  const events=[],tempos=[{tick:0,tempo:500000}];let maxTick=0;
  const vlq=()=>{let v=0;for(let i=0;i<4;i++){const n=u8();v=v*128+(n&127);if(!(n&128))return v;}throw new Error('Invalid MIDI variable length.');};
  for(let track=0;track<count;track++){
    if(tag()!=='MTrk')throw new Error('Missing MIDI track.');const length=u32(),end=p+length;need(length);let tick=0,running=0;
    while(p<end){tick+=vlq();maxTick=Math.max(maxTick,tick);let status=u8();if(status<128){if(!running)throw new Error('Missing MIDI running status.');p--;status=running;}else if(status<240)running=status;
      if(status===255){const type=u8(),len=vlq();need(len);if(type===81&&len===3)tempos.push({tick,tempo:b[p]*65536+b[p+1]*256+b[p+2]});p+=len;continue;}
      if(status===240||status===247){const len=vlq();need(len);p+=len;running=0;continue;}
      const kind=status>>4,ch=status&15;if(kind<8||kind>14)throw new Error('Unsupported MIDI status.');
      const a=u8(),v=kind===12||kind===13?0:u8();if(a>127||v>127)throw new Error('Invalid MIDI data byte.');
      if(kind===8||kind===9)events.push({tick,track,ch,pitch:a,velocity:v,on:kind===9&&v>0});
      if(events.length>100000)throw new Error('MIDI preview is limited to 100,000 note events.');
    }if(p!==end)throw new Error('MIDI event exceeds its track.');
  }
  tempos.sort((a,b)=>a.tick-b.tick);let last=0,seconds=0,tempo=500000;
  for(const t of tempos){seconds+=(t.tick-last)*tempo/division/1e6;last=t.tick;tempo=t.tempo;if(!tempo)throw new Error('Invalid MIDI tempo.');t.seconds=seconds;}
  const time=tick=>{let t=tempos[0];for(const item of tempos){if(item.tick>tick)break;t=item;}return t.seconds+(tick-t.tick)*t.tempo/division/1e6;};
  events.sort((a,b)=>a.tick-b.tick);const active=new Map(),notes=[];
  for(const event of events){const key=event.track+':'+event.ch+':'+event.pitch;if(event.on){if(!active.has(key))active.set(key,[]);active.get(key).push(event);}else{const start=active.get(key)?.shift();if(start)notes.push({pitch:event.pitch,velocity:start.velocity,track:event.track,start:time(start.tick),duration:Math.max(.01,time(event.tick)-time(start.tick))});}}
  if([...active.values()].some(a=>a.length))throw new Error('MIDI contains unterminated notes.');
  if(!notes.length)throw new Error('MIDI contains no notes.');
  return {notes:notes.sort((a,b)=>a.start-b.start),duration:Math.max(time(maxTick),...notes.map(n=>n.start+n.duration)),tracks:count,tempoChanges:tempos.length-1};
}
