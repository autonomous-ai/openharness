// Re-bake the approved individual's moods from a checkout of the recorded art commit.
// node scripts/import_tux_moods.mjs /path/to/art-checkout 1363
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.resolve(process.argv[2]);
const art = path.join(root, 'prototype/habitat/assets/tux');
const provenance = JSON.parse(fs.readFileSync(path.join(art, 'ice.json')));
const gallery = fs.readFileSync(path.join(source, provenance.source_path), 'utf8');
if (createHash('sha256').update(gallery).digest('hex') !== provenance.source_sha256)
  throw new Error('Use the pinned gallery checkout recorded in ice.json');
const embedded = id => JSON.parse(gallery.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`))[1]);
const roster = embedded('roster-data');
const species = roster.daemons.find(d => d.id === 'tux');
const seed = Number(process.argv[3]);
const sample = embedded('traits-data').find(d => d.id === 'tux').samples.find(s => s.traits.seed === seed);
if (!sample) throw new Error('Choose an exact Tux gallery seed as the second argument');
const family = species.traits.colours.find(c => c[0] === sample.traits.colour);
const original = {...provenance, ...sample, gradient:family.slice(2), ink:roster.rules.plate.ink,
  material_colors:{m:sample.traits.accent, a:species.traits.extras.find(e => e[0] === sample.traits.extra)?.[2],
                   e:roster.rules.plate.oddEye.hex}};
const {plate, crop, cropBox} = await import(pathToFileURL(path.join(source, 'daemons/tools/plate.mjs')));
const {model} = await import(pathToFileURL(path.join(source, 'daemons/plates/tux.mjs')));
const mapping = {idle:'idle', working:'work', attention:'need', done:'done', offline:'fail', asleep:'nap', booped:'boop', listening:'need'};
const frames = [], mats = [], tags = [], landmarks = [];
// An eye/beak's centroid is measured from its model shape, including the original
// head tilt and body sway, so shared gaze and microphone reactions stay attached.
function center(part, m, cols) {
  let sx=0, sy=0, n=0;
  for(let y=0.5; y<m.h; y+=1) for(let x=0.5; x<m.w; x+=1) if(part.d(x,y)<0) { sx+=x; sy+=y; n++; }
  if(!n) throw new Error('Missing face landmark');
  return [Math.floor(sx/n/m.w*cols), Math.floor(sy/n/m.h*Math.round(cols*m.h/(2*m.w)))];
}
for(const [mood, sourceMood] of Object.entries(mapping)) {
  const count = mood==='idle' ? 8 : 4;
  for(let frame=0;frame<count;frame++) {
    const t=frame/count*Math.PI*2;
    const m=model({t,mood:sourceMood,age:'2.0',traits:original.traits});
    const materials=[];
    frames.push(plate(m,56,{mats:materials})); mats.push(materials); tags.push(mood);
    const blinking = sourceMood === 'idle' && Math.cos(t - 1.25 * Math.PI) > 0.97;
    const perEye = blinking || ['nap','done','back'].includes(sourceMood) ? 1 : 2;
    const left=m.parts.length-perEye*2, right=m.parts.length-perEye;
    landmarks.push({eyes:[center(m.parts[left],m,56),center(m.parts[right],m,56)],
                    beak:center(m.parts[left-(original.traits.extra === 'herring' ? 3 : 1)],m,56)});
  }
}
const box=cropBox(frames), rows=crop(frames,box), materials=crop(mats,box);
const moods={};
for(let i=0;i<rows.length;i++) {
  const move=([x,y])=>[x-box.left,y-box.top];
  (moods[tags[i]]??=[]).push({rows:rows[i].join('\n'),mats:materials[i].join('\n'),
    eyes:landmarks[i].eyes.map(move),beak:move(landmarks[i].beak)});
}
const hashes={};
for(const p of ['daemons/plates/tux.mjs','daemons/tools/plate.mjs'])
  hashes[p]=createHash('sha256').update(fs.readFileSync(path.join(source,p))).digest('hex');
const out={source_commit:original.source_commit, source_hashes:hashes, traits:original.traits,
  flags:original.flags,frame_ms:original.frame_ms,background:'#181818',gradient:original.gradient,
  ink:original.ink,material_colors:original.material_colors,source_moods:mapping,moods};
fs.writeFileSync(path.join(art,'sample.json'),JSON.stringify(original,null,2)+'\n');
fs.writeFileSync(path.join(art,'moods.json'),JSON.stringify(out,null,2)+'\n');
console.log(`${rows.length} Tux frames, ${rows[0][0].length}x${rows[0].length}, eight shared moods`);
