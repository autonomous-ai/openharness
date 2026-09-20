// Original acceptance brief: a 48-second documentary title cue. This is source,
// not a style menu. Replace it with your own composition for a different brief.
import { writeFile } from 'node:fs/promises';
import { musicRandom } from '../studio/session.mjs';
const rnd = musicRandom('blue-hour');
const p = {
  spec: 'afterhours/1', id: 'blue-hour', title: 'Blue Hour',
  brief: 'A 48-second title cue for a coastal documentary. An intimate plucked motif opens into warm harmony and a restrained pulse, then resolves quietly. The arrangement leaves space for a voiceover.',
  seed: 'blue-hour', tempo: 100, meter: [4, 4], beats: 80, tail: 0, master: .9,
  sections: ['First light', 'Footsteps', 'Open water', 'The lift', 'Home'].map((name, i) => ({ name, beat: i * 16, length: 16 })),
  tracks: [
    { id: 'motif', name: 'Plucked motif', instrument: 'pluck', gain: .92, pan: -.22, tone: 7200, space: .18, delay: .12, release: .35, notes: [] },
    { id: 'felt', name: 'Felt melody', instrument: 'felt', gain: .7, pan: .15, tone: 5200, space: .24, release: .75, notes: [] },
    { id: 'pad', name: 'Warm horizon', instrument: 'pad', gain: .24, pan: 0, tone: 1600, attack: .55, space: .35, release: .9, notes: [] },
    { id: 'bass', name: 'Low tide', instrument: 'bass', gain: .55, pan: 0, tone: 1100, space: .02, release: .20, notes: [] },
    { id: 'pulse', name: 'Soft pulse', instrument: 'drums', gain: .4, pan: .04, tone: 12000, space: .06, release: .05, notes: [] }
  ], assets: []
};
function note(track, beat, midi, duration, velocity) {
  if (beat + duration > 79.1) return;
  p.tracks[track].notes.push({ beat, midi, duration, velocity: Math.min(1, velocity * (.92 + rnd() * .12)) });
}
const chords = [[50, 57, 61, 66], [47, 54, 57, 62], [43, 50, 54, 59], [45, 52, 57, 61]];
const melody = [[74, 73, 69, 66], [73, 69, 66, 62], [71, 69, 66, 62], [69, 73, 76, 73]];
for (let bar = 0; bar < 20; bar++) {
  const b = bar * 4, chord = chords[Math.floor(bar / 2) % 4], ending = bar >= 18, energy = ending ? .60 : bar >= 12 && bar < 16 ? 1 : .8;
  const steps = bar < 4 ? [0, 1.5, 3] : ending ? [0, 2] : [0, .75, 1.5, 2, 2.75, 3.5];
  steps.forEach((step, i) => note(0, b + step, chord[(i + bar % 2) % 4] + 12, .55 + (i % 3 === 0 ? .35 : 0), .7 * energy));
  if (bar >= 4 && bar < 18 && bar % 2 === 0) chord.slice(1).forEach((pitch, i) => note(2, b + i * .045, pitch + 12, 7.5, .5 * energy));
  if (bar >= 8 && bar < 18) { note(3, b, chord[0] - 12, 2.7, .75 * energy); if (bar % 2) note(3, b + 3, chord[0] - 12, .75, .42); }
  if (bar >= 8 && bar < 16) {
    note(4, b, 36, .15, .62); note(4, b + 2.5, 36, .15, .37); note(4, b + 2, 38, .12, .28);
    for (let step = .5; step < 4; step += .5) note(4, b + step, 42, .08, (step % 1 ? .36 : .2) * energy);
  }
  if (bar >= 4 && bar % 2 === 0 && bar < 18) melody[Math.floor(bar / 2) % 4].forEach((pitch, i) => note(1, b + [0, 1.5, 3, 5.5][i], pitch, [1.1, .8, 1.7, 1.8][i], .5 + (i === 2 ? .12 : 0)));
}
[50, 57, 62, 66].forEach((pitch, i) => note(1, 76 + i * .09, pitch + 12, 2.7 - i * .1, .36));
note(0, 77.5, 74, 1.4, .36);
await writeFile(new URL('session.json', import.meta.url), JSON.stringify(p, null, 2) + '\n');
console.log('Composed Blue Hour: 48 seconds, five parts, five editable tracks.');
