/* The Episode Ready pane: a mastering desk.
 *
 * The waveform is drawn from a precomputed min/max file (EPWF, 50 buckets a second, one signed
 * byte each) rather than decoded in the browser: an hour of 44.1 kHz is 600 MB of AudioBuffer and
 * 360 KB of this. The audio itself is streamed with Range, so seeking in a long episode is instant.
 *
 * Everything the person edits here — a chapter, a word in the transcript, the show notes, a cut
 * put back — is written straight into the workspace files the agent reads next turn.
 */

const $ = (id) => document.getElementById(id);
const QUERY = new URLSearchParams(location.search);
const SNAPSHOT = QUERY.get('snapshot') === '1';
// ?tab=, ?side= and ?at= open the pane on a particular view: how a still picture of it is taken,
// and how someone shares a link to a moment in the episode.
const WANT = { tab: QUERY.get('tab'), side: QUERY.get('side'), at: Number(QUERY.get('at')) || 0 };

const el = {
  app: $('app'), title: $('title'), show: $('show'), cover: $('cover'), phases: $('phases'),
  verdict: $('verdict'), verdictText: $('verdict-text'),
  lufs: $('lufs'), tp: $('tp'), lra: $('lra'), dur: $('dur'), was: $('was'),
  sourceNote: $('source-note'), sourceLabel: $('source-label'),
  gauge: $('gauge'), gaugeBand: $('gauge-band'), gaugeTarget: $('gauge-target'),
  gaugeNeedle: $('gauge-needle'), targetLabel: $('target-label'),
  wave: $('wave'), waveWrap: $('wave-wrap'), flags: $('flags'), playhead: $('playhead'),
  hoverLine: $('hover-line'), hoverTime: $('hover-time'), selection: $('selection'), empty: $('empty'),
  waveNote: $('wave-note'), rerender: $('rerender'),
  abBefore: $('ab-before'), abMaster: $('ab-master'),
  play: $('play'), back: $('back'), fwd: $('fwd'), at: $('at'), total: $('total'),
  loop: $('loop'), addChapter: $('add-chapter'),
  chapters: $('chapters'), chapterCount: $('chapter-count'), chaptersHint: $('chapters-hint'),
  cuts: $('cuts'), cutCount: $('cut-count'),
  transcript: $('transcript'), find: $('find'), notes: $('notes'), notesSave: $('notes-save'),
  notesState: $('notes-state'), files: $('files'), checks: $('checks'), checkBadge: $('check-badge'),
  toast: $('toast'), job: $('job'), jobStep: $('job-step'), audio: $('audio'),
};

const state = {
  data: null, side: 'master', peaks: { master: null, before: null }, duration: 0,
  selection: null, looping: false, dragging: null, notesDirty: false, tab: 'transcript',
  activeChapter: -1, find: '',
};

/* ---------------------------------------------------------------- utilities */

const clock = (s) => {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`
           : `${m}:${String(x).padStart(2, '0')}`;
};
const bytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

let toastTimer = null;
function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('bad', bad);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.conflict) {
    toast(`${data.message} — reloaded, make the change again`, true);
    apply(data.state);
    return null;
  }
  if (data.error) { toast(data.error, true); return null; }
  if (data.state) apply(data.state);
  return data;
}

/* ---------------------------------------------------------------- peaks */

async function loadPeaks(which) {
  const res = await fetch(`/peaks/${which}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const view = new DataView(buffer);
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'EPWF') return null;
  const perSecond = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  return { perSecond, count, pairs: new Int8Array(buffer, 12, count * 2) };
}

/* ---------------------------------------------------------------- the waveform */

function activeDuration() {
  if (state.side === 'before') {
    const p = state.peaks.before;
    return p ? p.count / p.perSecond : 0;
  }
  return state.duration || 0;
}

