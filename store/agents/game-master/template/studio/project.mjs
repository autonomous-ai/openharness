// Portable source schema. Gameplay is authored in rules.mjs, independently of the renderer.
export const clone=x=>JSON.parse(JSON.stringify(x));
export const text=(x,max=160)=>typeof x==='string'&&x.length>0&&x.length<=max;
const id=x=>typeof x==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(x);
const color=x=>typeof x==='string'&&/^#[a-f0-9]{6}$/i.test(x);
const number=(x,a,b)=>Number.isFinite(x)&&x>=a&&x<=b;
export function assert(ok,message){if(!ok)throw new Error(message);}
export function validateProject(raw){
  assert(raw&&JSON.stringify(raw).length<=3000000,'Keep the project below 3 MB.');const p=clone(raw);
  assert(p.spec===1&&id(p.id)&&text(p.title)&&text(p.subtitle,400),'Use a version 1 Relay project with an id, title and subtitle.');
  assert(Number.isInteger(p.players)&&p.players>=1&&p.players<=6,'Choose 1–6 players.');
  assert(text(p.rules,200000),'Include the complete rules module.');
  assert(Array.isArray(p.rulebook)&&p.rulebook.length>=1&&p.rulebook.length<=40,'Include 1–40 rulebook sections.');
  for(const s of p.rulebook)assert(text(s.heading)&&text(s.body,10000),'Rulebook sections need a heading and body.');
  assert(Array.isArray(p.components)&&p.components.length>0&&p.components.length<=160,'Create 1–160 component designs.');
  const ids=new Set();let quantity=0;
  for(const c of p.components){
    assert(id(c.id)&&!ids.has(c.id),'Component ids must be unique.');ids.add(c.id);
    assert(text(c.name,80)&&typeof c.body==='string'&&c.body.length<=700,'Use short, readable component names and text.');
    assert(['card','token','tile'].includes(c.kind),'Component kind must be card, token or tile.');
    assert(number(c.widthMm,12,190)&&number(c.heightMm,12,273),'Component dimensions must fit A4 within 10 mm margins.');
    assert(Number.isInteger(c.quantity)&&c.quantity>=1&&c.quantity<=100,'Component quantity must be 1–100.');quantity+=c.quantity;
    assert(color(c.color)&&color(c.ink),'Use six-digit hex colors.');
    assert(typeof c.symbol==='string'&&c.symbol.length<=8,'Use a short symbol.');
    if(c.face!==undefined)assert(typeof c.face==='string'&&c.face.length<=700000&&/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(c.face),'Use an embedded PNG, JPEG, WebP or SVG face below 700 KB.');
    assert(c.values&&typeof c.values==='object'&&!Array.isArray(c.values),'Component values must be an object.');
    for(const [k,v] of Object.entries(c.values))assert(id(k)&&((typeof v==='number'&&Number.isFinite(v))||typeof v==='boolean'||(typeof v==='string'&&v.length<160)),'Values must be finite numbers, short text or booleans.');
    assert(Object.keys(c.values).length<=20,'Keep at most 20 values per component.');
  }
  assert(quantity<=600,'Keep the kit within 600 physical components.');
  assert(Array.isArray(p.settings)&&p.settings.length<=30,'Keep at most 30 rule settings.');
  const settings=new Set();for(const s of p.settings){assert(id(s.id)&&!settings.has(s.id)&&text(s.label),'Settings need unique ids and labels.');settings.add(s.id);assert(number(s.min,-10000,10000)&&number(s.max,s.min,10000)&&number(s.value,s.min,s.max)&&number(s.step,.001,1000),'Setting values must lie inside their declared bounds.');}
  assert(Array.isArray(p.boards)&&p.boards.length<=8,'Keep at most eight board sheets.');
  const boards=new Set();for(const b of p.boards){assert(id(b.id)&&!boards.has(b.id)&&text(b.name),'Boards need unique ids and names.');boards.add(b.id);assert(number(b.widthMm,30,277)&&number(b.heightMm,30,190),'Boards must fit landscape A4 within 10 mm margins.');assert(Number.isInteger(b.cols)&&b.cols>0&&b.cols<=20&&Number.isInteger(b.rows)&&b.rows>0&&b.rows<=20,'Boards support 1–20 rows and columns.');assert(Array.isArray(b.cells)&&b.cells.length===b.cols*b.rows,'Define every board cell.');for(const c of b.cells)assert(typeof c.label==='string'&&c.label.length<=30&&color(c.color),'Board cells need a short label and hex color.');}
  delete p.revision;return p;
}
export function projectData(p){const q=clone(p);delete q.rules;delete q.revision;return q;}
export function canonical(x){if(x===null||typeof x!=='object')return JSON.stringify(x);return Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';}
export async function digest(x){const bytes=new TextEncoder().encode(typeof x==='string'?x:canonical(x));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function history(initial,limit=80){let states=[clone(initial)],at=0;return{get value(){return clone(states[at]);},get canUndo(){return at>0;},get canRedo(){return at<states.length-1;},push(x){states=states.slice(0,at+1);states.push(clone(x));if(states.length>limit)states.shift();at=states.length-1;return this.value;},undo(){at=Math.max(0,at-1);return this.value;},redo(){at=Math.min(states.length-1,at+1);return this.value;}};}
