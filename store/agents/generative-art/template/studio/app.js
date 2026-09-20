const $ = selector => document.querySelector(selector);
const original = validateProject(JSON.parse($('#fieldwork-data').textContent));
const modelSource = $('#fieldwork-model').textContent;
const storageKey = `fieldwork:${original.id}`;
let project = structuredClone(original), format = 0, svgText = '', artURL, worker, renderSequence = 0;
let undoStack = [], redoStack = [], pendingDraft, preserveDraft = false, toastTimer, renderTimer;
const exportButtons = ['export-svg', 'export-png', 'export-kit', 'export-edition'];
const snapshot = () => ({ project: structuredClone(project), format });
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
function signal(type, extra = {}) { if (parent !== window) parent.postMessage({ type, seed: project.seed, ...extra }, '*'); }
function persist() {
  if (preserveDraft) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ baseRevision: original.revision, ...snapshot() })); $('#draft-status').textContent = 'Draft saved on this device'; }
  catch { $('#draft-status').textContent = 'Save project to keep your changes'; }
}
function changed(mutate, { rebuild = false } = {}) {
  undoStack.push(snapshot()); if (undoStack.length > 24) undoStack.shift(); redoStack = [];
  mutate(); if (rebuild) buildUI(); else syncFields();
  persist(); scheduleRender();
}
function restore(state) { project = validateProject(state.project); format = Math.max(0, Math.min(project.formats.length - 1, state.format || 0)); buildUI(); persist(); scheduleRender(); }
function saveFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function baseName(suffix = '') { return `${filename(project.title)}-${filename(project.formats[format].name)}-${filename(project.seed)}${suffix}`; }
function portableProject() { return { ...structuredClone(project), view: { format } }; }
function syncFields() {
  $('#width').value = project.formats[format].width; $('#height').value = project.formats[format].height;
  $('#dimensions').textContent = `${$('#width').value} × ${$('#height').value}`;
  $('#seed').value = project.seed;
  $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length;
  for (const b of $('#formats').children) b.setAttribute('aria-pressed', Number(b.dataset.format) === format);
  const url = new URL(location.href); url.searchParams.set('seed', project.seed); history.replaceState(null, '', url);
  signal('harness:state');
}
function buildUI() {
  document.title = `${project.title} · Fieldwork`;
  $('#project-title').textContent = project.title; $('#brief').textContent = project.brief;
  $('#notes').textContent = project.notes || 'Your drawing program is original to this project. Ask the agent to change its visual language, composition or outputs.';
  $('#variation-panel').hidden = project.variations === false;
  $('#edition-panel').hidden = project.variations === false;
  $('#formats').replaceChildren();
  project.formats.forEach((f, i) => { const b = document.createElement('button'); b.textContent = f.name; b.dataset.format = i; b.onclick = () => changed(() => { format = i; }); $('#formats').append(b); });
  $('#controls').replaceChildren();
  for (const c of project.controls) {
    const label = document.createElement('label'), top = document.createElement('span'), title = document.createElement('span'), out = document.createElement('output');
    label.className = 'field'; top.className = 'field-top'; title.textContent = c.label; top.append(title);
    let input;
    if (c.type === 'select') { input = document.createElement('select'); for (const option of c.options) { const el = document.createElement('option'); el.textContent = option; input.append(el); } }
    else if (c.type === 'text' && c.multiline) input = document.createElement('textarea');
    else { input = document.createElement('input'); input.type = c.type === 'toggle' ? 'checkbox' : c.type === 'text' ? 'text' : c.type; }
    input.id = 'control-' + c.key;
    if (c.type === 'range') { input.min = c.min; input.max = c.max; input.step = c.step ?? 1; out.value = c.value; top.append(out); }
    if (c.type === 'toggle') input.checked = c.value; else input.value = c.value;
    if (c.type === 'text') input.maxLength = 4000;
    input.addEventListener(c.type === 'color' || c.type === 'range' || c.type === 'text' ? 'input' : 'change', () => changed(() => {
      c.value = c.type === 'toggle' ? input.checked : c.type === 'range' ? Number(input.value) : input.value; out.value = c.value;
    }));
    label.append(top, input); $('#controls').append(label);
  }
  $('#assets').replaceChildren();
  for (const asset of project.assets) {
    const block = document.createElement('div'), name = document.createElement('p'), row = document.createElement('div'), choose = document.createElement('button'), remove = document.createElement('button'), input = document.createElement('input');
    block.className = 'field'; name.textContent = asset.label; row.className = 'asset-row'; choose.textContent = asset.data ? 'Replace image' : 'Use your image'; remove.textContent = 'Remove'; remove.disabled = !asset.data;
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/svg+xml'; input.hidden = true; input.setAttribute('aria-label', asset.label);
    choose.onclick = () => input.click();
    input.onchange = async () => {
      try {
        const file = input.files[0]; if (!file) return;
        if (file.size > 12000000) throw new Error('Choose an image under 12 MB.');
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        const candidate = structuredClone(project); candidate.assets.find(a => a.key === asset.key).data = data; validateProject(candidate);
        changed(() => { asset.data = data; }, { rebuild: true });
      } catch (error) { toast(error.message || 'Could not read that image.'); }
    };
    remove.onclick = () => changed(() => { delete asset.data; }, { rebuild: true });
    row.append(choose, remove); block.append(name, row, input); $('#assets').append(block);
  }
  syncFields();
}
function checkSVG(text) {
  const externalURL = value => [...value.matchAll(/url\(\s*([^)]*)\)/gi)].some(([, url]) => !/^(#|data:)/i.test(url.trim().replace(/^['"]|['"]$/g, '')));
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Artwork returned invalid SVG. Ask the agent to fix the drawing program.');
  for (const node of doc.querySelectorAll('*')) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animatetransform', 'set'].includes(node.localName.toLowerCase())) throw new Error('This studio exports static vector artwork. Remove active SVG elements.');
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name) || (/(^|:)href$/.test(attr.name) && !/^(#|data:image\/)/.test(attr.value))) throw new Error('Embed artwork assets so exports work offline.');
      if (externalURL(attr.value)) throw new Error('External resources are not portable. Embed them in the project.');
    }
    if (node.localName === 'style' && (/@import/i.test(node.textContent) || externalURL(node.textContent))) throw new Error('Embed fonts and images; external stylesheets cannot be exported.');
  }
  return text;
}
function renderInWorker(candidate, options = {}) {
  return new Promise((resolve, reject) => {
    const script = modelSource + '\nonmessage = e => { try { postMessage({ svg: renderProject(e.data.project, e.data.options) }); } catch (error) { postMessage({ error: error.message }); } };';
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    const task = new Worker(url); URL.revokeObjectURL(url);
    const timer = setTimeout(() => { task.terminate(); reject(new Error('This drawing took longer than 5 seconds. Ask the agent to simplify it.')); }, 5000);
    const done = fn => value => { clearTimeout(timer); task.terminate(); fn(value); };
    task.onmessage = event => done(event.data.error ? reject : resolve)(event.data.error ? new Error(event.data.error) : event.data.svg);
    task.onerror = event => done(reject)(new Error(event.message));
    task.postMessage({ project: candidate, options });
  });
}
function scheduleRender() { ++renderSequence; for (const id of exportButtons) $('#' + id).disabled = true; clearTimeout(renderTimer); renderTimer = setTimeout(render, 80); }
async function render() {
  const sequence = ++renderSequence;
  for (const id of exportButtons) $('#' + id).disabled = true;
  $('#render-status').textContent = 'Drawing your project…';
  try {
    const text = checkSVG(await renderInWorker(project, { format }));
    if (sequence !== renderSequence) return;
    const image = $('#art'), nextURL = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The vector image could not be displayed.')); image.src = nextURL; });
    if (artURL) URL.revokeObjectURL(artURL); artURL = nextURL;
    if (sequence !== renderSequence) return;
    svgText = text; $('#render-error').hidden = true;
    $('#render-status').textContent = 'Original vector artwork · ready to export';
    for (const id of exportButtons) $('#' + id).disabled = false;
    document.body.dataset.ready = 'true'; signal('harness:ready');
  } catch (error) {
    if (sequence !== renderSequence) return;
    $('#render-error').textContent = error.message; $('#render-error').hidden = false;
    $('#render-status').textContent = 'Drawing needs a fix · exports paused'; signal('harness:error', { message: error.message });
  }
}
async function raster(text, width, height, scale = Number($('#png-scale').value)) {
  const w = Math.round(width * scale), h = Math.round(height * scale);
  if (w > 8192 || h > 8192 || w * h > 32000000) throw new Error('PNG is too large. Choose a smaller scale or artboard (maximum 32 megapixels).');
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG export failed.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
function guard(task) { return async () => { try { await task(); } catch (error) { toast(error.message); } }; }
$('#export-svg').onclick = () => saveFile(baseName('.svg'), svgText, 'image/svg+xml');
$('#export-png').onclick = guard(async () => { const f = project.formats[format]; saveFile(baseName('.png'), await raster(svgText, f.width, f.height)); toast('PNG exported at your chosen size.'); });
$('#save-project').onclick = () => { saveFile(`${filename(project.title)}.fieldwork.json`, JSON.stringify(portableProject(), null, 2), 'application/json'); toast('Editable project saved, including your images and drawing program.'); };
$('#open-project').onclick = () => $('#project-file').click();
$('#project-file').onchange = guard(async () => {
  const file = $('#project-file').files[0]; if (!file) return;
  if (file.size > 64000000) throw new Error('Project is too large (maximum 64 MB).');
  const next = validateProject(JSON.parse(await file.text()));
  changed(() => { project = next; format = Math.min(next.view?.format || 0, next.formats.length - 1); }, { rebuild: true });
  $('#project-file').value = ''; toast('Project opened.');
});
$('#export-html').onclick = () => {
  const doc = document.documentElement.cloneNode(true);
  doc.querySelector('#fieldwork-data').textContent = JSON.stringify(portableProject()).replace(/</g, '\\u003c');
  doc.querySelector('#revision-notice').hidden = true; doc.querySelector('#art').removeAttribute('src');
  doc.querySelector('#toast').className = ''; doc.querySelector('body').removeAttribute('data-ready');
  saveFile(`${filename(project.title)}-studio.html`, '<!doctype html>\n' + doc.outerHTML, 'text/html');
  toast('Portable studio saved. Open it directly in a browser.');
};
function sourceFiles() {
  const p = portableProject(), manifest = structuredClone(p); delete manifest.code; delete manifest.revision; delete manifest.view;
  return [['project.fieldwork.json', JSON.stringify(p, null, 2)], ['source/project.json', JSON.stringify(manifest, null, 2)], ['source/artwork.js', p.code], ['README.txt', `${p.title}\n\n${p.brief}\n\nOpen SVG in a vector editor. PNGs are ready for publishing. Open project.fieldwork.json in Fieldwork to revise the project; it contains your renderer and embedded images. The source folder contains editable project settings and drawing code. System fonts can vary between machines.\n`]];
}
$('#export-kit').onclick = guard(async () => {
  const candidate = structuredClone(project), files = sourceFiles(), scale = Number($('#png-scale').value);
  $('#export-kit').disabled = true;
  try {
    for (let i = 0; i < candidate.formats.length; i++) {
      const f = candidate.formats[i], name = `${String(i + 1).padStart(2, '0')}-${filename(f.name)}`, text = checkSVG(await renderInWorker(candidate, { format: i }));
      files.push([`${name}.svg`, text], [`${name}.png`, await (await raster(text, f.width, f.height, scale)).arrayBuffer()]);
    }
    saveFile(`${filename(candidate.title)}-delivery.zip`, zipFiles(files)); toast(`${candidate.formats.length} formats exported as SVG and PNG, with editable source.`);
  } finally { $('#export-kit').disabled = false; }
});
$('#export-edition').onclick = guard(async () => {
  const count = Number($('#edition-count').value);
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('Choose an edition of 1–24.');
  const candidate = structuredClone(project), chosenFormat = format, files = sourceFiles(), seeds = [];
  for (let i = 0; i < count; i++) {
    const seed = i === 0 ? candidate.seed : /^\d{1,9}$/.test(candidate.seed) ? String(Number(candidate.seed) + i) : `${candidate.seed}.${i}`;
    seeds.push(seed); files.push([`edition/${String(i + 1).padStart(2, '0')}-${filename(seed)}.svg`, checkSVG(await renderInWorker(candidate, { format: chosenFormat, seed }))]);
  }
  files.push(['edition.json', JSON.stringify({ seeds, format: candidate.formats[chosenFormat], project: candidate.id }, null, 2)]);
  saveFile(`${filename(candidate.title)}-edition.zip`, zipFiles(files)); toast(`${count} reproducible vectors exported.`);
});
$('#seed-form').onsubmit = event => { event.preventDefault(); changed(() => { project.seed = $('#seed').value.trim().slice(0, 128) || '1'; }); };
$('#next-seed').onclick = () => changed(() => { project.seed = /^\d{1,9}$/.test(project.seed) ? String(Number(project.seed) + 1) : `${project.seed.slice(0, 115)}.${Math.floor(artRandom(project.seed, 'next')() * 1000000)}`; });
for (const dimension of ['width', 'height']) $('#' + dimension).onchange = () => {
  const value = Number($('#' + dimension).value);
  if (!Number.isInteger(value) || value < 64 || value > 8192) { toast('Use a size from 64 to 8192 pixels.'); syncFields(); return; }
  changed(() => { project.formats[format][dimension] = value; });
};
$('#undo').onclick = () => { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); };
$('#redo').onclick = () => { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); };
$('#reset-project').onclick = () => changed(() => { project = structuredClone(original); format = 0; }, { rebuild: true });
$('#use-revision').onclick = () => { preserveDraft = false; $('#revision-notice').hidden = true; persist(); };
$('#keep-draft').onclick = () => { preserveDraft = false; $('#revision-notice').hidden = true; restore(pendingDraft); };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved) {
    saved.project = validateProject(saved.project);
    if (saved.baseRevision === original.revision) { project = saved.project; format = Math.min(saved.format || 0, project.formats.length - 1); }
    else { pendingDraft = saved; preserveDraft = true; $('#revision-notice').hidden = false; }
  }
} catch { /* A blocked store or an old draft never prevents opening the project. */ }
const querySeed = new URLSearchParams(location.search).get('seed'); if (querySeed) project.seed = querySeed.slice(0, 128);
addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.target.closest('input,textarea,select')) { e.preventDefault(); $('#' + (e.shiftKey ? 'redo' : 'undo')).click(); } });
window.fieldwork = {
  getProject: () => portableProject(), getSVG: () => svgText, validateProject,
  render: async (options = {}) => checkSVG(await renderInWorker(project, { format, ...options })),
  async deliver(options, scale = 1) {
    const f = project.formats[options.format || 0], text = checkSVG(await renderInWorker(project, options));
    const blob = await raster(text, f.width, f.height, scale);
    const png = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
    return { svg: text, png, width: f.width * scale, height: f.height * scale };
  },
};
buildUI(); render();