function draw() {
  const canvas = el.wave;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = css.getPropertyValue('--stage-2').trim() || '#16170f';
  ctx.fillRect(0, 0, width, height);

  const peaks = state.peaks[state.side];
  const total = activeDuration();
  if (!peaks || !total) return;

  const mid = height * 0.52;
  const amp = height * 0.40;

  // On the "before" side, grey what the edit removes, so a cut is something you can see.
  const removed = state.side === 'before' ? (state.data?.episode?.removed || []) : [];
  if (removed.length) {
    ctx.fillStyle = 'rgba(255,95,77,0.10)';
    for (const cut of removed) {
      const x0 = (cut.start / total) * width, x1 = (cut.end / total) * width;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }
  }

  // Centre line.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(width, mid + 0.5); ctx.stroke();

  const inCut = (t) => removed.some((c) => t >= c.start && t <= c.end);
  const bright = css.getPropertyValue('--wave').trim() || '#cfe3b8';
  const dim = css.getPropertyValue('--wave-dim').trim() || '#4a4f42';
  const step = Math.max(1, peaks.count / width);
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * step), to = Math.min(peaks.count, Math.floor((x + 1) * step));
    let lo = 0, hi = 0;
    for (let i = from; i < to; i++) {
      const a = peaks.pairs[i * 2], b = peaks.pairs[i * 2 + 1];
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    const t = (x / width) * total;
    ctx.strokeStyle = inCut(t) ? dim : bright;
    const y0 = mid - (hi / 127) * amp, y1 = mid - (lo / 127) * amp;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, Math.min(y0, mid - 0.5));
    ctx.lineTo(x + 0.5, Math.max(y1, mid + 0.5));
    ctx.stroke();
  }

  // The short-term loudness line, on the master only: this is the thing the craft is judged by.
  const contour = state.data?.contour;
  const target = state.data?.episode?.render?.target;
  if (state.side === 'master' && contour?.values?.length && target) {
    const lo = target.lufs - 14, hi = target.lufs + 8;
    const y = (lufs) => height - ((Math.max(lo, Math.min(hi, lufs)) - lo) / (hi - lo)) * height;
    const bandTop = y(target.lufs + target.tolerance), bandBottom = y(target.lufs - target.tolerance);
    ctx.fillStyle = 'rgba(233,238,222,0.07)';
    ctx.fillRect(0, bandTop, width, bandBottom - bandTop);
    ctx.strokeStyle = 'rgba(233,238,222,0.28)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(target.lufs)); ctx.lineTo(width, y(target.lufs)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = css.getPropertyValue('--contour').trim() || '#f2a65a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    contour.values.forEach((value, i) => {
      if (value <= -69) { started = false; return; }
      const x = ((i * contour.step) / total) * width;
      if (!started) { ctx.moveTo(x, y(value)); started = true; } else { ctx.lineTo(x, y(value)); }
    });
    ctx.stroke();
  }
}

/* ---------------------------------------------------------------- chapters on the waveform */

function drawFlags() {
  const total = activeDuration();
  const chapters = state.data?.episode?.chapters || [];
  el.flags.innerHTML = '';
  if (state.side !== 'master' || !total) return;
  chapters.forEach((chapter, index) => {
    const node = document.createElement('div');
    node.className = 'flag' + (index === state.activeChapter ? ' sel' : '');
    node.style.left = `${(chapter.start / total) * 100}%`;
    node.innerHTML = '<div class="stem"></div>';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = chapter.title || 'Chapter';
    node.append(tag);
    node.title = `${clock(chapter.start)} — ${chapter.title}\nDrag to move`;
    node.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      event.preventDefault();
      state.dragging = { index, node };
      node.setPointerCapture(event.pointerId);
    });
    node.addEventListener('pointermove', (event) => {
      if (state.dragging?.index !== index) return;
      const rect = el.waveWrap.getBoundingClientRect();
      const t = Math.max(0, Math.min(total, ((event.clientX - rect.left) / rect.width) * total));
      node.style.left = `${(t / total) * 100}%`;
      state.dragging.time = t;
    });
    node.addEventListener('pointerup', () => {
      if (state.dragging?.index !== index) return;
      const t = state.dragging.time;
      state.dragging = null;
      if (t == null) { seek(chapter.start); return; }
      const next = chapters.map((c, i) => (i === index ? { ...c, start: Math.round(t * 100) / 100 } : c));
      saveChapters(next);
    });
    el.flags.append(node);
  });
}

/* ---------------------------------------------------------------- transport */

function currentSrc() { return state.side === 'before' ? '/media/before' : '/media/master'; }

