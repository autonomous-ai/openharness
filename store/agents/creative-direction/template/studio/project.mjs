// Forme projects are editable design data. There is no preset-style switch or remote runtime.
export const SPEC = 'forme/1';
const key = /^[a-z][a-z0-9_-]{0,63}$/;
const hex = /^#[0-9a-f]{6}$/i;
export const clone = value => structuredClone(value);
export const xml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export const filename = value => String(value).normalize('NFKD').replace(/[^a-zA-Z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100) || 'design';
const num = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
function text(value, label, max = 4000) { if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${label}.`); }
function named(value, label) { if (!key.test(value)) throw new Error(`Invalid ${label} id.`); }
export function validateProject(input) {
  const p = clone(input);
  if (!p || p.spec !== SPEC) throw new Error('Open a Forme brand project.');
  named(p.id,'project'); text(p.title,'title',120); text(p.brief,'brief',12000);
  if (!p.title.trim() || !p.copy || typeof p.copy !== 'object' || Array.isArray(p.copy)) throw new Error('A project needs a title and brand copy.');
  if (Object.keys(p.copy).length > 60) throw new Error('Use at most 60 shared copy fields.');
  for (const [id,value] of Object.entries(p.copy)) { named(id,'copy'); text(value,id); }
  p.assets ??= []; p.fonts ??= []; p.approvals ??= []; p.notes ??= '';
  if (!Array.isArray(p.assets) || p.assets.length > 30 || !Array.isArray(p.fonts) || p.fonts.length > 8) throw new Error('Use at most 30 assets and 8 fonts.');
  const ids = new Set();
  for (const a of p.assets) {
    named(a.id,'asset'); text(a.name,'asset name',160);
    if (ids.has(a.id)) throw new Error('Asset ids must be unique.'); ids.add(a.id);
    if (typeof a.data !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(a.data) || a.data.length > 14000000) throw new Error('Embed each image as PNG, JPEG, WebP or SVG under 10 MB.');
  }
  const families = new Set();
  for (const f of p.fonts) {
    if (typeof f.family !== 'string' || !/^[a-zA-Z0-9 -]{1,80}$/.test(f.family) || families.has(f.family)) throw new Error('Give each embedded font a unique family.'); families.add(f.family);
    if (typeof f.data !== 'string' || !/^data:font\/(ttf|otf|woff2?);base64,[A-Za-z0-9+/=]+$/.test(f.data)) throw new Error('Embed font files in the project.');
    text(f.license,'font license',16000); if (!f.license.trim()) throw new Error('Retain the font redistribution license.');
  }
  if (!Array.isArray(p.directions) || !p.directions.length || p.directions.length > 6) throw new Error('A brief needs 1–6 authored directions.');
  const directions = new Set();
  for (const d of p.directions) {
    named(d.id,'direction'); if (directions.has(d.id)) throw new Error('Direction ids must be unique.'); directions.add(d.id);
    text(d.name,'direction name',120); text(d.rationale,'rationale',4000);
    if (!d.colors || !d.fonts || !d.colors.ink || !d.colors.paper || !d.colors.accent) throw new Error('A direction needs ink, paper, accent and typography.');
    for (const [id,value] of Object.entries(d.colors)) { named(id,'color'); if (!hex.test(value)) throw new Error(`Invalid color ${id}.`); }
    for (const role of ['display','body']) if (!families.has(d.fonts[role])) throw new Error(`Embed the ${role} font: ${d.fonts[role]}.`);
    d.symbols ??= {};
    for (const [id,s] of Object.entries(d.symbols)) {
      named(id,'symbol'); if (!Array.isArray(s.viewBox) || s.viewBox.length !== 4 || !s.viewBox.every(Number.isFinite) || s.viewBox[2] <= 0 || s.viewBox[3] <= 0) throw new Error('Give symbols a valid viewBox.');
      if (!Array.isArray(s.paths) || !s.paths.length || s.paths.length > 100) throw new Error('A symbol needs vector paths.');
      for (const path of s.paths) { text(path.d,'symbol path',100000); if (!/^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\s-]+$/.test(path.d)) throw new Error('Invalid SVG path.'); color(d,path.fill ?? '$ink'); }
    }
    if (!Array.isArray(d.boards) || !d.boards.length || d.boards.length > 24) throw new Error('Provide 1–24 artboards per direction.');
    const boards = new Set();
    for (const b of d.boards) {
      named(b.id,'artboard'); if (boards.has(b.id)) throw new Error('Artboard ids must be unique.'); boards.add(b.id);
      text(b.name,'artboard name',120); if (![b.width,b.height].every(n=>Number.isInteger(n)&&num(n,64,6000))) throw new Error('Artboards must be 64–6000 pixels per side.');
      color(d,b.background ?? '$paper');
      if (b.printMm !== undefined && (!Array.isArray(b.printMm) || b.printMm.length !== 2 || !b.printMm.every(n=>num(n,10,1500)))) throw new Error('Print dimensions need width and height in millimeters.');
      if (!Array.isArray(b.layers) || b.layers.length > 200) throw new Error('Use at most 200 layers per artboard.');
      const layers = new Set();
      for (const l of b.layers) {
        named(l.id,'layer'); if (layers.has(l.id)) throw new Error('Layer ids must be unique within an artboard.'); layers.add(l.id);
        if (!['text','rect','ellipse','path','image','symbol','line'].includes(l.type)) throw new Error('Unsupported layer type.');
        for (const n of ['x','y']) if (!num(l[n],-12000,12000)) throw new Error(`Invalid ${n} position.`);
        for (const n of ['width','height']) if (!num(l[n],0,12000)) throw new Error(`Invalid ${n}.`);
        if (l.opacity !== undefined && !num(l.opacity,0,1)) throw new Error('Opacity must be 0–1.');
        if (l.rotation !== undefined && !num(l.rotation,-360,360)) throw new Error('Rotation must be -360–360.');
        if (l.strokeWidth !== undefined && !num(l.strokeWidth,0,1000)) throw new Error('Invalid stroke width.');
        for (const prop of ['fill','stroke']) if (l[prop] !== undefined) color(d,l[prop]);
        if (l.type === 'text') {
          text(l.text,'layer text');
          for (const match of l.text.matchAll(/\{\{([a-z][a-z0-9_-]*)\}\}/g)) if (!(match[1] in p.copy)) throw new Error(`Missing shared copy: ${match[1]}.`);
          if (!num(l.size,6,1200) || !num(l.minSize ?? l.size,6,l.size) || !num(l.leading ?? 1.12,0.8,2)) throw new Error('Invalid text size or leading.');
          if (!['display','body'].includes(l.font ?? 'body')) throw new Error('Choose a display or body font role.');
          if (!['left','center','right'].includes(l.align ?? 'left')) throw new Error('Invalid text alignment.');
          if (!num(l.weight ?? 400,100,900) || !num(l.tracking ?? 0,-20,100)) throw new Error('Invalid text weight or tracking.');
        }
        if (l.type === 'symbol' && !d.symbols[l.symbol]) throw new Error(`Missing symbol ${l.symbol}.`);
        if (l.type === 'image' && !ids.has(l.asset)) throw new Error(`Missing image ${l.asset}.`);
        if (l.type === 'path') { text(l.d,'path',100000); if (!/^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\s-]+$/.test(l.d)) throw new Error('Invalid path.'); }
      }
    }
    d.logos ??= [];
    if(!Array.isArray(d.logos)||d.logos.length>8)throw new Error('Use at most eight logo lockups.');
    const logoIds=new Set(Object.keys(d.symbols));
    for(const logo of d.logos){named(logo.id,'logo');if(logoIds.has(logo.id))throw new Error('Logo and symbol ids must be unique.');logoIds.add(logo.id);const b=d.boards.find(b=>b.id===logo.board);if(!b||!Array.isArray(logo.layers)||!logo.layers.length||logo.layers.some(id=>!b.layers.some(l=>l.id===id)))throw new Error('A logo lockup must name existing artboard layers.');}
  }
  p.active ??= p.directions[0].id; if (!directions.has(p.active)) throw new Error('Choose an existing direction.');
  if (!Array.isArray(p.approvals) || p.approvals.length > 200) throw new Error('Invalid approval history.');
  for(const saved of p.approvals){
    if(!saved||!Number.isFinite(Date.parse(saved.at)))throw new Error('Invalid approved version date.');
    validateProject({spec:SPEC,id:p.id,title:p.title,brief:p.brief,copy:saved.copy,assets:saved.assets,fonts:saved.fonts??p.fonts,directions:[saved.direction],active:saved.direction?.id,approvals:[]});
  }
  text(p.notes,'notes',12000);
  if (p.website) {
    text(p.website.title,'website title',160); text(p.website.cta,'website action',160);
    if (typeof p.website.href !== 'string' || !/^(https:\/\/|mailto:|tel:)/.test(p.website.href) || /[\s"<>]/.test(p.website.href)) throw new Error('Website action must be an HTTPS, email or phone link.');
    if (!Array.isArray(p.website.sections) || p.website.sections.length > 12) throw new Error('Use at most 12 website sections.');
    for (const s of p.website.sections) { text(s.title,'section title',500); text(s.text,'section text',4000); }
    if(p.website.html!==undefined){text(p.website.html,'website source',200000);if(/<\s*(script|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript:/i.test(p.website.html))throw new Error('Use static HTML and CSS for the portable launch site.');}
  }
  if (JSON.stringify(p).length > 36000000) throw new Error('Keep the project under 36 MB.');
  return p;
}
export function direction(p,id=p.active) { const d=p.directions.find(d=>d.id===id); if(!d)throw new Error('Direction not found.');return d; }
export function restoreApproved(p,saved) {
  const next=clone(p);next.copy={...next.copy,...clone(saved.copy)};
  for(const [field,key]of [['assets','id'],['fonts','family']])for(const item of saved[field]??[]){const i=next[field].findIndex(value=>value[key]===item[key]);if(i<0)next[field].push(clone(item));else next[field][i]=clone(item);}
  const i=next.directions.findIndex(d=>d.id===saved.direction.id);if(i<0)next.directions.push(clone(saved.direction));else next.directions[i]=clone(saved.direction);next.active=saved.direction.id;
  return validateProject(next);
}
export function color(d,value) { if(value==='none')return value; const c=typeof value==='string'&&value.startsWith('$')?d.colors[value.slice(1)]:value;if(!hex.test(c))throw new Error(`Unknown brand color: ${value}.`);return c; }
export function copyText(p,value) { return String(value??'').replace(/\{\{([a-z][a-z0-9_-]*)\}\}/g,(_,id)=>p.copy[id]??''); }
export function fontCSS(p) { return p.fonts.map(f=>`@font-face{font-family:'${f.family}';src:url('${f.data}');font-weight:100 900;font-style:normal;font-display:block}`).join('\n'); }
export function contrast(a,b) {
  const lum=c=>{const v=c.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2];};const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
export function textLayout(p,d,l,measure) {
  const content=copyText(p,l.text),family=d.fonts[l.font??'body'], weight=l.weight??400, tracking=l.tracking??0;
  const width=(s,size)=>measure?measure(s,size,family,weight,tracking):[...s].length*size*.56+Math.max(0,[...s].length-1)*tracking;
  const wrap=size=>{
    const lines=[];
    for(const para of content.split('\n')){
      let line='';
      for(const word of para.split(/\s+/)){
        const next=line?line+' '+word:word;
        if(line&&width(next,size)>l.width){lines.push(line);line=word;}else line=next;
        if(width(line,size)>l.width){let part='';for(const char of line){if(part&&width(part+char,size)>l.width){lines.push(part);part=char;}else part+=char;}line=part;}
      } lines.push(line);
    }return lines;
  };
  let size=l.size,lines=wrap(size);
  while(size>(l.minSize??l.size)&&(lines.length*size*(l.leading??1.12)>l.height||lines.some(s=>width(s,size)>l.width+.1))){size=Math.max(l.minSize??l.size,size-1);lines=wrap(size);}
  return {lines,size,family,weight,tracking,overflow:lines.length*size*(l.leading??1.12)>l.height+.1||lines.some(s=>width(s,size)>l.width+.1)};
}
export function renderBoard(p,boardId,{directionId=p.active,embedFonts=true,interactive=false,measure}={}) {
  const d=direction(p,directionId),b=d.boards.find(b=>b.id===boardId);if(!b)throw new Error('Artboard not found.');
  const warnings=[],out=[];
  const attrs=o=>Object.entries(o).filter(([,v])=>v!==undefined).map(([k,v])=>` ${k}="${xml(v)}"`).join('');
  for(const l of b.layers){
    if(l.hidden)continue;
    let body='', common={fill:color(d,l.fill??'$ink'),opacity:l.opacity??1};
    if(l.stroke)common.stroke=color(d,l.stroke);if(l.strokeWidth)common['stroke-width']=l.strokeWidth;
    if(l.type==='text'){
      const t=textLayout(p,d,l,measure);if(t.overflow)warnings.push({board:b.id,layer:l.id,kind:'text-overflow',message:`${b.name}: “${copyText(p,l.text).slice(0,45)}” does not fit.`});
      const anchor={left:'start',center:'middle',right:'end'}[l.align??'left'],x=l.align==='center'?l.width/2:l.align==='right'?l.width:0;
      body=`<text${attrs({...common,'font-family':t.family,'font-size':t.size,'font-weight':t.weight,'letter-spacing':t.tracking,'text-anchor':anchor})}>${t.lines.map((s,i)=>`<tspan x="${x}" y="${t.size*.86+i*t.size*(l.leading??1.12)}">${xml(s)}</tspan>`).join('')}</text>`;
    }else if(l.type==='rect')body=`<rect${attrs({...common,width:l.width,height:l.height,rx:l.radius??0})}/>`;
    else if(l.type==='ellipse')body=`<ellipse${attrs({...common,cx:l.width/2,cy:l.height/2,rx:l.width/2,ry:l.height/2})}/>`;
    else if(l.type==='line')body=`<line${attrs({...common,x1:0,y1:0,x2:l.width,y2:l.height,stroke:color(d,l.stroke??'$ink'),'stroke-width':l.strokeWidth??1})}/>`;
    else if(l.type==='path')body=`<path${attrs({...common,d:l.d})}/>`;
    else if(l.type==='symbol'){
      const s=d.symbols[l.symbol];body=`<svg width="${l.width}" height="${l.height}" viewBox="${s.viewBox.join(' ')}" overflow="visible">${s.paths.map(path=>`<path${attrs({d:path.d,fill:color(d,l.fill??path.fill??'$ink'),'fill-rule':path.fillRule??'nonzero'})}/>`).join('')}</svg>`;
    }else if(l.type==='image')body=`<image${attrs({href:p.assets.find(a=>a.id===l.asset).data,width:l.width,height:l.height,preserveAspectRatio:l.fit==='cover'?'xMidYMid slice':'xMidYMid meet'})}/>`;
    const transform=`translate(${l.x} ${l.y})${l.rotation?` rotate(${l.rotation} ${l.width/2} ${l.height/2})`:''}`;
    out.push(`<g${attrs({transform,'data-layer':interactive?l.id:undefined})}>${interactive?`<rect width="${l.width}" height="${l.height}" fill="transparent" pointer-events="all"/>`:''}${body}</g>`);
    if(!l.bleed&&(l.x<-.1||l.y<-.1||l.x+l.width>b.width+.1||l.y+l.height>b.height+.1))warnings.push({board:b.id,layer:l.id,kind:'outside-artboard',message:`${b.name}: ${l.id} extends outside the artboard.`});
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}" viewBox="0 0 ${b.width} ${b.height}" role="img" aria-label="${xml(b.name)}"><title>${xml(p.copy.name??p.title)} — ${xml(b.name)}</title>${embedFonts?`<style>${fontCSS(p)}</style>`:''}<rect width="100%" height="100%" fill="${color(d,b.background??'$paper')}"/>${out.join('')}</svg>`;
  return {svg,warnings,width:b.width,height:b.height};
}
export function designTokens(p) { const d=direction(p);return {name:p.copy.name??p.title,direction:d.name,colors:clone(d.colors),typography:clone(d.fonts),copy:clone(p.copy)}; }
export function identityFiles(p,{measure}={}) {
  const d=direction(p),files=[];
  for(const [id,s]of Object.entries(d.symbols))for(const tone of ['ink','paper','accent'])files.push([`logos/${id}-${tone}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${s.viewBox.join(' ')}"><title>${xml(p.copy.name??p.title)} — ${xml(id)}</title>${s.paths.map(path=>`<path d="${xml(path.d)}" fill="${d.colors[tone]}" fill-rule="${xml(path.fillRule??'nonzero')}"/>`).join('')}</svg>`]);
  for(const logo of d.logos??[]){
    const b=d.boards.find(b=>b.id===logo.board),layers=b.layers.filter(l=>logo.layers.includes(l.id));
    const bounds=layers.map(l=>{const angle=(l.rotation??0)*Math.PI/180,c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle)),w=l.width*c+l.height*s+(l.strokeWidth??0),h=l.width*s+l.height*c+(l.strokeWidth??0);return {x:l.x+l.width/2-w/2,y:l.y+l.height/2-h/2,w,h};});
    const x=Math.min(...bounds.map(l=>l.x))-24,y=Math.min(...bounds.map(l=>l.y))-24,w=Math.ceil(Math.max(...bounds.map(l=>l.x+l.w))-x+24),h=Math.ceil(Math.max(...bounds.map(l=>l.y+l.h))-y+24);
    for(const tone of layers.some(l=>l.type==='image')?['original']:['ink','paper']){
      const copy=clone(p),target=direction(copy).boards.find(a=>a.id===logo.board);target.background='none';target.layers=clone(layers);if(tone!=='original')for(const l of target.layers)l.fill='$'+tone;
      const svg=renderBoard(copy,b.id,{measure}).svg.replace(`width="${b.width}" height="${b.height}" viewBox="0 0 ${b.width} ${b.height}"`,`width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}"`);
      files.push([`logos/${logo.id}-${tone}.svg`,svg]);
    }
  }return files;
}
export function websiteHTML(p) {
  const d=direction(p),site=p.website;if(!site)throw new Error('This project has no authored website.');
  const c=d.colors, hero=d.boards.find(b=>b.role==='hero')??d.boards.find(b=>b.role==='social')??d.boards[0];
  const heroSVG=renderBoard(p,hero.id,{embedFonts:false}).svg;
  if(site.html)return site.html.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g,(_,key)=>{if(key==='fontCSS')return fontCSS(p);if(key==='hero')return heroSVG;if(key==='site.href')return xml(site.href);if(key==='site.cta')return xml(copyText(p,site.cta));if(key==='site.title')return xml(copyText(p,site.title));if(key.startsWith('copy.'))return xml(p.copy[key.slice(5)]??'');if(key.startsWith('color.'))return d.colors[key.slice(6)]??'';if(key.startsWith('font.'))return xml(d.fonts[key.slice(5)]??'');throw new Error('Unknown website binding: '+key);});
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(copyText(p,site.title))}</title><meta name="description" content="${xml(p.copy.description??p.brief)}"><style>${fontCSS(p)}*{box-sizing:border-box}body{margin:0;background:${c.paper};color:${c.ink};font:18px/1.55 '${d.fonts.body}',sans-serif}header,main,footer{max-width:1280px;margin:auto;padding:32px 6%}header{display:flex;justify-content:space-between;align-items:center;gap:20px}a{color:inherit}header>a:first-child{font:700 26px '${d.fonts.display}';text-decoration:none}.hero{display:grid;grid-template-columns:1fr 1fr;gap:7%;align-items:center;padding:64px 0 90px}h1{font:600 clamp(48px,6vw,88px)/1 '${d.fonts.display}';letter-spacing:-.04em;margin:0 0 32px}p{max-width:55ch}.art>svg{width:100%;height:auto;display:block}.cta{display:inline-block;background:${c.ink};color:${c.paper};padding:16px 26px;border-radius:3px;text-decoration:none;font-weight:600}.eyebrow{font-size:12px;letter-spacing:.15em;text-transform:uppercase}section.copy{border-top:1px solid ${c.ink};padding:42px 0;display:grid;grid-template-columns:1fr 1fr;gap:7%}h2{font:500 36px/1.15 '${d.fonts.display}';margin:0}footer{font-size:14px;border-top:1px solid ${c.ink}}@media(max-width:700px){.hero,section.copy{grid-template-columns:1fr}.hero{padding:24px 0 54px}.art{margin-top:26px}header{padding-top:22px}.cta{max-width:100%}section.copy{gap:20px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}</style><header><a href="#">${xml(p.copy.name??p.title)}</a><a href="${xml(site.href)}">${xml(copyText(p,site.cta))} ↗</a></header><main><section class="hero"><div><p class="eyebrow">${xml(p.copy.category??'')}</p><h1>${xml(p.copy.headline??p.copy.tagline??p.title)}</h1><p>${xml(p.copy.description??'')}</p><a class="cta" href="${xml(site.href)}">${xml(copyText(p,site.cta))}</a></div><div class="art">${heroSVG}</div></section>${site.sections.map(s=>`<section class="copy"><h2>${xml(copyText(p,s.title))}</h2><p>${xml(copyText(p,s.text)).replace(/\n/g,'<br>')}</p></section>`).join('')}</main><footer>${xml(p.copy.name??p.title)} · ${xml(p.copy.contact??'')}</footer></html>`;
}
export function guideHTML(p) {
  const d=direction(p),ink=contrast(d.colors.ink,d.colors.paper).toFixed(2);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(p.title)} — Brand guide</title><style>${fontCSS(p)}*{box-sizing:border-box}body{font:16px/1.55 '${d.fonts.body}';background:#fff;color:#202020;max-width:1000px;margin:auto;padding:64px}h1,h2{font-family:'${d.fonts.display}'}h1{font-size:64px;line-height:1.05;margin:22px 0}h2{font-size:30px;margin-top:36px;break-after:avoid}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;padding:8px 0;border-bottom:1px solid #ddd}th{width:145px;padding-right:20px}tr{break-inside:avoid}.kicker{font-size:12px;text-transform:uppercase;letter-spacing:.18em}.swatches{display:flex;flex-wrap:wrap;gap:14px}.swatch{width:140px;border:1px solid #ddd}.color{height:90px}.swatch p{padding:0 12px;font-size:12px}.sample{font-size:44px;margin:16px 0}.assets{display:grid;grid-template-columns:1fr 1fr;gap:20px}.asset>svg{width:100%;height:auto}.asset{break-inside:avoid}pre{white-space:pre-wrap;font:inherit}small{color:#666}@page{size:A4;margin:15mm}@media print{body{padding:0;font-size:11px}h1{font-size:46px}h2{font-size:24px}.assets{display:block}.asset{width:75%;margin:20px auto}.color{-webkit-print-color-adjust:exact;print-color-adjust:exact}}@media(max-width:600px){body{padding:24px}h1{font-size:44px}.assets{grid-template-columns:1fr}}</style><p class="kicker">${xml(p.copy.name??p.title)} / Identity guidelines</p><h1>${xml(p.copy.tagline??p.title)}</h1><p>${xml(p.brief)}</p><h2>${xml(d.name)}</h2><p>${xml(d.rationale)}</p><h2>Color system</h2><div class="swatches">${Object.entries(d.colors).map(([name,c])=>`<div class="swatch"><div class="color" style="background:${c}"></div><p>${xml(name)}<br>${c}</p></div>`).join('')}</div><p>Ink on paper contrast: ${ink}:1. This measures this pair only; inspect text on every actual background.</p><h2>Typography</h2><div class="sample" style="font-family:'${d.fonts.display}'">${xml(p.copy.name??p.title)}</div><p>Display: ${xml(d.fonts.display)}. Body: ${xml(d.fonts.body)}. Font files and redistribution licenses are included in the delivery.</p><h2>Voice and decisions</h2><pre>${xml(p.notes||'Record the approved voice, decisions and use rules in the project.')}</pre><h2>Shared copy</h2><table>${Object.entries(p.copy).map(([k,v])=>`<tr><th>${xml(k)}</th><td>${xml(v).replace(/\n/g,'<br>')}</td></tr>`).join('')}</table><h2>Applications</h2><div class="assets">${d.boards.map(b=>`<div class="asset"><p>${xml(b.name)} · ${b.width} × ${b.height}</p>${renderBoard(p,b.id,{embedFonts:false}).svg}</div>`).join('')}</div><h2>Handoff</h2><p>Edit the supplied SVGs in a vector editor or reopen the Forme project. PNG files are raster artwork. PDFs use the requested page dimensions. RGB output does not certify a print shop's bleed, CMYK profile or production tolerances. The website is a static site with the stated contact link; it does not include checkout or a mailing-list backend.</p><small>Review logo distinctiveness and real-world fit before launch. No trademark clearance is implied.</small></html>`;
}
