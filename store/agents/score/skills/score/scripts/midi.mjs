// Standard MIDI File timing, track identity and note-only practice exports.
// Controllers/pedal/bend are deliberately not presented as a faithful performance.
export function tickSeconds(tick, midi) {
  let tempo = midi.tempos[0];
  for (const item of midi.tempos) { if (item.tick > tick) break; tempo = item; }
  return tempo.seconds + (tick - tempo.tick) * tempo.tempo / midi.division / 1e6;
}

export function parseMidi(input, {allowEmpty=false}={}) {
  const bytes = Buffer.from(input);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('MIDI exceeds 16 MiB.');
  let p=0, limit=bytes.length, eventCount=0;
  const need = n => { if (p+n > limit) throw new Error('Truncated MIDI or event exceeds its track.'); };
  const u8 = () => { need(1); return bytes[p++]; };
  const u16 = () => u8()*256+u8();
  const u32 = () => u16()*65536+u16();
  const tag = () => String.fromCharCode(u8(),u8(),u8(),u8());
  const vlq = () => {
    let value=0;
    for (let i=0;i<4;i++) { const byte=u8(); value=value*128+(byte&127); if (!(byte&128)) return value; }
    throw new Error('Invalid MIDI variable length.');
  };
  if (tag() !== 'MThd' || u32() !== 6) throw new Error('Invalid MIDI header.');
  const format=u16(), count=u16(), division=u16();
  if (format>1 || !count || count>64 || !division || division&0x8000 || format===0 && count!==1) throw new Error('Only type 0/1 PPQ MIDI is supported.');
  const events=[], rawTempos=[{tick:0,tempo:500000}], meters=[], trackInfo=[];
  let maxTick=0;
  for (let track=0;track<count;track++) {
    if (tag() !== 'MTrk') throw new Error('Missing MIDI track.');
    const length=u32(); need(length); const end=p+length; limit=end;
    let tick=0, running=0, ended=false;
    const programs=new Map(), info={index:track,name:'Track '+track,endTick:0};
    while (p<end) {
      if (++eventCount>200000) throw new Error('MIDI exceeds 200,000 events.');
      tick+=vlq(); maxTick=Math.max(maxTick,tick);
      let status=u8();
      if (status<128) { if (!running) throw new Error('Missing MIDI running status.'); p--; status=running; }
      else if (status<240) running=status;
      if (status===255) {
        running=0;
        const type=u8(), len=vlq(); need(len);
        if (type===81) {
          if (len!==3) throw new Error('Invalid MIDI tempo event.');
          rawTempos.push({tick,tempo:bytes[p]*65536+bytes[p+1]*256+bytes[p+2]});
          if (rawTempos.length>1024) throw new Error('Too many MIDI tempo changes.');
        }
        if (type===88) {
          if (len!==4 || !bytes[p] || bytes[p+1]>7) throw new Error('Invalid MIDI meter.');
          meters.push({tick,numerator:bytes[p],denominator:2**bytes[p+1]});
        }
        if (type===3) info.name=bytes.subarray(p,p+len).toString('utf8');
        if (type===47) {
          if (len!==0 || p!==end) throw new Error('Invalid MIDI end-of-track.');
          ended=true;
        }
        p+=len; continue;
      }
      if (status===240 || status===247) { const len=vlq(); need(len); p+=len; running=0; continue; }
      const kind=status>>4, channel=status&15;
      if (kind<8 || kind>14) throw new Error('Unsupported MIDI status.');
      const a=u8(), b=kind===12 || kind===13 ? 0 : u8();
      if (a>127 || b>127) throw new Error('Invalid MIDI data byte.');
      if (kind===12) programs.set(channel,a);
      if (kind===8 || kind===9) events.push({tick,track,channel,pitch:a,velocity:b,on:kind===9 && b>0,program:programs.get(channel)||0});
    }
    if (!ended) throw new Error('MIDI track has no end event.');
    info.endTick=tick; trackInfo.push(info); limit=bytes.length;
  }
  if (p!==bytes.length) throw new Error('Unexpected bytes after MIDI tracks.');
  // At the same tick the last encoded tempo wins, replacing the implicit default.
  const tempos=[...new Map(rawTempos.map(t=>[t.tick,t])).values()].sort((a,b)=>a.tick-b.tick);
  let last=0, seconds=0, tempo=500000;
  for (const item of tempos) {
    if (!item.tempo) throw new Error('Invalid MIDI tempo.');
    seconds+=(item.tick-last)*tempo/division/1e6;
    last=item.tick; tempo=item.tempo; item.seconds=seconds;
  }
  const timing={tempos,division}, time=tick=>tickSeconds(tick,timing);
  events.sort((a,b)=>a.tick-b.tick);
  const active=new Map(), notes=[];
  for (const event of events) {
    const key=event.track+':'+event.channel+':'+event.pitch;
    if (event.on) {
      if (!active.has(key)) active.set(key,[]);
      active.get(key).push(event);
    } else {
      const start=active.get(key)?.shift();
      if (start) notes.push({pitch:event.pitch,velocity:start.velocity,track:event.track,
        channel:event.channel,program:start.program,startTick:start.tick,endTick:event.tick,
        start:time(start.tick),duration:time(event.tick)-time(start.tick)});
    }
  }
  if ([...active.values()].some(list=>list.length)) throw new Error('MIDI contains unterminated notes.');
  if (!allowEmpty && !notes.length) throw new Error('MIDI contains no notes.');
  return {notes:notes.sort((a,b)=>a.startTick-b.startTick || a.pitch-b.pitch),duration:time(maxTick),
    tracks:count,trackInfo,division,endTick:maxTick,tempos,meters,tempoChanges:tempos.length-1};
}