function setSide(side) {
  if (side === state.side) return;
  const from = activeDuration();
  const at = el.audio.currentTime;
  const episode = state.data?.episode;
  // Keep the same moment of the recording when switching: output time and session time differ
  // by everything that was cut.
  let target = at;
  if (episode) {
    target = side === 'before' ? outputToSession(episode, at) : sessionToOutput(episode, at);
    if (target == null) target = Math.min(at, activeDuration());
  }
  state.side = side;
  el.abBefore.classList.toggle('on', side === 'before');
  el.abMaster.classList.toggle('on', side === 'master');
  const playing = !el.audio.paused;
  el.audio.src = currentSrc();
  el.audio.addEventListener('loadedmetadata', () => {
    el.audio.currentTime = Math.max(0, Math.min(el.audio.duration || 0, target || 0));
    if (playing) el.audio.play().catch(() => {});
  }, { once: true });
  el.waveNote.textContent = side === 'before'
    ? 'What you handed in — the pink bands are what the edit takes out'
    : '';
  el.waveNote.classList.toggle('warn', side === 'before');
  void from;
  draw(); drawFlags(); tick();
}

function clipsOf(episode) {
  const clips = (episode.voice || []).filter((c) => Number(c.out) > Number(c.in));
  if (clips.length) return clips;
  const session = (episode.render?.sessionDuration) || 0;
  return session ? [{ in: 0, out: session }] : [];
}
function sessionToOutput(episode, when) {
  let cursor = Number(episode.voiceOffset || 0);
  for (const clip of clipsOf(episode)) {
    if (when >= clip.in && when <= clip.out) return cursor + (when - clip.in);
    cursor += clip.out - clip.in;
  }
  return null;
}
function outputToSession(episode, when) {
  let cursor = Number(episode.voiceOffset || 0);
  for (const clip of clipsOf(episode)) {
    const length = clip.out - clip.in;
    if (when >= cursor && when <= cursor + length) return clip.in + (when - cursor);
    cursor += length;
  }
  return null;
}

function seek(t) {
  const total = activeDuration();
  el.audio.currentTime = Math.max(0, Math.min(total || 0, t));
  tick();
}

function tick() {
  const total = activeDuration() || el.audio.duration || 0;
  const at = el.audio.currentTime || 0;
  el.playhead.style.left = total ? `${(at / total) * 100}%` : '0';
  el.at.textContent = clock(at);
  el.total.textContent = clock(total);
  const chapters = state.data?.episode?.chapters || [];
  let active = -1;
  chapters.forEach((c, i) => { if (at + 0.05 >= c.start) active = i; });
  if (active !== state.activeChapter && state.side === 'master') {
    state.activeChapter = active;
    [...el.chapters.children].forEach((li, i) => li.classList.toggle('on', i === active));
    [...el.flags.children].forEach((f, i) => f.classList.toggle('sel', i === active));
  }
  followTranscript(at);
}

