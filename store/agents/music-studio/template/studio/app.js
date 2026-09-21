const $ = selector => document.querySelector(selector), colors = ['#eabe90', '#b9acf1', '#8bc9ba', '#98bce8', '#dc9caa', '#cad990'];
const original = validateSession(JSON.parse($('#afterhours-data').textContent)), storageKey = 'afterhours:' + original.id;
let project = structuredClone(original), selectedTrack = 0, selectedNote = -1, selectedClip = 0, windowBar = 0, undoStack = [], redoStack = [], pendingDraft, preserveDraft = false;
let mix, mixRevision = -1, revision = 0, renderPromise, renderTimer, playback, audioContext, startedAt = 0, seekSeconds = 0, toastTimer, noteRects = [], pianoBounds;
const state = () => ({ project: structuredClone(project), selectedTrack, windowBar });
const track = () => project.tracks[selectedTrack];
const duration = () => secondsAt(project, project.beats) + (project.tail ?? 1.5);
const clock = value => { const seconds = Math.floor(Math.max(0, value) + .001); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 6000); }
function parentMessage(type, extra = {}) { if (parent !== window) parent.postMessage({ type, ...extra }, '*'); }
function persist() {
  if (preserveDraft) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ baseRevision: original.revision, ...state() })); $('#draft-status').textContent = 'Draft saved on this device'; }
  catch { $('#draft-status').textContent = 'Save project to keep your recordings'; }
}
function stop() { if (playback) { playback.onended = null; playback.stop(); playback.disconnect(); playback = null; } $('#play').textContent = '▶ Play'; $('#play').setAttribute('aria-label', 'Play'); }
function change(mutate, { rebuild = true } = {}) {
  const previous = state();
  try { mutate(); project = validateSession(project); }
  catch (error) { project = previous.project; selectedTrack = previous.selectedTrack; toast(error.message); buildUI(); return; }
  undoStack.push(previous); if (undoStack.length > 16) undoStack.shift(); redoStack = [];
  stop(); revision++; mixRevision = -1; selectedNote = Math.min(selectedNote, track().notes.length - 1);
  if (rebuild) buildUI(); else updateLabels(); persist(); scheduleMix();
}
function restore(saved) { stop(); project = validateSession(saved.project); selectedTrack = Math.min(saved.selectedTrack || 0, project.tracks.length - 1); windowBar = saved.windowBar || 0; selectedNote = -1; revision++; mixRevision = -1; buildUI(); persist(); scheduleMix(); }
function saveFile(name, content, type = 'application/octet-stream') { const blob = content instanceof Blob ? content : new Blob([content], { type }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function canvasContext(canvas) {
  const box = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2), w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, w, h); return { ctx, w, h };
}
function updateLabels() {
  $('#title').textContent = project.title; document.title = project.title + ' · Afterhours'; $('#brief').textContent = project.brief;
  $('#tempo').value = Number(project.tempo.toFixed(3)); $('#bars').value = Math.ceil(project.beats / beatsPerBar(project)); $('#meter').textContent = project.meter.join(' / ');
  $('#gain-label').value = `${Math.round(track().gain * 100)}%`; $('#pan-label').value = track().pan === 0 ? 'Center' : `${Math.round(Math.abs(track().pan) * 100)}% ${track().pan < 0 ? 'left' : 'right'}`;
  $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length;
  $('#mute').setAttribute('aria-pressed', track().muted); $('#solo').setAttribute('aria-pressed', track().solo);
}
function buildUI() {
  selectedTrack = Math.min(selectedTrack, project.tracks.length - 1);
  windowBar = Math.max(0, Math.min(windowBar, Math.max(0, Math.ceil(project.beats / beatsPerBar(project)) - 1)));
  updateLabels();
  $('#tracks').replaceChildren(); $('#sections').replaceChildren();
  project.sections.forEach((s, i) => { const div = document.createElement('div'); div.className = 'section'; div.textContent = s.name; div.style.left = `${s.beat / project.beats * 100}%`; div.style.width = `${s.length / project.beats * 100}%`; div.style.color = colors[i % colors.length]; $('#sections').append(div); });
  project.tracks.forEach((t, i) => {
    const row = document.createElement('div'), info = document.createElement('div'), name = document.createElement('button'), mute = document.createElement('button'), solo = document.createElement('button'), canvas = document.createElement('canvas');
    row.className = 'track' + (selectedTrack === i ? ' selected' : ''); info.className = 'track-info'; name.className = 'track-name'; name.textContent = t.name; name.title = t.name; name.style.color = colors[i % colors.length];
    name.onclick = () => { selectedTrack = i; selectedNote = -1; selectedClip = 0; buildUI(); };
    mute.className = solo.className = 'mini'; mute.textContent = 'M'; solo.textContent = 'S'; mute.setAttribute('aria-label', `Mute ${t.name}`); solo.setAttribute('aria-label', `Solo ${t.name}`); mute.setAttribute('aria-pressed', t.muted); solo.setAttribute('aria-pressed', t.solo);
    mute.onclick = () => change(() => { t.muted = !t.muted; }); solo.onclick = () => change(() => { t.solo = !t.solo; });
    canvas.dataset.track = i; canvas.setAttribute('aria-label', t.name + ' arrangement'); canvas.onclick = event => { selectedTrack = i; selectedNote = -1; const box = canvas.getBoundingClientRect(); seekSeconds = secondsAt(project, Math.max(0, Math.min(project.beats, (event.clientX - box.left) / box.width * project.beats))); stop(); buildUI(); };
    info.append(name, mute, solo); row.append(info, canvas); $('#tracks').append(row);
  });
  $('#track-name').value = track().name;
  $('#instrument').replaceChildren();
  for (const [key, label] of Object.entries(instruments)) { if (key === 'sampler' && !project.assets.length || key === 'audio' && track().instrument !== 'audio') continue; const option = document.createElement('option'); option.value = key; option.textContent = label; $('#instrument').append(option); }
  $('#instrument').value = track().instrument;
  for (const name of ['gain', 'pan', 'attack', 'release', 'tone', 'space', 'delay']) $('#' + name).value = track()[name];
  $('#master').value = project.master; $('#sampler-controls').hidden = track().instrument !== 'sampler'; $('#sample-id').replaceChildren();
  for (const asset of project.assets) { const option = document.createElement('option'); option.value = asset.id; option.textContent = asset.name; $('#sample-id').append(option); }
  $('#sample-id').value = track().sampleId || project.assets[0]?.id || ''; $('#sample-root').value = noteName(track().sampleRoot);
  $('#clip-controls').hidden = !track().clips.length;
  selectedClip = Math.max(0, Math.min(selectedClip, track().clips.length - 1)); $('#clip-select').replaceChildren();
  track().clips.forEach((c, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `${i + 1}. ${project.assets.find(a => a.id === c.assetId)?.name || 'Recording'} · beat ${c.beat}`; $('#clip-select').append(option); });
  $('#clip-select').value = selectedClip;
  if (track().clips[selectedClip]) for (const [id, key] of [['clip-beat', 'beat'], ['clip-offset', 'offset'], ['clip-duration', 'duration']]) $('#' + id).value = track().clips[selectedClip][key];
  $('#remove-track').disabled = project.tracks.length === 1;
  updateNote(); requestAnimationFrame(drawAll);
}
function drawArrangement() {
  const beat = beatAt(project, playback ? Math.max(0, audioContext.currentTime - startedAt) : seekSeconds);
  for (const canvas of document.querySelectorAll('#tracks canvas')) {
    const i = Number(canvas.dataset.track), t = project.tracks[i], { ctx, w, h } = canvasContext(canvas), unit = w / project.beats;
    ctx.strokeStyle = '#ffffff09'; ctx.lineWidth = 1;
    for (let b = 0; b <= project.beats; b += beatsPerBar(project)) { ctx.beginPath(); ctx.moveTo(b * unit + .5, 0); ctx.lineTo(b * unit + .5, h); ctx.stroke(); }
    ctx.fillStyle = colors[i % colors.length]; ctx.globalAlpha = t.muted ? .18 : .75;
    for (const n of t.notes) ctx.fillRect(n.beat * unit, 6 + (1 - (n.midi % 36) / 36) * (h - 15), Math.max(2, n.duration * unit - 1), 3);
    for (const clip of t.clips) { const x = clip.beat * unit, width = (beatAt(project, secondsAt(project, clip.beat) + clip.duration) - clip.beat) * unit; ctx.globalAlpha = .24; ctx.fillRect(x, 6, width, h - 12); ctx.globalAlpha = .85; ctx.font = '9px sans-serif'; ctx.save(); ctx.beginPath(); ctx.rect(x + 4, 4, Math.max(0, width - 8), h - 8); ctx.clip(); ctx.fillText(project.assets.find(a => a.id === clip.assetId)?.name || 'Recording', x + 6, h / 2 + 3); ctx.restore(); }
    ctx.globalAlpha = 1; ctx.fillStyle = '#f8e5ca'; ctx.fillRect(Math.min(w - 1, beat * unit), 0, 1, h);
  }
}
function drawPiano() {
  const { ctx, w, h } = canvasContext($('#piano')), bar = beatsPerBar(project), start = windowBar * bar, span = Math.min(8 * bar, project.beats - start), labelWidth = 37;
  const notes = track().notes, lowest = Math.min(...notes.map(n => n.midi), 60), highest = Math.max(...notes.map(n => n.midi), 72);
  const low = Math.max(0, Math.floor(lowest / 12) * 12 - 3), high = Math.min(127, Math.max(low + 24, highest + 4)), rows = high - low + 1, rowHeight = (h - 24) / rows, unit = (w - labelWidth) / Math.max(span, 1);
  pianoBounds = { w, h, low, high, rows, rowHeight, unit, start, span, labelWidth }; noteRects = [];
  for (let midi = low; midi <= high; midi++) {
    const y = 24 + (high - midi) * rowHeight; ctx.fillStyle = [1, 3, 6, 8, 10].includes(midi % 12) ? '#ffffff02' : '#ffffff06'; ctx.fillRect(labelWidth, y, w - labelWidth, rowHeight - .5);
    if (midi % 12 === 0) { ctx.fillStyle = '#737d94'; ctx.font = '9px monospace'; ctx.fillText(noteName(midi), 5, y + rowHeight); }
  }
  for (let beat = 0; beat <= span; beat += 4 / project.meter[1]) { const x = labelWidth + beat * unit, major = Math.abs(beat / bar - Math.round(beat / bar)) < .0001; ctx.strokeStyle = major ? '#ffffff24' : '#ffffff09'; ctx.beginPath(); ctx.moveTo(x + .5, 24); ctx.lineTo(x + .5, h); ctx.stroke(); if (major) { ctx.fillStyle = '#838da2'; ctx.font = '9px monospace'; ctx.fillText(String(Math.round((start + beat) / bar) + 1), x + 4, 15); } }
  notes.forEach((n, i) => {
    if (n.beat + n.duration <= start || n.beat >= start + span) return;
    const x = labelWidth + Math.max(0, n.beat - start) * unit, y = 24 + (high - n.midi) * rowHeight + 1, width = Math.max(3, (Math.min(start + span, n.beat + n.duration) - Math.max(start, n.beat)) * unit - 1);
    ctx.globalAlpha = .4 + n.velocity * .6; ctx.fillStyle = i === selectedNote ? '#fff4df' : colors[selectedTrack % colors.length]; ctx.fillRect(x, y, width, Math.max(2, rowHeight - 2)); ctx.globalAlpha = 1;
    noteRects.push({ index: i, x, y, width, height: Math.max(3, rowHeight) });
  });
  $('#bar-window').textContent = `${windowBar + 1}–${Math.ceil((start + span) / bar)}`; $('#previous-bars').disabled = windowBar === 0; $('#next-bars').disabled = start + span >= project.beats;
  $('#piano-title').textContent = track().name + (track().instrument === 'audio' ? ' · recording' : ' · notes');
}
function drawWave() {
  const { ctx, w, h } = canvasContext($('#waveform'));
  if (mix) {
    for (let channel = 0; channel < 2; channel++) {
      const samples = mix.channels[channel], stride = Math.max(1, Math.floor(samples.length / w)), center = h * (channel ? .75 : .25);
      ctx.strokeStyle = channel ? '#b9acf1' : '#eabe90'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) { let peak = 0; for (let j = x * stride; j < Math.min(samples.length, (x + 1) * stride); j += Math.max(1, Math.floor(stride / 24))) peak = Math.max(peak, Math.abs(samples[j])); const length = peak * mix.gain * h * .24; ctx.moveTo(x, center - Math.max(.5, length)); ctx.lineTo(x, center + Math.max(.5, length)); }
      ctx.stroke();
    }
  }
  const current = playback ? Math.min(duration(), Math.max(0, audioContext.currentTime - startedAt)) : Math.min(duration(), seekSeconds);
  ctx.fillStyle = '#ffffffb3'; ctx.fillRect(current / duration() * w, 0, 1, h); $('#time').textContent = clock(current) + ' / ' + clock(duration());
}
function drawAll() { drawArrangement(); drawPiano(); drawWave(); }
function updateNote() {
  const n = track().notes[selectedNote];
  for (const id of ['note-pitch', 'note-start', 'note-velocity']) $('#' + id).disabled = !n;
  $('#delete-note').disabled = !n;
  if (n) { $('#note-pitch').value = noteName(n.midi); $('#note-start').value = Number(n.beat.toFixed(4)); $('#note-length').value = Number(n.duration.toFixed(4)); $('#note-velocity').value = n.velocity; }
}
async function ensureMix() {
  if (mixRevision === revision && mix) return mix;
  if (renderPromise?.revision === revision) return renderPromise.promise;
  const current = revision, candidate = structuredClone(project);
  $('#audio-status').textContent = 'Rendering your arrangement…'; $('#error').hidden = true;
  $('#play').disabled = $('#export-wav').disabled = $('#export-stems').disabled = true;
  const promise = renderSession(candidate).then(result => {
    if (current !== revision) return result;
    mix = result; mixRevision = current;
    $('#audio-status').textContent = activeTracks(project).length + ' tracks · ready to play';
    $('#level').textContent = `PEAK ${result.peak > 0 ? (20 * Math.log10(result.peak)).toFixed(1) : '−∞'} dBFS / 48 kHz`;
    $('#play').disabled = $('#export-wav').disabled = $('#export-stems').disabled = false;
    document.body.dataset.ready = 'true'; parentMessage('harness:ready'); drawWave(); return result;
  }).catch(error => {
    if (current === revision) { $('#error').textContent = error.message; $('#error').hidden = false; $('#audio-status').textContent = 'A track needs attention'; parentMessage('harness:error', { message: error.message }); }
    throw error;
  });
  renderPromise = { revision: current, promise }; return promise;
}
function scheduleMix() { $('#play').disabled = $('#export-wav').disabled = $('#export-stems').disabled = true; clearTimeout(renderTimer); renderTimer = setTimeout(() => ensureMix().catch(() => {}), 240); }
function guard(task) { return async (...args) => { try { await task(...args); } catch (error) { toast(error.message || String(error)); } }; }
async function play() {
  if (playback) { seekSeconds = audioContext.currentTime - startedAt; stop(); return; }
  const current = revision, rendered = await ensureMix(); if (current !== revision) return;
  audioContext ??= new AudioContext(); await audioContext.resume();
  const source = audioContext.createBufferSource(), gain = audioContext.createGain(); source.buffer = rendered.buffer; gain.gain.value = rendered.gain; source.connect(gain); gain.connect(audioContext.destination);
  if (seekSeconds >= rendered.duration - .05) seekSeconds = 0;
  startedAt = audioContext.currentTime - seekSeconds; source.start(0, seekSeconds); playback = source;
  $('#play').textContent = 'Ⅱ Pause'; $('#play').setAttribute('aria-label', 'Pause');
  source.onended = () => { if (playback === source) { playback = null; seekSeconds = 0; $('#play').textContent = '▶ Play'; $('#play').setAttribute('aria-label', 'Play'); } };
}
$('#play').onclick = guard(play); $('#stop').onclick = () => { stop(); seekSeconds = 0; drawAll(); };
$('#waveform').onclick = guard(async event => { const wasPlaying = !!playback, box = $('#waveform').getBoundingClientRect(); stop(); seekSeconds = Math.max(0, Math.min(duration() - .02, (event.clientX - box.left) / box.width * duration())); if (wasPlaying) await play(); drawAll(); });
let drag;
$('#piano').onpointerdown = event => {
  if (!event.isPrimary || event.button !== 0) return;
  if (track().instrument === 'audio') { toast('Use the recording controls to move or trim this clip.'); return; }
  const box = $('#piano').getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top, hit = noteRects.find(r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
  if (hit) {
    selectedNote = hit.index; drag = { x, y, previous: state(), note: { ...track().notes[selectedNote] }, moved: false }; $('#piano').setPointerCapture(event.pointerId); updateNote(); drawPiano();
  } else if (x > pianoBounds.labelWidth && y > 24) {
    const beat = Math.round((pianoBounds.start + (x - pianoBounds.labelWidth) / pianoBounds.unit) * 4) / 4, midi = Math.max(0, Math.min(127, pianoBounds.high - Math.floor((y - 24) / pianoBounds.rowHeight))), length = Math.max(.125, Number($('#note-length').value) || 1);
    if (beat >= project.beats) return;
    change(() => { track().notes.push({ beat, midi, duration: Math.min(length, project.beats - beat), velocity: Number($('#note-velocity').value) || .75 }); selectedNote = track().notes.length - 1; });
  }
};
$('#piano').onpointermove = event => {
  if (!drag) return;
  const box = $('#piano').getBoundingClientRect(), dx = event.clientX - box.left - drag.x, dy = event.clientY - box.top - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  drag.moved = true; stop(); const n = track().notes[selectedNote];
  n.beat = Math.max(0, Math.min(project.beats - n.duration, Math.round((drag.note.beat + dx / pianoBounds.unit) * 4) / 4));
  n.midi = Math.max(0, Math.min(127, drag.note.midi - Math.round(dy / pianoBounds.rowHeight))); updateNote(); drawPiano(); drawArrangement();
};
function endDrag() { if (drag?.moved) { undoStack.push(drag.previous); if (undoStack.length > 16) undoStack.shift(); redoStack = []; revision++; mixRevision = -1; persist(); scheduleMix(); updateLabels(); } drag = null; }
$('#piano').onpointerup = endDrag; $('#piano').onpointercancel = endDrag;
for (const [id, key, parse] of [['note-pitch', 'midi', noteNumber], ['note-start', 'beat', Number], ['note-length', 'duration', Number], ['note-velocity', 'velocity', Number]]) $('#' + id).onchange = () => { if (selectedNote < 0) return; change(() => { track().notes[selectedNote][key] = parse($('#' + id).value); }); };
$('#delete-note').onclick = () => { if (selectedNote >= 0) change(() => { track().notes.splice(selectedNote, 1); selectedNote = -1; }); };
$('#previous-bars').onclick = () => { windowBar = Math.max(0, windowBar - 8); drawPiano(); }; $('#next-bars').onclick = () => { windowBar += 8; drawPiano(); };
$('#duplicate-section').onclick = () => change(() => { const start = windowBar * beatsPerBar(project), length = Math.min(8 * beatsPerBar(project), project.beats - start); project = duplicateSection(project, start, length); windowBar = Math.floor((project.beats - length) / beatsPerBar(project)); });
$('#track-name').onchange = () => change(() => { track().name = $('#track-name').value.trim() || 'Instrument'; });
$('#instrument').onchange = () => change(() => { track().instrument = $('#instrument').value; delete track().midiProgram; if (track().instrument === 'sampler') track().sampleId = project.assets[0]?.id; });
for (const key of ['gain', 'pan', 'attack', 'release', 'tone', 'space', 'delay']) $('#' + key).onchange = () => change(() => { track()[key] = Number($('#' + key).value); });
$('#mute').onclick = () => change(() => { track().muted = !track().muted; }); $('#solo').onclick = () => change(() => { track().solo = !track().solo; });
$('#master').onchange = () => change(() => { project.master = Number($('#master').value); });
$('#tempo').onchange = () => change(() => { const ratio = Number($('#tempo').value) / project.tempo; project.tempos.forEach(t => { t.bpm *= ratio; }); project.tempo = project.tempos[0].bpm; });
$('#bars').onchange = () => change(() => { const beats = Number($('#bars').value) * beatsPerBar(project); if (project.tracks.some(t => t.notes.some(n => n.beat + n.duration > beats) || t.clips.some(c => secondsAt(project, c.beat) + c.duration > secondsAt(project, beats)))) throw new Error('Move or shorten the ending notes and recordings before reducing the arrangement.'); project.beats = beats; project.sections = project.sections.filter(s => s.beat < beats).map(s => ({ ...s, length: Math.min(s.length, beats - s.beat) })); project.tempos = project.tempos.filter(t => t.beat < beats); });
$('#sample-id').onchange = () => change(() => { track().sampleId = $('#sample-id').value; }); $('#sample-root').onchange = () => change(() => { track().sampleRoot = noteNumber($('#sample-root').value); });
$('#clip-select').onchange = () => { selectedClip = Number($('#clip-select').value); buildUI(); };
for (const [id, key] of [['clip-beat', 'beat'], ['clip-offset', 'offset'], ['clip-duration', 'duration']]) $('#' + id).onchange = () => change(() => { const clip = track().clips[selectedClip]; clip[key] = Number($('#' + id).value); const end = beatAt(project, secondsAt(project, clip.beat) + clip.duration); project.beats = Math.max(project.beats, Math.ceil(end / beatsPerBar(project)) * beatsPerBar(project)); });
for (const [id, delta] of [['transpose-down', -12], ['transpose-up', 12]]) $('#' + id).onclick = () => change(() => { track().notes.forEach(n => { n.midi += delta; }); });
$('#add-track').onclick = () => change(() => { project.tracks.push({ id: 'instrument-' + Date.now(), name: 'Your instrument', instrument: 'felt', notes: [], clips: [] }); selectedTrack = project.tracks.length - 1; selectedNote = -1; });
$('#remove-track').onclick = () => { if (project.tracks.length > 1) change(() => { project.tracks.splice(selectedTrack, 1); selectedTrack = Math.min(selectedTrack, project.tracks.length - 1); selectedNote = -1; }); };
$('#undo').onclick = () => { if (undoStack.length) { redoStack.push(state()); restore(undoStack.pop()); } }; $('#redo').onclick = () => { if (redoStack.length) { undoStack.push(state()); restore(redoStack.pop()); } };
$('#reset-project').onclick = () => change(() => { project = structuredClone(original); selectedTrack = 0; selectedNote = -1; windowBar = 0; });
$('#save-project').onclick = () => saveFile(filename(project.title) + '.afterhours.json', JSON.stringify(project, null, 2), 'application/json');
$('#open-project').onclick = () => $('#project-file').click(); $('#open-midi').onclick = () => $('#midi-file').click(); $('#import-audio').onclick = () => $('#audio-file').click();
$('#project-file').onchange = guard(async () => { const file = $('#project-file').files[0]; if (!file) return; if (file.size > 28000000) throw new Error('Project exceeds 28 MB.'); const p = validateSession(JSON.parse(await file.text())); change(() => { project = p; selectedTrack = 0; selectedNote = -1; windowBar = 0; }); $('#project-file').value = ''; });
$('#midi-file').onchange = guard(async () => { const file = $('#midi-file').files[0]; if (!file) return; if (file.size > 4000000) throw new Error('MIDI file exceeds 4 MB.'); const p = readSessionMidi(new Uint8Array(await file.arrayBuffer()), Midi); change(() => { project = p; selectedTrack = 0; selectedNote = -1; windowBar = 0; }); $('#midi-file').value = ''; toast(p.importWarnings.length ? p.importWarnings[0] : 'Your notes and tempo changes are ready to arrange.'); });
$('#audio-file').onchange = guard(async () => {
  const file = $('#audio-file').files[0]; if (!file) return; if (file.size > 18000000) throw new Error('Use a recording under 18 MB. A longer recording can be imported as MP3.');
  const context = new OfflineAudioContext(1, 1, 48000), buffer = await context.decodeAudioData(await file.arrayBuffer());
  if (buffer.duration > 240) throw new Error('Trim the recording to four minutes or less.');
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  change(() => {
    const id = 'recording-' + Date.now(); project.assets.push({ id, name: file.name, data });
    project.beats = Math.max(project.beats, Math.ceil(beatAt(project, buffer.duration) / beatsPerBar(project)) * beatsPerBar(project));
    project.tracks.push({ id, name: file.name.slice(0, 120), instrument: 'audio', gain: 1, tone: 20000, space: 0, notes: [], clips: [{ assetId: id, beat: 0, offset: 0, duration: buffer.duration, gain: 1, fadeIn: .02, fadeOut: .05 }] });
    selectedTrack = project.tracks.length - 1; selectedNote = -1;
  }); $('#audio-file').value = ''; toast('Your recording is in the arrangement. Move or trim it in the track controls.');
});
$('#export-wav').onclick = guard(async () => { const current = revision, result = await ensureMix(); if (current !== revision) throw new Error('The piece changed during export. Export the new version when it is ready.'); saveFile(filename(project.title) + '.wav', wavBytes(result.channels, result.sampleRate, result.gain), 'audio/wav'); });
$('#export-midi').onclick = guard(async () => { saveFile(filename(project.title) + '.mid', writeSessionMidi(project, Midi), 'audio/midi'); toast('Editable notes and tempo exported. Your recorded audio stays in the WAV stems and project.'); });
async function stemFiles() {
  const candidate = structuredClone(project), result = await renderSession(candidate), audible = activeTracks(candidate);
  if (audible.length * result.buffer.length * 4 > 512000000) throw new Error('This stem bundle exceeds 512 MB. Solo a smaller group of tracks and export in groups.');
  const files = [['mix.wav', wavBytes(result.channels, result.sampleRate, result.gain)], ['composition.mid', writeSessionMidi(candidate, Midi)], ['project.afterhours.json', JSON.stringify(candidate, null, 2)]];
  const report = { title: candidate.title, sampleRate: result.sampleRate, channels: 2, bitDepth: 16, duration: result.duration, commonGain: result.gain, peak: result.peak, stems: [] };
  for (let i = 0; i < audible.length; i++) {
    const t = audible[i], rendered = await renderSession(candidate, { onlyTrack: t.id }), name = `${String(i + 1).padStart(2, '0')}-${filename(t.name)}.wav`;
    files.push(['stems/' + name, wavBytes(rendered.channels, rendered.sampleRate, result.gain)]); report.stems.push({ file: name, track: t.id, name: t.name });
  }
  files.push(['delivery.json', JSON.stringify(report, null, 2)], ['README.txt', `${candidate.title}\n\n${candidate.brief}\n\nDrag every WAV stem to time zero in your DAW. All stems share length, sample rate and mix gain. They contain the audible tracks at export time, including per-track effects. MIDI carries all notes and the tempo map, not recordings or audio effects. Synth previews need not sound like your DAW's MIDI instruments. project.afterhours.json preserves your notes, mix and embedded recordings.\n`]);
  return { files, report };
}
$('#export-stems').onclick = guard(async () => { const name = filename(project.title); $('#export-stems').disabled = true; $('#audio-status').textContent = 'Rendering separate tracks…'; try { const { files, report } = await stemFiles(); saveFile(name + '-production.zip', zipFiles(files)); toast(`${report.stems.length} aligned WAV stems, mix, MIDI and editable project exported.`); } finally { $('#export-stems').disabled = false; $('#audio-status').textContent = 'Ready to play'; } });
$('#export-html').onclick = () => { const doc = document.documentElement.cloneNode(true); doc.querySelector('#afterhours-data').textContent = JSON.stringify(project).replace(/</g, '\\u003c'); doc.querySelector('#revision-notice').hidden = true; doc.querySelector('#error').hidden = true; doc.querySelector('#toast').className = ''; doc.querySelector('body').removeAttribute('data-ready'); saveFile(filename(project.title) + '-studio.html', '<!doctype html>\n' + doc.outerHTML, 'text/html'); };
$('#use-revision').onclick = () => { preserveDraft = false; $('#revision-notice').hidden = true; persist(); }; $('#keep-draft').onclick = () => { preserveDraft = false; $('#revision-notice').hidden = true; restore(pendingDraft); };
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved) { saved.project = validateSession(saved.project); if (saved.baseRevision === original.revision) { project = saved.project; selectedTrack = Math.min(saved.selectedTrack || 0, project.tracks.length - 1); windowBar = saved.windowBar || 0; } else { pendingDraft = saved; preserveDraft = true; $('#revision-notice').hidden = false; } } } catch {}
addEventListener('keydown', event => { if (event.target.closest('input,select,textarea')) return; if (event.code === 'Space') { event.preventDefault(); guard(play)(); } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $('#' + (event.shiftKey ? 'redo' : 'undo')).click(); } else if (['Backspace', 'Delete'].includes(event.key) && event.target === $('#piano')) { event.preventDefault(); $('#delete-note').click(); } });
new ResizeObserver(drawAll).observe($('.main-panel'));
function animate() { if (playback) { drawWave(); drawArrangement(); } requestAnimationFrame(animate); }
window.afterhours = {
  getProject: () => structuredClone(project), getState: () => ({ playing: !!playback, context: audioContext?.state, selectedTrack, selectedNote, peak: mix?.peak, rms: mix?.rms, duration: mix?.duration, revision, mixRevision }),
  render: options => renderSession(project, options), midi: () => Array.from(writeSessionMidi(project, Midi)), stemFiles,
  async deliver() { const result = await ensureMix(), bytes = new Blob([wavBytes(result.channels, result.sampleRate, result.gain)], { type: 'audio/wav' }); const wav = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(bytes); }); return { wav, duration: result.duration, peak: result.peak, rms: result.rms, sampleRate: result.sampleRate, gain: result.gain }; },
};
buildUI(); ensureMix().catch(() => {}); animate();
