export const MUSIC_SPEC = 'afterhours/1';
export const instruments = { felt: 'Felt keys', pluck: 'Plucked strings', pad: 'Analog pad', bass: 'Round bass', bell: 'Glass bells', lead: 'Soft lead', drums: 'Drum kit', sampler: 'Your sample', audio: 'Audio recording' };
export const midiPrograms = { felt: 0, pluck: 24, pad: 89, bass: 33, bell: 11, lead: 80, drums: 0, sampler: 0, audio: 0 };
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
export function validateSession(input) {
  const p = structuredClone(input);
  if (!p || p.spec !== MUSIC_SPEC) throw new Error('Open an Afterhours project.');
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(p.id)) throw new Error('Project needs a stable id.');
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 160 || typeof p.brief !== 'string' || p.brief.length > 6000) throw new Error('Name the piece and its brief.');
  p.seed = String(p.seed ?? '1').slice(0, 128);
  if (!finite(p.tempo, 30, 240)) throw new Error('Tempo must be 30–240 BPM.');
  p.tempos ??= [{ beat: 0, bpm: p.tempo }];
  if (!Array.isArray(p.tempos) || !p.tempos.length || p.tempos.length > 200 || p.tempos[0].beat !== 0) throw new Error('Tempo map must begin at beat zero.');
  for (let i = 0; i < p.tempos.length; i++) if (!finite(p.tempos[i].beat, 0, 4096) || !finite(p.tempos[i].bpm, 30, 240) || i && p.tempos[i].beat <= p.tempos[i - 1].beat) throw new Error('Tempo changes must be ordered and valid.');
  p.tempo = p.tempos[0].bpm;
  p.meter ??= [4, 4];
  if (!Array.isArray(p.meter) || !Number.isInteger(p.meter[0]) || !finite(p.meter[0], 1, 12) || ![2, 4, 8, 16].includes(p.meter[1])) throw new Error('Invalid time signature.');
  if (!finite(p.beats, 1, 4096) || secondsAt(p, p.beats) > 240) throw new Error('Keep a piece within four minutes; split longer work into movements.');
  p.master ??= .85; if (!finite(p.master, 0, 1)) throw new Error('Invalid master level.');
  p.tail ??= 1.5; if (!finite(p.tail, 0, 6)) throw new Error('Use a tail of 0–6 seconds.');
  p.assets ??= [];
  const assets = new Set();
  if (!Array.isArray(p.assets) || p.assets.length > 16) throw new Error('Use at most 16 audio assets.');
  for (const a of p.assets) {
    if (typeof a.id !== 'string' || assets.has(a.id) || typeof a.name !== 'string' || a.name.length > 200 || typeof a.data !== 'string' || !/^data:(audio\/[a-z0-9.+-]+|application\/octet-stream);base64,[a-zA-Z0-9+/=]+$/i.test(a.data)) throw new Error('Audio assets must be embedded recordings.');
    assets.add(a.id);
  }
  if (!Array.isArray(p.tracks) || !p.tracks.length || p.tracks.length > 16) throw new Error('Use 1–16 tracks.');
  const trackIds = new Set(); let noteCount = 0;
  for (const t of p.tracks) {
    if (typeof t.id !== 'string' || trackIds.has(t.id) || typeof t.name !== 'string' || t.name.length > 120 || !Object.hasOwn(instruments, t.instrument)) throw new Error('Invalid track.');
    trackIds.add(t.id);
    const defaults = { gain: .7, pan: 0, muted: false, solo: false, attack: .008, release: .25, tone: 8000, space: .12, delay: 0, sampleRoot: 60 };
    for (const [key, value] of Object.entries(defaults)) t[key] ??= value;
    for (const [key, low, high] of [['gain', 0, 1.5], ['pan', -1, 1], ['attack', .001, 3], ['release', .01, 3], ['tone', 100, 20000], ['space', 0, .8], ['delay', 0, .6], ['sampleRoot', 0, 127]]) if (!finite(t[key], low, high)) throw new Error(`Invalid ${t.name}: ${key}.`);
    if (typeof t.muted !== 'boolean' || typeof t.solo !== 'boolean') throw new Error('Invalid mute/solo state.');
    if (t.midiProgram !== undefined && (!Number.isInteger(t.midiProgram) || !finite(t.midiProgram, 0, 127))) throw new Error('Invalid MIDI program.');
    t.notes ??= []; t.clips ??= [];
    if (!Array.isArray(t.notes) || !Array.isArray(t.clips) || t.clips.length > 100) throw new Error('Invalid track events.');
    noteCount += t.notes.length;
    for (const n of t.notes) if (!finite(n.beat, 0, p.beats) || !finite(n.duration, 1 / 32767, p.beats) || n.beat + n.duration > p.beats + 1e-6 || !Number.isInteger(n.midi) || !finite(n.midi, 0, 127) || !finite(n.velocity, 1 / 127, 1)) throw new Error(`Invalid note in ${t.name}. Use a positive MIDI velocity (at least 1/127); mute the track for silence.`);
    if (t.instrument === 'audio' && t.notes.length) throw new Error('Choose an instrument to play MIDI notes on this track.');
    if (t.instrument === 'sampler' && !assets.has(t.sampleId)) throw new Error(`Choose a sample for ${t.name}.`);
    for (const c of t.clips) {
      c.gain ??= 1; c.fadeIn ??= .02; c.fadeOut ??= .05;
      if (!assets.has(c.assetId) || !finite(c.beat, 0, p.beats) || !finite(c.offset, 0, 240) || !finite(c.duration, .01, 240) || !finite(c.gain, 0, 1.5) || !finite(c.fadeIn, 0, c.duration) || !finite(c.fadeOut, 0, c.duration)) throw new Error(`Invalid audio clip in ${t.name}.`);
      if (secondsAt(p, c.beat) + c.duration > secondsAt(p, p.beats) + .001) throw new Error(`Extend the arrangement to fit ${t.name}'s recording.`);
    }
  }
  if (noteCount > 16000) throw new Error('Use at most 16,000 notes per piece.');
  p.sections ??= [{ name: 'Piece', beat: 0, length: p.beats }];
  if (!Array.isArray(p.sections) || p.sections.length > 64) throw new Error('Invalid arrangement sections.');
  for (const s of p.sections) if (typeof s.name !== 'string' || s.name.length > 80 || !finite(s.beat, 0, p.beats) || !finite(s.length, .01, p.beats) || s.beat + s.length > p.beats + 1e-6) throw new Error('Sections must fit inside the piece.');
  if (JSON.stringify(p).length > 28000000) throw new Error('Keep the project under 28 MB. For long recordings, import an MP3 or a shorter WAV.');
  return p;
}
export function beatsPerBar(p) { return p.meter[0] * 4 / p.meter[1]; }
export function secondsAt(p, beat) {
  const map = p.tempos || [{ beat: 0, bpm: p.tempo }]; let seconds = 0;
  for (let i = 0; i < map.length && map[i].beat < beat; i++) seconds += (Math.min(beat, map[i + 1]?.beat ?? beat) - map[i].beat) * 60 / map[i].bpm;
  return seconds;
}
export function beatAt(p, seconds) {
  const map = p.tempos || [{ beat: 0, bpm: p.tempo }]; let elapsed = 0;
  for (let i = 0; i < map.length; i++) {
    const length = ((map[i + 1]?.beat ?? Infinity) - map[i].beat) * 60 / map[i].bpm;
    if (elapsed + length >= seconds) return map[i].beat + (seconds - elapsed) * map[i].bpm / 60;
    elapsed += length;
  }
  return 0;
}
export function noteName(n) { return ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] + (Math.floor(n / 12) - 1); }
export function noteNumber(name) {
  if (typeof name === 'number') return name;
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error('Use a pitch such as C4, F#3 or Bb5.');
  return (Number(m[3]) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[m[1].toUpperCase()] + (['#', '♯'].includes(m[2]) ? 1 : ['b', '♭'].includes(m[2]) ? -1 : 0);
}
export function musicRandom(seed) {
  let n = 2166136261; for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return () => { n += 0x6d2b79f5; let t = Math.imul(n ^ n >>> 15, n | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function activeTracks(p) { const solo = p.tracks.some(t => t.solo); return p.tracks.filter(t => !t.muted && (!solo || t.solo)); }
export function duplicateSection(p, start, length) {
  if (!finite(start, 0, p.beats) || !finite(length, .25, p.beats) || start + length > p.beats) throw new Error('Select a section within the piece.');
  const next = structuredClone(p), destination = p.beats;
  for (const t of next.tracks) {
    const notes = t.notes.filter(n => n.beat >= start && n.beat < start + length).map(n => ({ ...n, beat: n.beat - start + destination, duration: Math.min(n.duration, start + length - n.beat) }));
    const clips = t.clips.filter(c => c.beat >= start && c.beat < start + length).map(c => ({ ...c, beat: c.beat - start + destination, duration: Math.min(c.duration, secondsAt(p, start + length) - secondsAt(p, c.beat)) }));
    t.notes.push(...notes); t.clips.push(...clips);
  }
  next.beats += length;
  const initial = p.tempos.filter(t => t.beat <= start).at(-1).bpm;
  if (next.tempos.at(-1).bpm !== initial) next.tempos.push({ beat: destination, bpm: initial });
  next.tempos.push(...p.tempos.filter(t => t.beat > start && t.beat < start + length).map(t => ({ beat: destination + t.beat - start, bpm: t.bpm })));
  next.sections.push({ name: 'New section', beat: destination, length });
  return validateSession(next);
}
export function writeSessionMidi(p, MidiClass) {
  if (p.tracks.filter(t => t.notes.length && t.instrument !== 'drums').length > 15) throw new Error('MIDI has 15 melodic channels plus drums. Combine a melodic track or export WAV stems.');
  const midi = new MidiClass(); midi.header.name = p.title;
  midi.header.tempos = p.tempos.map(t => ({ ticks: Math.round(t.beat * midi.header.ppq), bpm: t.bpm }));
  // Standard markers preserve section cues and intentional silence at the end.
  // The encoder otherwise ends the file at the final note-off.
  midi.header.meta = [...p.sections.map(s => ({ ticks: Math.round(s.beat * midi.header.ppq), type: 'marker', text: s.name })), { ticks: Math.round(p.beats * midi.header.ppq), type: 'marker', text: 'Afterhours: end' }];
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: p.meter }]; midi.header.update();
  let channel = 0;
  for (const t of p.tracks.filter(t => t.notes.length)) {
    const track = midi.addTrack(); track.name = t.name;
    if (channel === 9) channel++;
    track.channel = t.instrument === 'drums' ? 9 : channel++ % 16;
    track.instrument.number = t.midiProgram ?? midiPrograms[t.instrument];
    track.addCC({ number: 7, ticks: 0, value: Math.min(1, t.gain) }); track.addCC({ number: 10, ticks: 0, value: (t.pan + 1) / 2 });
    for (const n of t.notes) track.addNote({ midi: n.midi, ticks: Math.round(n.beat * midi.header.ppq), durationTicks: Math.max(1, Math.round(n.duration * midi.header.ppq)), velocity: n.velocity });
  }
  return midi.toArray();
}
export function readSessionMidi(bytes, MidiClass) {
  const midi = new MidiClass(bytes), warnings = [], ppq = midi.header.ppq;
  const source = midi.tracks.filter(t => t.notes.length);
  if (!source.length) throw new Error('That MIDI file contains no notes.');
  if (midi.header.timeSignatures.length > 1) throw new Error('This studio supports one time signature per piece. Split meter changes into movements before importing.');
  const tempos = midi.header.tempos.map(t => ({ beat: t.ticks / ppq, bpm: t.bpm }));
  if (!tempos.length || tempos[0].beat !== 0) tempos.unshift({ beat: 0, bpm: 120 });
  const meter = midi.header.timeSignatures[0]?.timeSignature || [4, 4], bar = meter[0] * 4 / meter[1];
  const tracks = source.map((t, i) => {
    if (Object.entries(t.controlChanges).some(([key, events]) => events?.some(e => !['7', '10'].includes(key) || e.ticks !== 0)) || t.pitchBends.length) warnings.push(`${t.name || 'Track ' + (i + 1)}: MIDI automation and pitch bends are not imported. Render audio in the source application if they are essential.`);
    const program = t.instrument.number;
    const instrument = t.instrument.percussion ? 'drums' : program >= 32 && program <= 39 ? 'bass' : program >= 24 && program <= 31 ? 'pluck' : program >= 88 && program <= 95 ? 'pad' : program >= 8 && program <= 15 ? 'bell' : 'felt';
    return { id: 'midi-' + i, name: (t.name || t.instrument.name || 'Track ' + (i + 1)).slice(0, 120), instrument, midiProgram: program, gain: t.controlChanges[7]?.find(e => e.ticks === 0)?.value ?? .7, pan: (t.controlChanges[10]?.find(e => e.ticks === 0)?.value ?? .5) * 2 - 1, notes: t.notes.map(n => ({ beat: n.ticks / ppq, duration: Math.max(1, n.durationTicks) / ppq, midi: n.midi, velocity: n.velocity })) };
  });
  const lastTick = Math.max(0, ...midi.header.meta.map(m => m.ticks), ...midi.tracks.map(t => t.endOfTrackTicks || 0));
  const beats = Math.ceil(Math.max(lastTick / ppq, ...tracks.flatMap(t => t.notes.map(n => n.beat + n.duration))) / bar) * bar;
  return validateSession({ spec: MUSIC_SPEC, id: 'imported-midi', title: (midi.name || 'Your composition').slice(0, 160), brief: 'Your MIDI notes and tempo map, ready to arrange and produce. Synthesized instruments are a preview; export MIDI or stems to continue in your DAW.', seed: 'midi', tempo: tempos[0].bpm, tempos, meter, beats, tracks, importWarnings: warnings });
}
export function wavBytes(channels, sampleRate, gain = 1) {
  const frames = channels[0].length, count = channels.length;
  const bytes = new ArrayBuffer(44 + frames * count * 2), view = new DataView(bytes);
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, count, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * count * 2, true); view.setUint16(32, count * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * count * 2, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) view.setInt16(44 + (i * count + c) * 2, Math.round(Math.max(-1, Math.min(1, channels[c][i] * gain)) * 32767), true);
  return bytes;
}