function followTranscript(at) {
  if (state.side !== 'master') return;
  const cues = el.transcript.children;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const on = at >= Number(cue.dataset.start) && at < Number(cue.dataset.end);
    if (on !== cue.classList.contains('on')) {
      cue.classList.toggle('on', on);
      if (on && !SNAPSHOT && document.activeElement?.contentEditable !== 'true') {
        cue.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    if (on) {
      [...cue.querySelectorAll('.w')].forEach((w) => {
        w.classList.toggle('now', at >= Number(w.dataset.s) && at < Number(w.dataset.e));
      });
    }
  }
}

/* ---------------------------------------------------------------- rendering the panels */

function renderPhases(verdict) {
  el.phases.innerHTML = '';
  for (const phase of verdict?.phases || []) {
    const li = document.createElement('li');
    li.className = phase.state;
    li.innerHTML = '<span class="pip"></span>';
    li.append(document.createTextNode(phase.name));
    el.phases.append(li);
  }
}

function renderVerdict(verdict) {
  const errors = (verdict?.findings || []).filter((f) => f.severity === 'error').length;
  const warnings = (verdict?.findings || []).filter((f) => f.severity === 'warning').length;
  el.verdictText.textContent = verdict?.summary || 'waiting for the first save';
  el.verdict.className = 'verdict' + (verdict?.ready ? ' ready' : errors ? ' errors' : warnings ? ' warnings' : '');
  el.checkBadge.hidden = !(errors || warnings);
  el.checkBadge.textContent = String(errors || warnings);
  el.checkBadge.classList.toggle('warn', !errors && warnings > 0);

  el.checks.innerHTML = '';
  const words = { tool: 'Verified by', checks: 'Checked against', review: 'Reviewed against' };
  for (const entry of verdict?.evaluation || []) {
    const li = document.createElement('li');
    li.className = entry.passed === null ? 'info' : (entry.passed ? 'info' : 'error');
    const mark = entry.passed === null ? '—' : (entry.passed ? '\u2713' : '\u2717');
    li.innerHTML = '<span class="sev"></span><span></span>';
    li.firstChild.textContent = mark;
    li.lastChild.textContent = `${words[entry.method] || entry.method} ${entry.by} — ${entry.detail}`
      + (entry.gate ? '' : '  (advisory)');
    el.checks.append(li);
  }
  if (verdict?.evaluation?.length) {
    const rule = document.createElement('li');
    rule.className = 'info';
    rule.style.background = 'transparent';
    rule.style.border = '0';
    rule.style.padding = '10px 10px 2px';
    rule.innerHTML = '<span class="sev"></span><span></span>';
    rule.lastChild.textContent = 'Findings';
    rule.lastChild.style.fontWeight = '600';
    el.checks.append(rule);
  }
  const findings = (verdict?.findings || []);
  if (!findings.length) {
    const li = document.createElement('li');
    li.className = 'info';
    li.innerHTML = '<span class="sev">ok</span><span></span>';
    li.lastChild.textContent = 'Nothing measured is out of spec. What no measurement can see — '
      + 'whether a cut sounds natural, whether a chapter title is honest, whether the notes claim '
      + 'something that was never said — still needs ears.';
    el.checks.append(li);
  }
  for (const finding of findings) {
    const li = document.createElement('li');
    li.className = finding.severity;
    li.innerHTML = `<span class="sev">${finding.severity}</span><span></span>`;
    li.lastChild.textContent = finding.message;
    el.checks.append(li);
  }
}

function renderMeters(episode) {
  const render = episode?.render || {};
  const measured = render.measured, target = render.target;
  el.lufs.textContent = measured ? measured.lufs.toFixed(1) : '—';
  el.tp.textContent = measured ? measured.truePeakDb.toFixed(1) : '—';
  el.lra.textContent = measured ? measured.lra.toFixed(1) : '—';
  el.dur.textContent = render.duration ? clock(render.duration) : '—';
  const primary = el.lufs.closest('.meter');
  primary.classList.remove('on', 'off');
  if (measured && target) {
    const off = Math.abs(measured.lufs - target.lufs) > target.tolerance;
    primary.classList.add(off ? 'off' : 'on');
    el.targetLabel.textContent = `${target.preset} · ${target.lufs} ± ${target.tolerance} LU`;
    const lo = target.lufs - 6, hi = target.lufs + 6;
    const pct = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
    el.gaugeBand.style.left = pct(target.lufs - target.tolerance);
    el.gaugeBand.style.width = `${(2 * target.tolerance / (hi - lo)) * 100}%`;
    el.gaugeTarget.style.left = pct(target.lufs);
    el.gaugeNeedle.style.left = pct(measured.lufs);
  } else {
    el.targetLabel.textContent = 'integrated loudness';
  }
  const sources = episode?.sources || [];
  const voices = sources.filter((s) => (s.role || 'voice') === 'voice' && s.probe);
  // What it came in as, against what it is now: the whole point of the levelling, in one number.
  if (voices.length === 1) {
    el.was.textContent = voices[0].probe.lufs.toFixed(1);
  } else if (voices.length > 1) {
    const all = voices.map((s) => s.probe.lufs);
    el.was.textContent = `${Math.min(...all).toFixed(0)}…${Math.max(...all).toFixed(0)}`;
  } else {
    el.was.textContent = '—';
  }
  const worst = voices.filter((s) => s.probe.snrDb != null)
    .reduce((lo, s) => (lo == null || s.probe.snrDb < lo ? s.probe.snrDb : lo), null);
  el.sourceNote.textContent = sources.length
    ? sources.map((s) => `${s.id}${(s.role === 'music') ? ' (music)' : ''}`).join(' · ')
    : '—';
  el.sourceLabel.textContent = sources.length
    ? `${sources.length} source${sources.length === 1 ? '' : 's'}`
      + (worst != null ? ` · ${worst.toFixed(0)} dB over the room` : '')
    : 'sources';
  el.sourceNote.title = el.sourceNote.textContent;
}

function renderChapters(episode) {
  const chapters = episode?.chapters || [];
  el.chapterCount.textContent = chapters.length ? String(chapters.length) : '';
  el.chapters.innerHTML = '';
  if (!chapters.length) {
    el.chapters.innerHTML = '<li class="empty-note">No chapters yet. Press <kbd>C</kbd> at a moment in the episode to mark one.</li>';
    return;
  }
  chapters.forEach((chapter, index) => {
    const li = document.createElement('li');
    li.className = index === state.activeChapter ? 'on' : '';
    const t = document.createElement('span'); t.className = 't'; t.textContent = clock(chapter.start);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = chapter.title || 'Chapter';
    n.contentEditable = 'plaintext-only';
    n.spellcheck = true;
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button';
    x.textContent = '×'; x.title = 'remove this chapter';
    li.append(t, n, x);
    li.addEventListener('click', (event) => {
      if (event.target === n || event.target === x) return;
      seek(chapter.start);
    });
    n.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); n.blur(); }
      if (event.key === 'Escape') { n.textContent = chapter.title; n.blur(); }
      event.stopPropagation();
    });
    n.addEventListener('blur', () => {
      const title = n.textContent.trim();
      if (title === (chapter.title || '')) return;
      saveChapters(chapters.map((c, i) => (i === index ? { ...c, title } : c)));
    });
    x.addEventListener('click', (event) => {
      event.stopPropagation();
      saveChapters(chapters.filter((_, i) => i !== index));
    });
    el.chapters.append(li);
  });
}

