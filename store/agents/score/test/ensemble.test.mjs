import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateEnsemble,validateMusicSources,pitch,makeWrapper,checkEnsemble} from '../skills/score/scripts/ensemble.mjs';
import {parseMidi,writePracticeMidi} from '../skills/score/scripts/midi.mjs';
import {snapshotSources,build} from '../skills/score/scripts/build.mjs';
import {zip} from '../skills/score/scripts/archive.mjs';

const template=JSON.parse(await readFile(new URL('../template/ensemble.json',import.meta.url)));
const single=()=>{
  const value=structuredClone(template);value.players=[value.players[1]];value.meter=[4,4];value.bars=1;value.quarterBpm=80;
  return validateEnsemble(value);
};
const note={pitch:60,startTick:0,endTick:384,velocity:80,program:71,staff:'clarinet-line',track:1};
const midi=(notes=[note],endTick=1536)=>parseMidi(writePracticeMidi({notes,division:384,endTick,quarterBpm:80,meter:[4,4]}),{allowEmpty:true});
const checked=(concert,written,part=concert,full=concert)=>checkEnsemble(single(),full,{'clarinet-line':{concert,written}},{clarinet:part});
test('pitch spelling, octave and transposition contract are explicit',()=>{
  assert.equal(pitch('C4'),60);assert.equal(pitch('Bb3'),58);assert.equal(pitch('F#5'),78);
  assert.throws(()=>pitch('B#9'),/outside/);
  const spec=validateEnsemble(template);assert.equal(spec.players[1].writtenShift,2);
  const wrapper=makeWrapper(spec);
  assert.match(wrapper,/\\transposition bes \\transpose bes c'/);
  assert.match(wrapper,/\\bookOutputName "written-clarinet-line"/);
});
test('bad limits, duplicate IDs, source traversal and reserved paths are rejected',()=>{
  for(const mutate of [
    s=>s.players[1].id=s.players[0].id,
    s=>s.players[0].id='score',
    s=>s.players[0].staves[0].music='foo }',
    s=>s.players[0].staves[0].writtenRange=['G5','C4'],
    s=>s.players[0].staves[0].maxPolyphony=0,
    s=>s.players[0].staves[0].maxPolyphony=2,
    s=>s.sourceFiles.push('../private.json'),
    s=>s.sourceFiles.push('Score.ly'),
    s=>s.sourceFiles.push('REBUILD.md'),
    s=>s.sourceFiles.push('rebuild/build.mjs'),
    s=>s.meter=[4,3],
    s=>s.practice.countInBars=3,
    s=>s.players[0].staves[0].maxAtacksPerBar=2,
    s=>s.title='title\n\\include "private"'
  ]){const candidate=structuredClone(template);mutate(candidate);assert.throws(()=>validateEnsemble(candidate));}
});
test('measured range, polyphony, attacks, leap and duration failures do not relax the brief',()=>{
  const concert=midi(),written=midi([{...note,pitch:62}]);
  assert.ok(checked(concert,written).checks.every(check=>check.passed));
  assert.ok(checked(concert,concert).checks.some(check=>check.id.endsWith(':transposition')&&!check.passed));
  const high=midi([{...note,pitch:90}]);assert.ok(checked(high,midi([{...note,pitch:92}])).checks.some(check=>check.id.endsWith(':range')&&!check.passed));
  const chord=midi([note,{...note,pitch:64}]),writtenChord=midi([{...note,pitch:62},{...note,pitch:66}]);
  assert.ok(checked(chord,writtenChord).checks.some(check=>check.id.endsWith(':polyphony')&&!check.passed));
  assert.ok(checked(midi([note],768),written).checks.some(check=>check.id.endsWith(':duration')&&!check.passed));
  const leap=[note,{...note,pitch:72,startTick:768,endTick:1152}];
  assert.ok(checked(midi(leap),midi(leap.map(n=>({...n,pitch:n.pitch+2})))).checks.some(check=>check.id.endsWith(':leaps')&&!check.passed));
  const busy=Array.from({length:5},(_,i)=>({...note,startTick:i*96,endTick:i*96+48}));
  assert.ok(checked(midi(busy),midi(busy.map(n=>({...n,pitch:n.pitch+2})))).checks.some(check=>check.id.endsWith(':attacks')&&!check.passed));
  assert.ok(checked(concert,written,midi([{...note,pitch:61}])).checks.some(check=>check.id==='clarinet:part-sounds'&&!check.passed));
});
test('slow practice preserves notes, changes tempo, shifts for count-in and reserves percussion channel',()=>{
  const notes=Array.from({length:15},(_,i)=>({...note,staff:'staff-'+i,pitch:50+i}));
  const bytes=writePracticeMidi({notes,division:384,endTick:1536,quarterBpm:80,meter:[4,4],countInBars:1,speed:.5}),parsed=parseMidi(bytes);
  assert.equal(parsed.endTick,3072);assert.equal(parsed.tempos[0].tempo,1500000);
  assert.equal(parsed.notes.filter(n=>n.channel===9).length,4);
  const pitched=parsed.notes.filter(n=>n.channel!==9);
  assert.equal(new Set(pitched.map(n=>n.channel)).size,15);assert.equal(pitched.length,15);
  assert.deepEqual(pitched.map(n=>[n.pitch,n.startTick,n.endTick,n.program]),notes.map(n=>[n.pitch,1536,1920,71]));
  const compound=parseMidi(writePracticeMidi({notes:[note],division:384,endTick:1152,quarterBpm:90,meter:[6,8],countInBars:1}));
  assert.equal(compound.notes.filter(n=>n.channel===9).length,2);
  assert.throws(()=>writePracticeMidi({notes:[{...note,velocity:200}],division:384,endTick:1536,quarterBpm:80,meter:[4,4]}),/note/);
  assert.throws(()=>writePracticeMidi({notes,division:384,endTick:1536,quarterBpm:80,meter:[4,3]}),/meter/);
  const silence=parseMidi(writePracticeMidi({notes:[],division:384,endTick:1536,quarterBpm:80,meter:[4,4]}),{allowEmpty:true});
  assert.equal(silence.notes.length,0);assert.equal(silence.duration,3);
});
test('checked source rejects ambiguous bar grids and wrapper overrides, without treating comments or strings as commands',()=>{
  const validate=code=>validateMusicSources([{name:'score.ly',bytes:Buffer.from(code)}]);
  for(const command of ['\\partial 4','\\repeat volta 2 { c1 }','\\cadenzaOn','\\time 3/4','\\tempo 4 = 99','\\clef "treble_8"','\\transposition c','\\score { c1 }'])assert.throws(()=>validate('music = { '+command+' }'),/owned|complete-bar/);
  assert.doesNotThrow(()=>validate('% \\partial 4\nmusic = { \\repeat unfold 2 { c1 } ^"A caption about \\\\time" }\n%{ \\repeat volta 2 %}'));
});
test('MIDI rejects events that escape a track, missing end events and trailing bytes',()=>{
  const bytes=writePracticeMidi({notes:[note],division:384,endTick:1536,quarterBpm:80,meter:[4,4]});
  const shortened=Buffer.from(bytes);shortened.writeUInt32BE(2,18);
  assert.throws(()=>parseMidi(shortened),/Truncated/);
  assert.throws(()=>parseMidi(Buffer.concat([bytes,Buffer.from([0])])),/Unexpected/);
  const aligned=writePracticeMidi({notes:[{...note,endTick:1536}],division:384,endTick:1536,quarterBpm:80,meter:[4,4]});
  const noEnd=aligned.subarray(0,-4);noEnd.writeUInt32BE(noEnd.length-22,18);
  assert.throws(()=>parseMidi(noEnd),/end event/);
});
test('source allowlist rejects omitted includes and symlinks; build lock remains owned',async()=>{
  const root=await mkdtemp(join(tmpdir(),'score-source-'));
  try {
    await writeFile(join(root,'score.ly'),'\\include "private.ily"\n');
    await assert.rejects(snapshotSources(root,{sourceFiles:['score.ly']}),/sourceFiles/);
    await writeFile(join(root,'voice.ILY'),'\\include "private.ily"\n');
    await assert.rejects(snapshotSources(root,{sourceFiles:['voice.ILY']}),/sourceFiles/);
    await writeFile(join(root,'private.ily'),'music = { c1 }');
    assert.equal((await snapshotSources(root,{sourceFiles:['score.ly','private.ily']})).length,2);
    await symlink(join(root,'private.ily'),join(root,'linked.ily'));
    await assert.rejects(snapshotSources(root,{sourceFiles:['linked.ily']}),/symlink/);
    await mkdir(join(root,'.harness','score-build.lock'),{recursive:true});
    await writeFile(join(root,'.harness','verdict.json'),'owned');
    await assert.rejects(build(root),/Another build/);
    assert.equal(await readFile(join(root,'.harness','verdict.json'),'utf8'),'owned');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('ZIP builder rejects traversal and case collisions and writes real ZIP headers',()=>{
  const bytes=zip([{name:'score.ly',bytes:Buffer.from('music')},{name:'parts/flute.pdf',bytes:Buffer.from('%PDF-')}]);
  assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length-12),2);
  assert.throws(()=>zip([{name:'../secret',bytes:Buffer.from('bad')}]),/Unsafe/);
  assert.throws(()=>zip([{name:'A',bytes:Buffer.alloc(0)},{name:'a',bytes:Buffer.alloc(0)}]),/duplicate/);
});
