import { secondsAt, musicRandom, activeTracks } from './session.mjs';
const decoded = new Map();
async function audioAssets(project, context) {
  const result = new Map();
  for (const asset of project.assets) {
    let buffer = decoded.get(asset.data);
    if (!buffer) {
      const binary = atob(asset.data.split(',')[1]), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      try { buffer = await context.decodeAudioData(bytes.buffer); }
      catch { throw new Error(`Cannot decode ${asset.name}. Use a WAV or MP3 recording.`); }
      if (buffer.duration > 240) throw new Error(`${asset.name} is longer than four minutes. Trim it before importing.`);
      if (decoded.size >= 16) decoded.delete(decoded.keys().next().value);
      decoded.set(asset.data, buffer);
    }
    result.set(asset.id, buffer);
  }
  return result;
}
function noiseBuffer(context, seed, seconds) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate), data = buffer.getChannelData(0), r = musicRandom(seed);
  for (let i = 0; i < data.length; i++) data[i] = r() * 2 - 1;
  return buffer;
}
function impulse(context, seed) {
  const length = Math.round(context.sampleRate * 1.4), buffer = context.createBuffer(2, length, context.sampleRate), r = musicRandom(seed);
  for (let channel = 0; channel < 2; channel++) { const data = buffer.getChannelData(channel); for (let i = 0; i < length; i++) data[i] = (r() * 2 - 1) * Math.exp(-i / length * 8) * .65; }
  return buffer;
}
function trackBus(context, track, seed) {
  const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = track.tone; filter.Q.value = .45;
  const volume = context.createGain(); volume.gain.value = track.gain;
  const pan = context.createStereoPanner(); pan.pan.value = track.pan;
  filter.connect(volume); volume.connect(pan); pan.connect(context.destination);
  if (track.space > 0) {
    const reverb = context.createConvolver(), send = context.createGain(); reverb.buffer = impulse(context, seed + ':room'); send.gain.value = track.space;
    volume.connect(send); send.connect(reverb); reverb.connect(pan);
  }
  if (track.delay > 0) {
    const delay = context.createDelay(2), feedback = context.createGain(), send = context.createGain();
    delay.delayTime.value = .31; feedback.gain.value = .28; send.gain.value = track.delay;
    volume.connect(send); send.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(pan);
  }
  return filter;
}
function envelope(context, target, time, duration, velocity, attack, release, sustained = false) {
  const gain = context.createGain(), level = Math.max(.00001, velocity * .32), hold = Math.max(time + attack + .002, time + duration);
  gain.gain.setValueAtTime(.00001, time);
  gain.gain.exponentialRampToValueAtTime(level, time + attack);
  if (sustained) gain.gain.linearRampToValueAtTime(level * .75, hold);
  else gain.gain.exponentialRampToValueAtTime(Math.max(.00001, level * .24), hold);
  gain.gain.exponentialRampToValueAtTime(.00001, hold + release);
  gain.connect(target); return { gain, end: hold + release + .01 };
}
function synthNote(context, target, track, note, time, duration, seed, assets) {
  const f = 440 * 2 ** ((note.midi - 69) / 12), kind = track.instrument, key = `${seed}:${note.beat}:${note.midi}`;
  if (note.velocity <= 0) return;
  if (kind === 'drums') {
    const gain = context.createGain(); gain.connect(target);
    if ([35, 36].includes(note.midi)) {
      const osc = context.createOscillator(); osc.frequency.setValueAtTime(150, time); osc.frequency.exponentialRampToValueAtTime(44, time + .16);
      gain.gain.setValueAtTime(.00001, time); gain.gain.exponentialRampToValueAtTime(note.velocity * .8, time + .003); gain.gain.exponentialRampToValueAtTime(.00001, time + .36);
      osc.connect(gain); osc.start(time); osc.stop(time + .37);
    } else {
      const hat = [42, 44, 46, 49, 51].includes(note.midi), length = note.midi === 46 ? .36 : hat ? .10 : .23;
      const source = context.createBufferSource(), filter = context.createBiquadFilter();
      source.buffer = noiseBuffer(context, key, length); filter.type = hat ? 'highpass' : 'bandpass'; filter.frequency.value = hat ? 7000 : 1700; filter.Q.value = hat ? .4 : .8;
      source.connect(filter); filter.connect(gain);
      gain.gain.setValueAtTime(Math.max(.00001, note.velocity * (hat ? .23 : .63)), time); gain.gain.exponentialRampToValueAtTime(.00001, time + length);
      source.start(time); source.stop(time + length);
      if (!hat) { const body = context.createOscillator(); body.type = 'triangle'; body.frequency.value = 185; const bodyGain = context.createGain(); bodyGain.gain.setValueAtTime(note.velocity * .13, time); bodyGain.gain.exponentialRampToValueAtTime(.00001, time + .14); body.connect(bodyGain); bodyGain.connect(target); body.start(time); body.stop(time + .15); }
    }
    return;
  }
  const env = envelope(context, target, time, duration, note.velocity, kind === 'pad' ? Math.max(.12, track.attack) : track.attack, track.release, kind === 'pad' || kind === 'lead');
  if (kind === 'sampler') {
    const source = context.createBufferSource(); source.buffer = assets.get(track.sampleId); source.playbackRate.value = 2 ** ((note.midi - track.sampleRoot) / 12); source.connect(env.gain); source.start(time); source.stop(env.end); return;
  }
  if (kind === 'pluck') {
    const length = Math.ceil((duration + track.release + .02) * context.sampleRate), buffer = context.createBuffer(1, length, context.sampleRate), out = buffer.getChannelData(0);
    const size = Math.max(2, Math.round(context.sampleRate / f)), line = new Float32Array(size), r = musicRandom(key);
    for (let i = 0; i < size; i++) line[i] = r() * 2 - 1;
    for (let i = 0; i < length; i++) { const pos = i % size, next = (pos + 1) % size; out[i] = line[pos]; line[pos] = (line[pos] + line[next]) * .4988; }
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(env.gain); source.start(time); source.stop(env.end); return;
  }
  const osc = context.createOscillator(); osc.frequency.value = f;
  if (kind === 'felt' || kind === 'bell') {
    const harmonics = kind === 'felt' ? [0, 1, .25, .1, .04, .008] : [0, 1, .01, .38, .04, .16, .04];
    osc.setPeriodicWave(context.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics)));
  } else osc.type = kind === 'pad' ? 'sawtooth' : kind === 'bass' ? 'triangle' : 'sine';
  osc.connect(env.gain); osc.start(time); osc.stop(env.end);
  if (kind === 'pad' || kind === 'bass') {
    const second = context.createOscillator(), mix = context.createGain(); second.type = 'sine'; second.frequency.value = kind === 'bass' ? f / 2 : f; second.detune.value = kind === 'pad' ? 7 : 0; mix.gain.value = .32; second.connect(mix); mix.connect(env.gain); second.start(time); second.stop(env.end);
  }
}
export async function renderSession(project, { onlyTrack, sampleRate = 48000 } = {}) {
  const duration = secondsAt(project, project.beats) + (project.tail ?? 1.5), context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const assets = await audioAssets(project, context);
  const tracks = onlyTrack ? project.tracks.filter(t => t.id === onlyTrack) : activeTracks(project);
  for (const track of tracks) {
    const seed = project.seed + ':' + track.id, bus = trackBus(context, track, seed);
    for (const note of track.notes) {
      const time = secondsAt(project, note.beat), length = secondsAt(project, note.beat + note.duration) - time;
      synthNote(context, bus, track, note, time, length, seed, assets);
    }
    for (const clip of track.clips) {
      const buffer = assets.get(clip.assetId), start = secondsAt(project, clip.beat);
      if (clip.offset + clip.duration > buffer.duration + .03) throw new Error(`${track.name}: the clip extends beyond its recording.`);
      const source = context.createBufferSource(), gain = context.createGain(); source.buffer = buffer;
      const fadeIn = Math.min(clip.fadeIn, clip.duration / 2), fadeOut = Math.min(clip.fadeOut, clip.duration / 2), level = clip.gain;
      gain.gain.setValueAtTime(fadeIn ? 0 : level, start); if (fadeIn) gain.gain.linearRampToValueAtTime(level, start + fadeIn);
      gain.gain.setValueAtTime(level, start + clip.duration - fadeOut); if (fadeOut) gain.gain.linearRampToValueAtTime(0, start + clip.duration);
      source.connect(gain); gain.connect(bus); source.start(start, clip.offset, clip.duration);
    }
  }
  const buffer = await context.startRendering(), channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  let peak = 0, energy = 0;
  for (const data of channels) for (let i = 0; i < data.length; i++) {
    // The same linear ending fade is applied to each stem and the mix.
    data[i] *= Math.min(1, (data.length - 1 - i) / (sampleRate * .015));
    peak = Math.max(peak, Math.abs(data[i])); energy += data[i] ** 2;
  }
  const gain = project.master * Math.min(1, .95 / Math.max(peak, .000001));
  return { buffer, channels, sampleRate, duration: buffer.duration, rawPeak: peak, gain, peak: peak * gain, rms: Math.sqrt(energy / (buffer.length * 2)) * gain };
}