function renderCuts(episode) {
  const cuts = episode?.removed || [];
  el.cutCount.textContent = cuts.length ? String(cuts.length) : '';
  el.cuts.innerHTML = '';
  if (!cuts.length) {
    el.cuts.innerHTML = '<li class="empty-note">Nothing has been cut.</li>';
    return;
  }
  const saved = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
  cuts.forEach((cut, index) => {
    const li = document.createElement('li');
    const t = document.createElement('span'); t.className = 't'; t.textContent = clock(cut.start);
    const why = document.createElement('span'); why.className = 'why';
    why.textContent = `${(cut.end - cut.start).toFixed(1)}s · ${cut.reason || 'cut'}`;
    const put = document.createElement('button'); put.type = 'button'; put.textContent = 'restore';
    put.addEventListener('click', async () => {
      const done = await post('/save', { kind: 'cuts', index, rev: state.data.rev });
      if (done) toast('restored — re-render to hear it');
    });
    li.append(t, why, put);
    li.addEventListener('mouseenter', () => { if (state.side === 'before') seek(cut.start); });
    el.cuts.append(li);
  });
  const note = document.createElement('li');
  note.className = 'empty-note';
  note.textContent = `${clock(saved)} taken out in total. Press B to hear what was there.`;
  el.cuts.append(note);
}