function variable(value) {
  if (!Number.isInteger(value) || value<0 || value>0x0fffffff) throw new Error('MIDI delta is out of range.');
  const bytes=[value&127];
  while ((value=Math.floor(value/128))) bytes.unshift((value&127)|128);
  return bytes;
}
function chunk(name, data) {
  const header=Buffer.alloc(8); header.write(name); header.writeUInt32BE(data.length,4);
  return Buffer.concat([header,Buffer.from(data)]);
}

export function writePracticeMidi({notes,division,endTick,quarterBpm,meter,countInBars=0,speed=1}) {
  if (!Number.isInteger(division) || division<1 || division>32767) throw new Error('Invalid PPQ.');
  if (!Number.isFinite(quarterBpm) || !(quarterBpm>=20 && quarterBpm<=240) || !Number.isFinite(speed) || !(speed>=.25 && speed<=1.5)) throw new Error('Invalid practice tempo.');
  if (!Array.isArray(meter) || meter.length!==2 || !Number.isInteger(meter[0]) || meter[0]<1 || meter[0]>12 || ![2,4,8,16].includes(meter[1])) throw new Error('Invalid practice meter.');
  if (!Number.isInteger(countInBars) || countInBars<0 || countInBars>2 || !Number.isInteger(endTick) || endTick<=0 || endTick>0x0fffffff || !Array.isArray(notes) || notes.length>10000) throw new Error('Invalid practice length or note count.');
  const barTicks=division*meter[0]*4/meter[1], offset=Math.round(countInBars*barTicks);
  const tempo=Math.round(60e6/(quarterBpm*speed));
  const groups=[...new Set(notes.map(note=>note.staff || String(note.track)))];
  if (groups.length>15) throw new Error('Practice MIDI supports at most 15 pitched staves.');
  const channels=[0,1,2,3,4,5,6,7,8,10,11,12,13,14,15];
  const list=[{tick:0,order:0,bytes:[255,81,3,tempo>>16&255,tempo>>8&255,tempo&255]},
    {tick:0,order:0,bytes:[255,88,4,meter[0],Math.log2(meter[1]),24,8]}];
  for (const [i,group] of groups.entries()) {
    const voice=notes.filter(note=>(note.staff || String(note.track))===group), channel=channels[i];
    list.push({tick:0,order:0,bytes:[192|channel,voice[0].program||0]});
    for (const note of voice) {
      if (!Number.isInteger(note.pitch) || note.pitch<0 || note.pitch>127 ||
          !Number.isInteger(note.startTick) || !Number.isInteger(note.endTick) ||
          note.startTick<0 || note.endTick<=note.startTick || note.endTick>endTick ||
          !Number.isInteger(note.velocity) || note.velocity<1 || note.velocity>127 ||
          !Number.isInteger(note.program) || note.program<0 || note.program>127) throw new Error('Invalid practice note.');
      list.push({tick:note.startTick+offset,order:2,bytes:[144|channel,note.pitch,note.velocity||64]},
        {tick:note.endTick+offset,order:1,bytes:[128|channel,note.pitch,0]});
    }
  }
  const pulse=division*4/meter[1]*(meter[1]===8 && meter[0]>=6 && meter[0]%3===0 ? 3 : 1);
  for (let tick=0;tick<offset;tick+=pulse) {
    list.push({tick:Math.round(tick),order:2,bytes:[153,tick%barTicks===0?76:77,85]},
      {tick:Math.round(tick+Math.min(division/8,pulse/3)),order:1,bytes:[137,tick%barTicks===0?76:77,0]});
  }
  list.push({tick:endTick+offset,order:3,bytes:[255,47,0]});
  list.sort((a,b)=>a.tick-b.tick || a.order-b.order);
  let previous=0; const encoded=[];
  for (const event of list) { encoded.push(...variable(event.tick-previous),...event.bytes); previous=event.tick; }
  const header=Buffer.alloc(6); header.writeUInt16BE(0,0); header.writeUInt16BE(1,2); header.writeUInt16BE(division,4);
  return Buffer.concat([chunk('MThd',header),chunk('MTrk',encoded)]);
}
