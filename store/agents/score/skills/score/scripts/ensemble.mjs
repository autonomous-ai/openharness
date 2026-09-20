// A saved player brief, independent of the music it is meant to constrain.
const fail = message => { throw new Error(message); };
const integer = (value, min, max, label) => Number.isInteger(value) && value >= min && value <= max || fail(label+' must be an integer from '+min+' to '+max+'.');
const string = (value, max, label) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value) || fail('Invalid '+label+'.');
const keys = new Set('c cis des d dis ees e f fis ges g gis aes a ais bes b'.split(' '));
const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
function fields(value, allowed, label) {
  if (!value || typeof value!=='object' || Array.isArray(value)) fail(label+' must be an object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('Unknown '+label+' field: '+key);
}
export function pitch(value) {
  const match = /^([A-G])([b#]?)(-1|[0-9])$/.exec(value);
  if (!match) fail('Use scientific pitches such as C4 or Bb3: '+value);
  const midi = (Number(match[3])+1)*12 + {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1]] + (match[2]==='#'?1:match[2]==='b'?-1:0);
  if (midi<0 || midi>127) fail('Pitch outside MIDI range: '+value);
  return midi;
}
export function pitchName(midi) {
  return ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'][midi%12]+(Math.floor(midi/12)-1);
}
function lilyPitch(value) {
  const [,note,accidental,octave] = /^([A-G])([b#]?)(-1|[0-9])$/.exec(value);
  const suffix = accidental==='#'?'is':accidental==='b'?'es':'';
  return note.toLowerCase()+suffix+(Number(octave)>=3?"'".repeat(Number(octave)-3):','.repeat(3-Number(octave)));
}
export function validateEnsemble(raw) {
  const spec = structuredClone(raw);
  fields(spec,['spec','title','brief','composer','assumptions','meter','quarterBpm','bars','key','sourceFiles','practice','players'],'ensemble');
  if (!spec || spec.spec!==1) fail('ensemble.json requires spec: 1.');
  string(spec.title,100,'title'); string(spec.brief,2000,'brief');
  string(spec.composer,100,'composer / credit');
  if (!Array.isArray(spec.assumptions) || spec.assumptions.length>20) fail('List assumptions explicitly, even if empty.');
  for (const text of spec.assumptions) string(text,400,'assumption');
  if (!Array.isArray(spec.meter) || spec.meter.length!==2) fail('meter must be [numerator, denominator].');
  integer(spec.meter[0],1,12,'Meter numerator');
  if (![2,4,8,16].includes(spec.meter[1])) fail('Meter denominator must be 2, 4, 8 or 16.');
  integer(spec.bars,1,128,'Bars'); integer(spec.quarterBpm,20,240,'Quarter-note tempo');
  fields(spec.key,['tonic','mode'],'key');
  if (!keys.has(spec.key?.tonic) || !['major','minor'].includes(spec.key?.mode)) fail('Specify a concert key, using LilyPond pitch spelling.');
  if (!Array.isArray(spec.sourceFiles) || !spec.sourceFiles.includes('score.ly') || !spec.sourceFiles.includes('ensemble.json') || spec.sourceFiles.length>32) fail('sourceFiles must include score.ly and ensemble.json, with at most 32 files.');
  const paths=new Set();
  for (const name of spec.sourceFiles) {
    if (typeof name!=='string' || name.length>160 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name.split('/').some(part=>!part || part==='.' || part==='..' || part.startsWith('.')) || !/\.(ly|ily|json|txt|md)$/i.test(name)) fail('Unsafe or unsupported source filename: '+name);
    if (paths.has(name.toLowerCase()) || /^(score-assets|rebuild|\.harness)(\/|$)/i.test(name) || name.toLowerCase()==='rebuild.md') fail('Duplicate or reserved source path: '+name);
    paths.add(name.toLowerCase());
  }
  if (!Array.isArray(spec.players) || !spec.players.length || spec.players.length>8) fail('Use 1–8 players.');
  const ids=new Set(), music=new Set();
  const unique = id => {
    if (typeof id!=='string' || !idPattern.test(id) || ids.has(id)) fail('Player and staff IDs must be unique, lowercase filename-safe names: '+id);
    ids.add(id);
  };
  let staffCount=0;
  for (const player of spec.players) {
    fields(player,['id','label','instrument','midiInstrument','soundingC','staves'],'player');
    unique(player.id); if (player.id==='score') fail('score is a reserved player ID.');
    string(player.label,60,'player label'); string(player.instrument,100,'instrument');
    string(player.midiInstrument,60,'MIDI instrument');
    player.writtenShift=60-pitch(player.soundingC);
    if (Math.abs(player.writtenShift)>24) fail('Transposition is limited to two octaves.');
    if (!Array.isArray(player.staves) || !player.staves.length || player.staves.length>2) fail('Each player needs one or two staves.');
    for (const staff of player.staves) {
      fields(staff,['id','music','clef','writtenRange','maxPolyphony','maxLeapSemitones','maxAttacksPerBar'],'staff');
      unique(staff.id); staffCount++;
      if (!/^[a-zA-Z]+$/.test(staff.music) || staff.music.length>60 || music.has(staff.music)) fail('Each staff needs a distinct letter-only music variable.');
      music.add(staff.music);
      if (!['treble','bass','alto','tenor'].includes(staff.clef)) fail('Supported clefs: treble, bass, alto, tenor.');
      if (!Array.isArray(staff.writtenRange) || staff.writtenRange.length!==2) fail('Each staff needs a writtenRange.');
      staff.range=staff.writtenRange.map(pitch);
      if (staff.range[0]>staff.range[1]) fail('Written range is reversed.');
      integer(staff.maxPolyphony,1,10,'Maximum polyphony');
      if (staff.maxLeapSemitones!==undefined) {
        integer(staff.maxLeapSemitones,1,24,'Maximum leap');
        if (staff.maxPolyphony!==1) fail('Leap checks apply only to monophonic staves.');
      }
      if (staff.maxAttacksPerBar!==undefined) integer(staff.maxAttacksPerBar,1,64,'Maximum attacks per bar');
    }
  }
  if (staffCount>15) fail('At most 15 pitched staves are supported.');
  fields(spec.practice,['speed','countInBars'],'practice');
  if (!Number.isFinite(spec.practice.speed) || spec.practice.speed<.25 || spec.practice.speed>1.5) fail('Practice speed must be from 0.25 to 1.5.');
  integer(spec.practice.countInBars,0,2,'Count-in bars');
  return spec;
}

// The same written-music expression feeds the printed part and the written MIDI
// proof. A separate concert proof makes incorrect or double transposition visible.
export function makeWrapper(spec, {svg=false}={}) {
  const quote = value => JSON.stringify(value);
  const global = '\\key '+spec.key.tonic+' \\'+spec.key.mode+' \\time '+spec.meter.join('/')+' \\tempo 4 = '+spec.quarterBpm;
  const staff = (player, item, mode='sounding', labeled=true) => {
    const transpose = mode==='concert' ? '' : '\\transpose '+lilyPitch(player.soundingC)+" c' ";
    const tuning = mode==='sounding' ? lilyPitch(player.soundingC) : "c'";
    return '\\new Staff = '+quote(item.id)+' \\with { instrumentName = '+quote(labeled&&player.staves.length===1?player.label:'')+' midiInstrument = '+quote(player.midiInstrument)+' } { \\clef '+quote(item.clef)+' \\transposition '+tuning+' '+transpose+' { '+global+' \\'+item.music+' } }';
  };
  const group = (player,labeled=true) => player.staves.length===1 ? staff(player,player.staves[0],'sounding',labeled) :
    '\\new PianoStaff \\with { instrumentName = '+quote(labeled?player.label:'')+' } << '+player.staves.map(item=>staff(player,item,'sounding',labeled)).join('\n')+' >>';
  const header = subtitle => '\\header { title = '+quote(spec.title)+' subtitle = '+quote(subtitle)+' composer = '+quote(spec.composer)+' tagline = ##f }';
  const book = (name, content, subtitle, printed=true) => '\\book { \\bookOutputName '+quote(name)+' '+(printed?header(subtitle):'')+' \\score { '+content+(printed?' \\layout { indent = '+(name==='score'?30:0)+'\\mm short-indent = 4\\mm }':'')+' \\midi { } } }';
  const books=[book('score','<< '+spec.players.map(player=>group(player)).join('\n')+' >>','Full score - written pitches')];
  for (const player of spec.players) {
    books.push(book('part-'+player.id,group(player,false),player.label===player.instrument?player.label:player.label+' ('+player.instrument+')'));
    // Proof MIDI is generated during the PDF pass; SVG need not duplicate it.
    if (!svg) for (const item of player.staves) for (const mode of ['concert','written']) books.push(book(mode+'-'+item.id,staff(player,item,mode),'',false));
  }
  return '\\version "2.24.3"\n\\include "source/score.ly"\n\\paper { #(set-paper-size "a4") top-margin = 16\\mm bottom-margin = 16\\mm left-margin = 18\\mm right-margin = 18\\mm print-page-number = ##t }\n'+books.join('\n')+'\n';
}

function noteKey(note, division, shift=0) {
  return [note.pitch+shift,Math.round(note.startTick/division*1e6),Math.round(note.endTick/division*1e6)].join(':');
}
export function sameNotes(a, b, shift=0) {
  return JSON.stringify(a.notes.map(n=>noteKey(n,a.division,shift)).sort())===JSON.stringify(b.notes.map(n=>noteKey(n,b.division)).sort());
}
export function checkEnsemble(spec, full, proofs, parts) {
  const checks=[], notes=[], staves=[];
  const add=(id,passed,detail)=>checks.push({id,passed:!!passed,detail});
  const length = midi => Math.abs(midi.endTick/midi.division-spec.bars*spec.meter[0]*4/spec.meter[1])<1e-7;
  const timing = (name,midi) => {
    add(name+':duration',length(midi),spec.bars+' complete bars, measured from MIDI end-of-track (including rests)');
    add(name+':tempo',midi.tempos.length===1 && Math.abs(midi.tempos[0].tempo-60e6/spec.quarterBpm)<1.1,'Constant quarter-note tempo '+spec.quarterBpm);
    add(name+':meter',midi.meters.length>0 && midi.meters.every(m=>m.tick===0 && m.numerator===spec.meter[0] && m.denominator===spec.meter[1]),'Constant '+spec.meter.join('/')+' meter; pickups and meter changes need a different workflow');
  };
  timing('score',full);
  for (const player of spec.players) {
    const playerNotes=[];
    for (const staff of player.staves) {
      const {concert,written}=proofs[staff.id];
      timing(staff.id,concert); timing(staff.id+'-written',written);
      add(staff.id+':transposition',sameNotes(concert,written,player.writtenShift),'Written pitches = concert pitches '+(player.writtenShift>=0?'+':'')+player.writtenShift+' semitones');
      const pitches=written.notes.map(n=>n.pitch), low=pitches.length?Math.min(...pitches):null, high=pitches.length?Math.max(...pitches):null;
      add(staff.id+':range',pitches.every(n=>n>=staff.range[0] && n<=staff.range[1]),'Written '+(low===null?'rests only':pitchName(low)+'–'+pitchName(high))+'; allowed '+staff.writtenRange.join('–'));
      let active=0, maximum=0;
      const events=written.notes.flatMap(n=>[{tick:n.startTick,delta:1},{tick:n.endTick,delta:-1}]).sort((a,b)=>a.tick-b.tick || a.delta-b.delta);
      for (const event of events) { active+=event.delta; maximum=Math.max(maximum,active); }
      add(staff.id+':polyphony',maximum<=staff.maxPolyphony,'Maximum simultaneous notes '+maximum+'; allowed '+staff.maxPolyphony);
      add(staff.id+':note-duration',written.notes.every(n=>n.endTick>n.startTick),'Every note has positive MIDI duration; zero-time grace notes are not supported');
      if (staff.maxLeapSemitones!==undefined) {
        const leaps=written.notes.slice(1).map((n,i)=>Math.abs(n.pitch-written.notes[i].pitch)), largest=Math.max(0,...leaps);
        add(staff.id+':leaps',largest<=staff.maxLeapSemitones,'Largest successive-note leap '+largest+' semitones; allowed '+staff.maxLeapSemitones);
      }
      if (staff.maxAttacksPerBar!==undefined) {
        const bars=new Map();
        for (const note of written.notes) {
          const bar=Math.floor(note.startTick/written.division/(spec.meter[0]*4/spec.meter[1])+1e-8);
          if (!bars.has(bar)) bars.set(bar,new Set());
          bars.get(bar).add(note.startTick);
        }
        const maximum=Math.max(0,...[...bars.values()].map(set=>set.size));
        add(staff.id+':attacks',maximum<=staff.maxAttacksPerBar,'Most distinct attacks in a bar '+maximum+'; allowed '+staff.maxAttacksPerBar);
      }
      add(staff.id+':program',new Set(concert.notes.map(n=>n.program)).size<=1,'Practice exports use one instrument program per staff');
      for (const note of concert.notes) {
        const item={...note,staff:staff.id,player:player.id,startTick:Math.round(note.startTick/concert.division*full.division),endTick:Math.round(note.endTick/concert.division*full.division)};
        notes.push(item); playerNotes.push(item);
      }
      staves.push({id:staff.id,player:player.id,range:[low,high],allowed:staff.writtenRange,notes:pitches.length,maxPolyphony:maximum,writtenShift:player.writtenShift});
    }
    timing('part-'+player.id,parts[player.id]);
    add(player.id+':part-sounds',sameNotes({notes:playerNotes,division:full.division},parts[player.id]),'Separate part MIDI agrees with the independent concert-pitch source');
  }
  add('score:notes',sameNotes({notes,division:full.division},full),'Full-score MIDI equals every independent concert-pitch staff, with no missing or extra notes');
  return {checks,staves,notes:notes.sort((a,b)=>a.startTick-b.startTick || a.pitch-b.pitch)};
}