function renderTranscript(transcript) {
  el.transcript.innerHTML = '';
  if (!transcript?.segments?.length) {
    el.transcript.innerHTML = '<p class="empty-note" style="padding:14px">No transcript yet. It is written from the master, so the times line up with the published file.</p>';
    return;
  }
  const needle = state.find.toLowerCase();
  transcript.segments.forEach((segment, index) => {
    const row = document.createElement('div');
    row.className = 'cue' + (segment.edited ? ' edited' : '');
    row.dataset.start = segment.start;
    row.dataset.end = segment.end;
    if (needle && segment.text.toLowerCase().includes(needle)) row.classList.add('hit');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = clock(segment.start);
    t.title = 'jump here';
    t.addEventListener('click', () => { setSide('master'); seek(segment.start); });
    const x = document.createElement('span');
    x.className = 'x';
    x.contentEditable = 'plaintext-only';
    x.spellcheck = true;
    if (segment.words?.length) {
      segment.words.forEach((word, i) => {
        const w = document.createElement('span');
        w.className = 'w';
        w.dataset.s = word.s; w.dataset.e = word.e;
        // No space before a token that begins with punctuation, or the pane shows "20 ,000"
        // where the transcript file says "20,000".
        const glue = i > 0 && !/^([,.;:!?%)\]}’”]|-\w|'\w)/.test(word.w);
        w.textContent = (glue ? ' ' : '') + word.w;
        x.append(w);
      });
    } else {
      x.textContent = segment.text;
    }
    const original = segment.text;
    x.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); x.blur(); }
      if (event.key === 'Escape') { x.textContent = original; x.blur(); }
      event.stopPropagation();
    });
    x.addEventListener('blur', async () => {
      const text = x.textContent.replace(/\s+/g, ' ').trim();
      if (text === original.trim()) return;
      const done = await post('/save', { kind: 'transcript', index, text, rev: state.data.transcriptRev });
      if (done) toast('transcript saved — re-deliver to rewrite the captions');
    });
    row.append(t, x);
    el.transcript.append(row);
  });
}

function renderFiles(files) {
  el.files.innerHTML = '';
  if (!files.length) {
    el.files.innerHTML = '<li class="empty-note">Nothing delivered yet. `ep deliver` writes the files to upload.</li>';
    return;
  }
  for (const file of files) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = file.name;
    const size = document.createElement('span'); size.className = 'size'; size.textContent = bytes(file.bytes);
    const a = document.createElement('a');
    a.href = file.href; a.download = file.name; a.textContent = 'Download';
    li.append(name, size, a);
    el.files.append(li);
  }
}

async function saveChapters(chapters) {
  const done = await post('/save', { kind: 'chapters', chapters, rev: state.data.rev });
  if (done) toast('chapters saved');
}

/* ---------------------------------------------------------------- state */

function apply(data) {
  const previous = state.data;
  state.data = data;
  const episode = data.episode || {};

  el.title.textContent = episode.title || 'Episode Ready';
  el.show.textContent = [episode.show, episode.author].filter(Boolean).join(' · ')
    || (data.hasMaster ? 'no show name yet' : 'drop a recording in raw/ to begin');
  el.cover.hidden = !data.artwork;
  if (data.artwork && el.cover.getAttribute('src') !== data.artwork) el.cover.src = data.artwork;

  renderPhases(data.verdict);
  renderVerdict(data.verdict);
  renderMeters(episode);
  renderChapters(episode);
  renderCuts(episode);
  renderFiles(data.files || []);
  if (JSON.stringify(previous?.transcript) !== JSON.stringify(data.transcript)) {
    renderTranscript(data.transcript);
  }
  if (!state.notesDirty && el.notes.value !== data.notes) el.notes.value = data.notes || '';

  state.duration = episode.render?.duration || 0;
  // The recording shows the moment it is measured, before anything has been rendered: the pane
  // has to move as the work lands, not wait for the end of it.
  if (!data.hasMaster && data.hasBefore && state.side !== 'before') state.side = 'before';
  el.abBefore.classList.toggle('on', state.side === 'before');
  el.abMaster.classList.toggle('on', state.side === 'master');
  el.abMaster.disabled = !data.hasMaster;
  el.abMaster.style.opacity = data.hasMaster ? '' : '0.4';
  el.empty.hidden = data.hasMaster || data.hasBefore;
  el.abBefore.disabled = !data.hasBefore;
  el.abBefore.style.opacity = data.hasBefore ? '' : '0.4';
  el.rerender.hidden = !(data.stale && data.hasMaster);
  if (!data.hasMaster && data.hasBefore) {
    el.waveNote.textContent = 'Your recording, as it arrived — nothing has been done to it yet';
    el.waveNote.classList.add('warn');
  } else if (state.side === 'before') {
    el.waveNote.textContent = 'What you handed in — the pink bands are what the edit takes out';
    el.waveNote.classList.add('warn');
  } else {
    el.waveNote.textContent = '';
    el.waveNote.classList.remove('warn');
  }
  if (data.stale) {
    el.waveNote.textContent = 'The plan changed since this render — re-render to hear it';
    el.waveNote.classList.add('warn');
  }

  if (!data.hasMaster) {
    el.empty.innerHTML = '<h3>Put your recording in <code>raw/</code></h3>'
      + '<p>Anything ffmpeg reads: wav, mp3, m4a, flac, aiff, or the audio out of a video. '
      + 'One file per speaker is fine — they get matched and mixed. Then say what you want the '
      + 'episode to be, and it appears here as it is made.</p>';
  }

  const src = currentSrc();
  const mtime = state.side === 'before' ? data.beforeMtime : data.masterMtime;
  if (data.hasMaster && mtime && el.audio.dataset.mtime !== String(mtime)) {
    const at = el.audio.currentTime;
    el.audio.dataset.mtime = String(mtime);
    el.audio.src = `${src}?v=${mtime}`;
    el.audio.addEventListener('loadedmetadata', () => { el.audio.currentTime = at; }, { once: true });
  }
  renderJob(data.job);
}

