// Shared by the authoring tools, preview worker and exported projects.
export const ART_SPEC = 'fieldwork/1';
const kinds = new Set(['text', 'color', 'range', 'select', 'toggle']);
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export function validateProject(input) {
  const p = structuredClone(input);
  if (!p || p.spec !== ART_SPEC) throw new Error('This is not a Fieldwork project.');
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(p.id)) throw new Error('Project needs a stable id.');
  for (const name of ['title', 'brief']) if (typeof p[name] !== 'string' || !p[name].trim() || p[name].length > 6000) throw new Error(`Invalid ${name}.`);
  if (typeof p.code !== 'string' || !p.code.trim() || p.code.length > 500000) throw new Error('The project needs an artwork.js renderer.');
  // Compile only. Actual rendering happens in a terminable browser worker.
  new Function('width', 'height', 'seed', 'values', 'assets', 'rng', 'svg', '"use strict";\n' + p.code);
  if (!Array.isArray(p.formats) || !p.formats.length || p.formats.length > 12) throw new Error('Provide 1–12 output formats.');
  for (const f of p.formats) {
    if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 80) throw new Error('Name each format.');
    for (const k of ['width', 'height']) if (!Number.isInteger(f[k]) || f[k] < 64 || f[k] > 8192) throw new Error('Artboards must be 64–8192 pixels per side.');
  }
  if (!Array.isArray(p.controls) || p.controls.length > 40) throw new Error('Provide at most 40 editable controls.');
  const ids = new Set();
  for (const c of p.controls) {
    if (!keyPattern.test(c.key) || ids.has(c.key) || !kinds.has(c.type) || typeof c.label !== 'string') throw new Error('Invalid or duplicate project control.');
    ids.add(c.key);
    if (c.type === 'range' && (![c.min, c.max, c.step ?? 1].every(Number.isFinite) || c.max <= c.min || (c.step ?? 1) <= 0)) throw new Error(`Invalid range: ${c.key}.`);
    if (c.type === 'select' && (!Array.isArray(c.options) || !c.options.length || c.options.length > 50 || c.options.some(x => typeof x !== 'string'))) throw new Error(`Invalid choices: ${c.key}.`);
    checkedValue(c, c.value);
  }
  p.assets ??= [];
  if (!Array.isArray(p.assets) || p.assets.length > 12) throw new Error('Provide at most 12 image assets.');
  ids.clear();
  for (const a of p.assets) {
    if (!keyPattern.test(a.key) || ids.has(a.key) || typeof a.label !== 'string') throw new Error('Invalid asset slot.');
    ids.add(a.key);
    if (a.data && (typeof a.data !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(a.data) || a.data.length > 16000000)) throw new Error(`Embed ${a.label} as a PNG, JPEG, WebP or SVG image.`);
  }
  p.seed = String(p.seed ?? '1').slice(0, 128);
  if (p.variations !== undefined && typeof p.variations !== 'boolean') throw new Error('variations must be a boolean.');
  if (JSON.stringify(p).length > 28000000) throw new Error('Keep the editable project under 28 MB. Use smaller embedded images.');
  return p;
}
export function checkedValue(c, value) {
  if (c.type === 'range' && (!Number.isFinite(value) || value < c.min || value > c.max)) throw new Error(`${c.label} is out of range.`);
  if (c.type === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error(`Invalid ${c.label} color.`);
  if (c.type === 'text' && (typeof value !== 'string' || value.length > 4000)) throw new Error(`${c.label} must be text under 4000 characters.`);
  if (c.type === 'select' && !c.options.includes(value)) throw new Error(`Invalid ${c.label} choice.`);
  if (c.type === 'toggle' && typeof value !== 'boolean') throw new Error(`Invalid ${c.label} toggle.`);
  return value;
}
export function artRandom(seed, namespace = '') {
  let n = 2166136261;
  for (const c of String(seed) + ':' + namespace) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, n | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function xml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }
export const svg = {
  escape: xml,
  el(tag, attrs = {}, children = '') {
    if (!/^[a-zA-Z][a-zA-Z0-9:-]*$/.test(tag)) throw new Error('Invalid SVG element.');
    return `<${tag}${Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${xml(v)}"`).join('')}>${Array.isArray(children) ? children.join('') : children}</${tag}>`;
  },
  text(value, attrs = {}) { return svg.el('text', attrs, xml(value)); },
};
export function renderProject(project, { format = 0, width, height, seed = project.seed, values = {} } = {}) {
  const f = project.formats[format];
  if (!f) throw new Error('Choose a valid format.');
  width ??= f.width; height ??= f.height;
  if (![width, height].every(n => Number.isInteger(n) && n >= 64 && n <= 8192)) throw new Error('Invalid artboard size.');
  const resolved = Object.fromEntries(project.controls.map(c => [c.key, checkedValue(c, values[c.key] ?? c.value)]));
  const assets = Object.fromEntries(project.assets.map(a => [a.key, a.data || '']));
  const body = new Function('width', 'height', 'seed', 'values', 'assets', 'rng', 'svg', '"use strict";\n' + project.code)(width, height, String(seed), resolved, assets, name => artRandom(seed, name), svg);
  if (typeof body !== 'string' || !body.trim() || body.length > 24000000) throw new Error('The renderer must return SVG artwork under 24 MB.');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xml(project.title)}</title>${body}</svg>`;
}
export function filename(name) { return String(name).normalize('NFKD').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'artwork'; }
// ZIP STORE: portable editable delivery without a runtime dependency or a cloud service.
export function zipFiles(files) {
  const enc = new TextEncoder(), chunks = [], central = []; let offset = 0;
  for (const [name, body] of files) {
    const path = enc.encode(name), bytes = typeof body === 'string' ? enc.encode(body) : new Uint8Array(body);
    let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + path.length), v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(12, 33, true);
    v.setUint32(14, crc, true); v.setUint32(18, bytes.length, true); v.setUint32(22, bytes.length, true); v.setUint16(26, path.length, true); header.set(path, 30);
    const row = new Uint8Array(46 + path.length), c = new DataView(row.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, path.length, true); c.setUint32(42, offset, true); row.set(path, 46);
    chunks.push(header, bytes); central.push(row); offset += header.length + bytes.length;
  }
  const length = central.reduce((n, row) => n + row.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, length, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
