// Original acceptance fixtures authored for two different briefs. No user recordings
// or existing songs are represented here. Running this only updates examples/.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { validateSession, writeSessionMidi, readSessionMidi } from '../template/studio/session.mjs';
const { Midi } = createRequire(import.meta.url)('../template/studio/vendor/midi.cjs');
const save = async (name, p) => { const dir = new URL(name + '/', import.meta.url); await mkdir(dir, { recursive: true }); await writeFile(new URL('session.json', dir), JSON.stringify(validateSession(p), null, 2) + '\n'); };
const note = (p, track, beat, midi, duration, velocity) => p.tracks[track].notes.push({ beat, midi, duration, velocity });
const orbit = {
  spec: 'afterhours/1', id: 'orbit-runner', title: 'Orbit Runner',
  brief: 'A 30-second instrumental title cue for a retro space puzzle game. Establish a distinctive syncopated hook, build momentum, break down briefly, then land on a clear final accent. Bright electronic voices and a dry rhythm section; no documentary pads.',
  seed: 'orbit-original', tempo: 128, meter: [4, 4], beats: 64, tail: 0, master: .86,
  sections: [{ name: 'Signal', beat: 0, length: 8 }, { name: 'Launch', beat: 8, length: 24 }, { name: 'Zero gravity', beat: 32, length: 16 }, { name: 'Arrival', beat: 48, length: 16 }],
  tracks: [
    { id: 'hook', name: 'Navigation hook', instrument: 'lead', gain: .63, tone: 5400, attack: .005, release: .07, delay: .11, space: .04, notes: [] },
    { id: 'arp', name: 'Orbit fragments', instrument: 'bell', gain: .37, pan: .3, tone: 8800, release: .10, space: .08, notes: [] },
    { id: 'bass', name: 'Engine', instrument: 'bass', gain: .68, tone: 1800, release: .09, space: 0, notes: [] },
    { id: 'kit', name: 'Dry rhythm', instrument: 'drums', gain: .56, tone: 13000, space: 0, notes: [] },
  ]
};
const roots = [45, 45, 53, 48, 50, 53, 52, 45], hook = [69, 76, 72, 71, 69, 64];
for (let bar = 0; bar < 16; bar++) {
  const b = bar * 4, root = roots[Math.floor(bar / 2)], sparse = bar >= 8 && bar < 10;
  if (bar < 15) [0, .75, 1.5, 2.25, 3, 3.5].forEach((step, i) => { if (!sparse || i < 2) note(orbit, 0, b + step, hook[(i + (bar >= 12 ? 2 : 0)) % 6] + (bar >= 12 ? 12 : 0), i === 5 ? .3 : .35, i === 0 ? .8 : .58); });
  if (bar >= 2 && bar < 15) for (let i = 0; i < (sparse ? 1 : 4); i++) note(orbit, 2, b + i + (i % 2 ? .25 : 0), root - 12, .48, i === 0 ? .8 : .65);
  if (bar >= 4 && bar < 15 && !sparse) [0.5, 1.75, 2.5, 3.75].forEach((step, i) => note(orbit, 1, b + step, root + 24 + [0, 7, 12, 10][i], .18, .46));
  if (bar >= 2 && bar < 15 && !sparse) {
    [0, 1.75, 2.5].forEach(step => note(orbit, 3, b + step, 36, .12, .75));
    [1, 3].forEach(step => note(orbit, 3, b + step, 38, .10, .56));
    for (let i = 0; i < 8; i++) note(orbit, 3, b + i / 2, 42, .05, i % 2 ? .43 : .26);
  }
}
[69, 72, 76].forEach((pitch, i) => note(orbit, 0, 60 + i * .25, pitch, 1.1 - i * .25, .68));
note(orbit, 2, 60, 33, 1.6, .8); note(orbit, 3, 60, 36, .15, .8);
await save('orbit-runner', orbit);

const melody = {
  spec: 'afterhours/1', id: 'keepsake-melody', title: 'Keepsake — supplied melody fixture', brief: 'Original MIDI input fixture: a small waltz theme with a slower second half.',
  tempo: 72, tempos: [{ beat: 0, bpm: 72 }, { beat: 18, bpm: 60 }], meter: [3, 4], beats: 36, tail: 0,
  tracks: [{ id: 'melody', name: 'Approved melody', instrument: 'felt', notes: [] }]
};
const phrase = [[0, 67, 1.5], [1.5, 69, .5], [2, 71, .75], [3, 74, 2.4], [6, 72, 1], [7, 71, 1], [8, 69, .8], [9, 67, 2.4], [12, 64, 1.4], [13.5, 67, .8], [15, 66, 2.6]];
for (const [beat, pitch, length] of phrase) note(melody, 0, beat, pitch, length, beat % 3 === 0 ? .62 : .48);
for (const [beat, pitch, length] of phrase) note(melody, 0, beat + 18, beat === 15 ? 67 : pitch, length, beat % 3 === 0 ? .56 : .43);
const input = writeSessionMidi(validateSession(melody), Midi);
const keepsake = readSessionMidi(input, Midi);
Object.assign(keepsake, { id: 'keepsake', title: 'Keepsake', tail: 0, master: .9, seed: 'keepsake-original', brief: 'Arrange the supplied waltz melody for a 33-second family film interlude. Preserve every melody note and both tempos. Add an understated three-beat accompaniment, a low foundation and a small final answer; leave room for narration.', sections: [{ name: 'A memory', beat: 0, length: 18 }, { name: 'Coming home', beat: 18, length: 18 }] });
Object.assign(keepsake.tracks[0], { gain: .8, pan: -.08, space: .22, release: .4, tone: 6500 });
keepsake.tracks.push({ id: 'left-hand', name: 'Waltz accompaniment', instrument: 'felt', gain: .4, pan: -.23, space: .12, release: .3, notes: [] }, { id: 'cello-role', name: 'Low foundation', instrument: 'bass', gain: .24, tone: 800, release: .25, space: .06, notes: [] }, { id: 'answer', name: 'Final answer', instrument: 'bell', gain: .24, pan: .27, release: .45, space: .2, notes: [] });
const harmony = [[43, 59, 62], [47, 59, 62], [48, 60, 64], [43, 59, 62], [40, 59, 64], [38, 57, 60]];
for (let bar = 0; bar < 12; bar++) {
  const b = bar * 3, chord = bar === 11 ? [43, 59, 62] : harmony[bar % 6];
  note(keepsake, 1, b, chord[0] + 12, .8, .43);
  for (const step of [1, 2]) for (const pitch of chord.slice(1)) note(keepsake, 1, b + step, pitch, .6, .32);
  if (bar % 2 === 0 || bar === 11) note(keepsake, 2, b, chord[0], 2.5, .5);
}
[74, 71, 67].forEach((pitch, i) => note(keepsake, 3, 30 + i * 1.5, pitch, .9, .4));
await save('keepsake', keepsake);
await writeFile(new URL('keepsake/input-melody.mid', import.meta.url), input);
console.log('Composed Orbit Runner (30s, 4/4) and Keepsake (33s, 3/4, imported MIDI + tempo changes).');