function renderJob(job) {
  const running = job?.running;
  el.job.hidden = !running;
  if (running) el.jobStep.textContent = job.step || 'working';
}

async function refresh() {
  const res = await fetch('/state.json', { cache: 'no-store' });
  const data = await res.json();
  // Only ask for a waveform the state says is there: a speculative fetch is a console 404, and a
  // console full of 404s is how a broken pane hides among the healthy ones.
  const [master, before] = await Promise.all([
    data.hasMaster ? loadPeaks('master') : null,
    data.hasBefore ? loadPeaks('before') : null,
  ]);
  state.peaks.master = master;
  state.peaks.before = before;
  if (!data.hasBefore && state.side === 'before') state.side = 'master';
  apply(data);
  draw(); drawFlags(); tick();
}

/* ---------------------------------------------------------------- wiring */

el.play.addEventListener('click', () => (el.audio.paused ? el.audio.play() : el.audio.pause()));
el.back.addEventListener('click', () => seek(el.audio.currentTime - 5));
el.fwd.addEventListener('click', () => seek(el.audio.currentTime + 5));
el.audio.addEventListener('play', () => { el.play.innerHTML = '&#10073;&#10073;'; });
el.audio.addEventListener('pause', () => { el.play.innerHTML = '&#9654;'; });
el.audio.addEventListener('timeupdate', () => {
  if (state.looping && state.selection && el.audio.currentTime > state.selection.to) {
    el.audio.currentTime = state.selection.from;
  }
  tick();
});
el.abBefore.addEventListener('click', () => setSide('before'));
el.abMaster.addEventListener('click', () => setSide('master'));
el.loop.addEventListener('click', () => {
  state.looping = !state.looping && !!state.selection;
  el.loop.classList.toggle('on', state.looping);
  if (state.looping) toast('looping the selection');
});
el.addChapter.addEventListener('click', () => addChapterHere());
el.rerender.addEventListener('click', async () => {
  const done = await post('/render', {});
  if (done?.started) toast('re-rendering');
});

function addChapterHere() {
  const chapters = [...(state.data?.episode?.chapters || [])];
  const at = Math.round((state.side === 'master' ? el.audio.currentTime : 0) * 100) / 100;
  if (chapters.some((c) => Math.abs(c.start - at) < 1)) { toast('there is already a chapter here'); return; }
  chapters.push({ start: at, title: 'New chapter' });
  saveChapters(chapters.sort((a, b) => a.start - b.start));
}

for (const button of document.querySelectorAll('.speeds .chip')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.speeds .chip').forEach((b) => b.classList.remove('on'));
    button.classList.add('on');
    el.audio.playbackRate = Number(button.dataset.rate);
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    state.tab = tab.dataset.tab;
    for (const name of ['transcript', 'notes', 'files', 'checks']) {
      $(`tab-${name}`).hidden = name !== state.tab;
    }
  });
}

el.find.addEventListener('input', () => {
  state.find = el.find.value.trim();
  renderTranscript(state.data?.transcript);
});

