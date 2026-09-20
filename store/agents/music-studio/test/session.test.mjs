import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSession, secondsAt, beatAt, duplicateSection, writeSessionMidi, readSessionMidi, wavBytes } from '../template/studio/session.mjs';
import { buildMusic } from '../template/tools/build.mjs';
const { Midi } = createRequire(import.meta.url)('../template/studio/vendor/midi.js');
const root = fileURLToPath(new URL('..', import.meta.url));
const source = JSON.parse(await readFile(join(root, 'template/piece/session.json')));
test('tempo changes are integrated in both directions, including a 3/8 score', () => {
  const p = validateSession({ ...source, meter: [3, 8], tempos: [{ beat: 0, bpm: 120 }, { beat: 12, bpm: 60 }, { beat: 24, bpm: 90 }] });
  assert.equal(secondsAt(p, 24), 18);
  assert.equal(secondsAt(p, 30), 22);
  for (const beat of [0, 1.5, 11.999, 12, 20, 24, 30, 79]) assert.ok(Math.abs(beatAt(p, secondsAt(p, beat)) - beat) < 1e-10);
});
test('MIDI handoff retains notes, tempo, meter and an intentionally quiet ending', () => {
  const p = validateSession({ ...source, beats: 84, meter: [3, 4], tempos: [{ beat: 0, bpm: 100 }, { beat: 48, bpm: 80 }] });
  const bytes = writeSessionMidi(p, Midi), result = readSessionMidi(bytes, Midi), raw = new Midi(bytes);
  assert.equal(result.beats, 84); assert.deepEqual(result.meter, [3, 4]); assert.deepEqual(result.tempos, p.tempos);
  assert.equal(raw.header.meta.at(-1).ticks / raw.header.ppq, 84);
  for (let i = 0; i < p.tracks.length; i++) {
    const expected = [...p.tracks[i].notes].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
    const actual = [...result.tracks[i].notes].sort((a, b) => a.beat - b.beat || a.midi - b.midi);
    assert.equal(actual.length, expected.length);
    for (let j = 0; j < expected.length; j++) {
      assert.equal(actual[j].midi, expected[j].midi);
      for (const key of ['beat', 'duration']) assert.ok(Math.abs(actual[j][key] - expected[j][key]) <= 1 / 480);
      assert.ok(Math.abs(actual[j].velocity - expected[j].velocity) <= 1 / 127);
    }
  }
});
test('MIDI import warns about performance data it cannot reproduce', () => {
  const midi = new Midi(writeSessionMidi(validateSession(source), Midi));
  midi.tracks[0].addCC({ number: 64, ticks: 480, value: 1 });
  assert.match(readSessionMidi(midi.toArray(), Midi).importWarnings[0], /automation/);
  midi.header.timeSignatures.push({ ticks: 480, timeSignature: [3, 4] });
  assert.throws(() => readSessionMidi(midi.toArray(), Midi), /one time signature/);
});
test('repeating a passage preserves the originals and its tempo changes', () => {
  const p = validateSession({ ...source, tempos: [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 80 }, { beat: 24, bpm: 120 }] });
  const copy = duplicateSection(p, 4, 16);
  assert.equal(copy.beats, 96);
  assert.deepEqual(copy.tracks[0].notes.slice(0, p.tracks[0].notes.length), p.tracks[0].notes);
  assert.deepEqual(copy.tempos.slice(-2), [{ beat: 80, bpm: 100 }, { beat: 84, bpm: 80 }]);
  assert.ok(copy.tracks[0].notes.slice(p.tracks[0].notes.length).every(n => n.beat >= 80 && n.beat + n.duration <= 96));
});
test('invalid edits cannot silently cut notes or refer to absent recordings', () => {
  const silentNote = structuredClone(source); silentNote.tracks[0].notes[0].velocity = 0;
  assert.throws(() => validateSession(silentNote), /positive MIDI velocity/);
  for (const mutate of [p => { p.beats = 12; }, p => { p.tracks[0].notes[0].midi = 128; }, p => { p.tempos = [{ beat: 1, bpm: 120 }]; }, p => { p.tracks[0].instrument = 'sampler'; }, p => { p.tracks[0].clips = [{ assetId: 'absent', beat: 0, duration: 1, offset: 0 }]; }]) {
    const p = structuredClone(source); mutate(p); assert.throws(() => validateSession(p));
  }
});
test('PCM handoff has a standard interleaved stereo header and bounded samples', () => {
  const bytes = Buffer.from(wavBytes([new Float32Array([0, 1, -1]), new Float32Array([.5, -2, 2])], 48000));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt16LE(22), 2); assert.equal(bytes.readUInt32LE(24), 48000);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => bytes.readInt16LE(44 + i * 2)), [0, 16384, 32767, -32767, -32767, 32767]);
});
test('fresh build embeds the real score, escapes user text, rejects stale HTML and stays not-ready', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'afterhours-build-'));
  try {
    await cp(join(root, 'template'), ws, { recursive: true });
    await buildMusic(ws); await buildMusic(ws, { check: true });
    const p = structuredClone(source); p.title = 'USER $& </script> & <music>';
    await writeFile(join(ws, 'piece/session.json'), JSON.stringify(p));
    await assert.rejects(buildMusic(ws, { check: true }), /out of date/); await buildMusic(ws);
    const html = await readFile(join(ws, 'piece/index.html'), 'utf8');
    const embedded = JSON.parse(html.match(/<script id="afterhours-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(embedded.title, p.title); assert.equal(embedded.tracks.length, 5);
    assert.equal(JSON.parse(await readFile(join(ws, '.harness/verdict.json'))).ready, false);
  } finally { await rm(ws, { recursive: true, force: true }); }
});
