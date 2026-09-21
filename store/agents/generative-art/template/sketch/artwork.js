// This program belongs to this brief. Replace it entirely for a different idea.
// Return SVG children. width/height are the current artboard; values are user edits.
const { el, text } = svg, r = rng('flowers'), w = width, h = height;
const wide = w / h > 1.7, square = !wide && w / h > .85;
const pad = w * .065, base = Math.min(w, h);
const parts = [el('rect', { width: w, height: h, fill: values.paper })];
const flower = (x, y, radius, petals, rotation, color) => {
  let path = '';
  const steps = petals * 24, jitter = values.wildness / 100;
  const phase = r() * 6.283;
  for (let i = 0; i <= steps; i++) {
    const angle = i / steps * Math.PI * 2;
    const lobes = .57 + .43 * (.5 + .5 * Math.cos(angle * petals));
    const rad = radius * lobes * (1 + Math.sin(angle * 3 + phase) * .13 * jitter);
    path += `${i ? 'L' : 'M'}${(Math.cos(angle) * rad).toFixed(2)},${(Math.sin(angle) * rad).toFixed(2)} `;
  }
  return el('g', { transform: `translate(${x} ${y}) rotate(${rotation})` }, [
    el('path', { d: path + 'Z', fill: color }),
    el('circle', { r: radius * .24, fill: values.accent }),
    ...Array.from({ length: 32 }, () => { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius * .18; return el('circle', { cx: Math.cos(a) * d, cy: Math.sin(a) * d, r: radius * .012, fill: values.ink }); }),
  ]);
};
const type = { fill: values.ink, 'font-family': 'Arial, Helvetica, sans-serif' };
parts.push(text('INDEPENDENT SOUND / AFTER DARK', { ...type, x: pad, y: h * .066, 'font-size': base * .015, 'letter-spacing': base * .002 }));
if (wide) {
  parts.push(flower(w * .77, h * .45, h * .35, values.petals, -20, values.flower));
  parts.push(flower(w * .94, h * .20, h * .15, 6, 0, values.ink));
} else {
  parts.push(el('path', { d: `M ${w * .50} ${h * (square ? .55 : .59)} Q ${w * .25} ${h * .45} ${w * .65} ${h * .27}`, fill: 'none', stroke: values.ink, 'stroke-width': w * .026 }));
  parts.push(flower(w * .66, h * (square ? .27 : .28), w * (square ? .215 : .30), values.petals, -18, values.flower));
  parts.push(flower(w * .25, h * (square ? .37 : .40), w * (square ? .15 : .17), Math.max(5, values.petals - 2), 20, values.ink));
  const leafY = h * (square ? .44 : .50);
  parts.push(el('ellipse', { cx: w * .53, cy: leafY, rx: w * (square ? .07 : .085), ry: w * (square ? .135 : .19), fill: values.ink, transform: `rotate(57 ${w * .53} ${leafY})` }));
}
const words = values.headline.trim().split(/\s+/), midpoint = Math.ceil(words.length / 2);
const lines = words.length > 1 ? [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')] : [words[0] || 'UNTITLED'];
const maxWidth = w * (wide ? .52 : .88), font = Math.min(base * (wide ? .195 : square ? .17 : .18), maxWidth / Math.max(...lines.map(s => s.length)) * 1.48);
const baseline = h * (wide ? .39 : square ? .70 : .72);
lines.forEach((line, i) => parts.push(text(line, { ...type, x: pad, y: baseline + i * font * .90, 'font-size': font, 'font-weight': '900', 'letter-spacing': -font * .05 })));
parts.push(el('line', { x1: pad, x2: w - pad, y1: h * .89, y2: h * .89, stroke: values.ink, 'stroke-width': Math.max(1, base * .0014) }));
parts.push(text(values.details, { ...type, x: pad, y: h * .925, 'font-size': Math.min(base * .017, (w - pad * 2) / Math.max(values.details.length, 1) * 1.6), 'font-weight': 700, 'letter-spacing': base * .001 }));
parts.push(text(values.lineup, { ...type, x: pad, y: h * .96, 'font-size': Math.min(base * .013, (w - pad * 2) / Math.max(values.lineup.length, 1) * 1.6) }));
if (assets.logo) parts.push(el('image', { href: assets.logo, x: w - pad - base * .08, y: h * .036, width: base * .08, height: base * .055, preserveAspectRatio: 'xMidYMid meet' }));
return parts.join('');