el.notes.addEventListener('input', () => {
  state.notesDirty = true;
  el.notesSave.hidden = false;
  el.notesState.textContent = 'shownotes.md — unsaved';
});
el.notes.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); saveNotes(); }
  event.stopPropagation();
});
el.notesSave.addEventListener('click', () => saveNotes());
async function saveNotes() {
  const done = await post('/save', { kind: 'notes', text: el.notes.value, rev: state.data.notesRev });
  if (done) {
    state.notesDirty = false;
    el.notesSave.hidden = true;
    el.notesState.textContent = 'shownotes.md — saved';
    toast('show notes saved');
  }
}

// Scrub, and shift-drag to select a region to loop.
let scrubbing = null;
el.waveWrap.addEventListener('pointerdown', (event) => {
  if (state.dragging) return;
  const rect = el.waveWrap.getBoundingClientRect();
  const t = ((event.clientX - rect.left) / rect.width) * activeDuration();
  if (event.shiftKey) {
    scrubbing = { mode: 'select', from: t };
  } else {
    scrubbing = { mode: 'seek' };
    seek(t);
  }
  el.waveWrap.setPointerCapture(event.pointerId);
});
el.waveWrap.addEventListener('pointermove', (event) => {
  const rect = el.waveWrap.getBoundingClientRect();
  const total = activeDuration();
  const t = Math.max(0, Math.min(total, ((event.clientX - rect.left) / rect.width) * total));
  el.hoverLine.hidden = false;
  el.hoverLine.style.left = `${(t / total) * 100}%`;
  el.hoverTime.textContent = clock(t);
  if (!scrubbing) return;
  if (scrubbing.mode === 'seek') seek(t);
  else {
    const from = Math.min(scrubbing.from, t), to = Math.max(scrubbing.from, t);
    state.selection = { from, to };
    el.selection.hidden = false;
    el.selection.style.left = `${(from / total) * 100}%`;
    el.selection.style.width = `${((to - from) / total) * 100}%`;
  }
});
el.waveWrap.addEventListener('pointerup', () => {
  if (scrubbing?.mode === 'select' && state.selection) {
    seek(state.selection.from);
    state.looping = true;
    el.loop.classList.add('on');
    toast(`looping ${clock(state.selection.from)}–${clock(state.selection.to)}`);
  }
  scrubbing = null;
});
el.waveWrap.addEventListener('pointerleave', () => { el.hoverLine.hidden = true; });

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea') || event.target.isContentEditable) return;
  const step = event.shiftKey ? 30 : 5;
  if (event.key === ' ') { event.preventDefault(); el.audio.paused ? el.audio.play() : el.audio.pause(); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(el.audio.currentTime - step); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seek(el.audio.currentTime + step); }
  else if (event.key === 'b' || event.key === 'B') { setSide(state.side === 'master' ? 'before' : 'master'); }
  else if (event.key === 'c' || event.key === 'C') { addChapterHere(); }
  else if (event.key === 'l' || event.key === 'L') { el.loop.click(); }
  else if (event.key === 'Escape') {
    state.selection = null; state.looping = false;
    el.selection.hidden = true; el.loop.classList.remove('on');
  }
});

window.addEventListener('resize', () => { draw(); drawFlags(); });
const scheme = window.matchMedia('(prefers-color-scheme: dark)');
scheme.addEventListener?.('change', () => draw());

if (!SNAPSHOT) {
  const events = new EventSource('/events');
  let pending = null;
  events.addEventListener('change', () => {
    clearTimeout(pending);
    pending = setTimeout(() => refresh(), 180);
  });
  events.addEventListener('job', (event) => {
    try { renderJob(JSON.parse(event.data)); } catch { /* the next state.json will say */ }
  });
}

function openRequestedView() {
  if (WANT.tab && document.querySelector(`.tab[data-tab="${WANT.tab}"]`)) {
    document.querySelector(`.tab[data-tab="${WANT.tab}"]`).click();
  }
  if (WANT.side === 'before' && state.data?.hasBefore) setSide('before');
  if (WANT.at > 0) {
    const go = () => seek(WANT.at);
    if (el.audio.readyState >= 1) go();
    else el.audio.addEventListener('loadedmetadata', go, { once: true });
  }
}

refresh().then(openRequestedView);
