import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp,readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from '../skills/score/scripts/build.mjs';
import {parseMidi} from '../skills/score/scripts/midi.mjs';
const bin=process.env.LILYPOND_BIN, root=fileURLToPath(new URL('..',import.meta.url));
const retained=process.env.SCORE_QA_ROOT;
async function workspace(t,name,source) {
  if(retained)await mkdir(retained,{recursive:true});
  const ws=await mkdtemp(join(retained||tmpdir(),'score-'+name+'-'));
  await cp(source,ws,{recursive:true});
  if(!retained)t.after(()=>rm(ws,{recursive:true,force:true}));
  else t.diagnostic('Retained native fixture: '+ws);
  return ws;
}
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
test('native trio: printed parts, written Bb range, full/solo/minus-one exports and portable rebuild',{skip:!bin},async t=>{
  const ws=await workspace(t,'trio',join(root,'template'));
  const result=await build(ws,{bin});
  assert.equal(result.checked,true);assert.equal(result.checks.length,55);
  assert.ok(result.checks.every(check=>check.passed));assert.equal(result.documents.length,4);
  assert.equal(result.staves.find(staff=>staff.id==='clarinet-line').writtenShift,2);
  assert.deepEqual(result.staves.find(staff=>staff.id==='clarinet-line').range,[66,74]);
  assert.equal(result.durationSeconds,31.999968);
  const config=JSON.parse((await readFile(join(ws,'score.html'),'utf8')).match(/id="config">([^<]+)<\/script>/)[1]);
  const full=parseMidi(await readFile(join(ws,'score.midi')));
  for(const player of result.ensemble.players){
    const part=parseMidi(await readFile(join(ws,'score-assets','part-'+player.id+'.midi')));
    assert.equal(part.notes.length,config.midi.notes.filter(n=>n.player===player.id).length);
    for(const [prefix,selected] of [['solo-',config.midi.notes.filter(n=>n.player===player.id)],['minus-',config.midi.notes.filter(n=>n.player!==player.id)]]){
      const exported=parseMidi(await readFile(join(ws,'score-assets',prefix+player.id+'.midi')),{allowEmpty:true});
      assert.deepEqual(exported.notes.filter(n=>n.channel!==9).map(n=>n.pitch).sort((a,b)=>a-b),selected.map(n=>n.pitch).sort((a,b)=>a-b));
      assert.equal(exported.notes.filter(n=>n.channel===9).length,2);
    }
  }
  const extracted=join(ws,'.harness','extracted');await mkdir(extracted);
  const unzip=spawnSync('unzip',['-q',join(ws,'score-project.zip'),'-d',extracted],{encoding:'utf8'});
  assert.equal(unzip.status,0,unzip.stderr);
  assert.equal(await digest(join(ws,'score.ly')),await digest(join(extracted,'score.ly')));
  const run=spawnSync(process.execPath,[join(extracted,'rebuild','build.mjs'),extracted],{env:{...process.env,LILYPOND_BIN:bin},encoding:'utf8',timeout:120000});
  assert.equal(run.status,0,run.stdout+run.stderr);
  assert.equal((await readJson(join(extracted,'.harness','score.json'))).sourceRevision,result.sourceRevision);
  assert.deepEqual(parseMidi(await readFile(join(extracted,'score.midi'))).notes,full.notes);
  const zipCheck=spawnSync('unzip',['-t',join(ws,'score-project.zip')],{encoding:'utf8'});
  assert.equal(zipCheck.status,0,zipCheck.stdout+zipCheck.stderr);
});
test('native duet: easier flute revision, failed candidate, preserved piano, rebuild and history',{skip:!bin},async t=>{
  const ws=await workspace(t,'duet',join(root,'test','fixtures','duet'));
  const original=await build(ws,{bin}), originalMidi=parseMidi(await readFile(join(ws,'score.midi')));
  assert.equal(original.checks.length,49);assert.equal(original.documents.length,3);
  const piano=await digest(join(ws,'score-assets','part-piano.midi')),zip=await digest(join(ws,'score-project.zip'));
  const contract=await readJson(join(ws,'ensemble.json'));
  contract.brief='Keep the piano and eight-bar shape; lower the flute ceiling to E5 and use at most three attacks per bar.';
  const flute=contract.players[0].staves[0];flute.writtenRange=['C5','E5'];flute.maxAttacksPerBar=3;
  await writeFile(join(ws,'ensemble.json'),JSON.stringify(contract,null,2)+'\n');
  await assert.rejects(build(ws,{bin}),/flute-line:range/);
  assert.equal((await readJson(join(ws,'.harness','verdict.json'))).ready,false);
  assert.equal(await digest(join(ws,'score-project.zip')),zip);
  assert.equal(await digest(join(ws,'score-assets','part-piano.midi')),piano);
  const source=await readFile(join(ws,'score.ly'),'utf8');
  const revised=source.replace(/fluteMusic = [\s\S]*?\n}/,'fluteMusic = \\relative c\'\' {\n c2\\p( d4 e) | e2( d4) r4 |\n d2( e4 d) | e2( d4) r4 \\breathe \\break |\n c2\\mp( d4 e) | e2( d4 c) |\n d2( e4 d) | c1\\pp \\bar "|."\n}');
  assert.notEqual(revised,source);await writeFile(join(ws,'score.ly'),revised);
  const result=await build(ws,{bin});assert.ok(result.checks.every(check=>check.passed));
  assert.notEqual(result.sourceRevision,original.sourceRevision);
  assert.equal(await digest(join(ws,'score-assets','part-piano.midi')),piano);
  assert.equal(parseMidi(await readFile(join(ws,'score.midi'))).endTick,originalMidi.endTick);
  assert.equal(await digest(join(result.previousArtifacts,'score-project.zip')),zip);
  assert.equal((await readJson(join(ws,'ensemble.json'))).players[0].staves[0].writtenRange[1],'E5');
});
test('native rejects overridden transposition, wrong length, polyphony and source mutation without replacing good output',{skip:!bin},async t=>{
  const ws=await workspace(t,'negative',join(root,'template'));
  await build(ws,{bin});
  const source=await readFile(join(ws,'score.ly'),'utf8'),good=await digest(join(ws,'score.pdf'));
  for(const [name,candidate,pattern] of [
    ['transposition',source.replace("clarinetMusic = \\relative c' {","clarinetMusic = \\relative c' { \\set Staff.instrumentTransposition = #(ly:make-pitch 0 0)"),/part-sounds|score:notes/],
    ['length',source.replace('c2.\\pp \\bar "|."','c2.\\pp c2. \\bar "|."'),/duration/],
    ['polyphony',source.replace('c4.\\p( e8 d c)','<c e>4.\\p( e8 d c)'),/polyphony/]
  ]){
    await writeFile(join(ws,'score.ly'),candidate);await assert.rejects(build(ws,{bin}),pattern,name);
    assert.equal(await digest(join(ws,'score.pdf')),good);
    assert.equal((await readJson(join(ws,'.harness','verdict.json'))).ready,false);
  }
  const mutation='\n#(call-with-output-file '+JSON.stringify(join(ws,'score.ly'))+' (lambda (port) (display "% changed during native build" port)))\n';
  await writeFile(join(ws,'score.ly'),source+mutation);
  await assert.rejects(build(ws,{bin}),/Source changed/);
  assert.equal(await digest(join(ws,'score.pdf')),good);
});
test('native legacy score remains audible and printable without claiming the ensemble brief was checked',{skip:!bin},async t=>{
  const ws=await workspace(t,'legacy',join(root,'test','fixtures','legacy'));
  const result=await build(ws,{bin});
  assert.equal(result.checked,false);assert.equal(result.title,'Lighthouse at Dusk');
  assert.equal(result.notes,142);assert.equal(result.documents.length,1);
  const verdict=await readJson(join(ws,'.harness','verdict.json'));
  assert.equal(verdict.ready,false);assert.equal(verdict.artifact,'score.html');
  assert.equal((await readFile(join(ws,'score.pdf'))).subarray(0,5).toString(),'%PDF-');
});
