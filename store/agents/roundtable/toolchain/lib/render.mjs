// The pane. One self-contained page, rewritten after every turn, served by the shared Web Viewer —
// which reloads it the moment the file changes, so the room fills in front of the user.
//
// The layout is the argument for this harness: columns are seats, rows are rounds. Read ACROSS a row
// to compare four minds on one beat; read DOWN a column to watch one mind hold or move. A chat log
// cannot do either, which is why this is not a chat log.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADAPTERS } from './engines.mjs'
import { trimToShape } from './prompts.mjs'
import { PROTOCOL, WORKSPACE, decision, motion, readClaims, readRoom, readTurn } from './room.mjs'

const ENGINE_HUE = { claude: 18, codex: 220, opencode: 268, grok: 0, pi: 150, hermes: 44 }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** Just enough markdown for a turn: headings, bold, code, bullets, paragraphs. No dependencies. */
function md(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  const out = []
  let list = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (bullet) { list ??= []; list.push(inline(bullet[1])); continue }
    if (list) { out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`); list = null }
    if (!line) continue
    if (heading) out.push(`<h4>${inline(heading[2])}</h4>`)
    else out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`)
  return out.join('\n')
}

const seconds = (ms) => (!ms ? '' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

function seatHead(seat) {
  const adapter = ADAPTERS[seat.engine] ?? { label: seat.engine, vendor: '' }
  const hue = ENGINE_HUE[seat.engine] ?? 210
  return `<div class="seat" style="--hue:${hue}">
    <div class="seat-top"><span class="chip">${esc(seat.engine.slice(0, 2).toUpperCase())}</span>
      <div><div class="seat-name">${esc(seat.id)}</div>
      <div class="seat-engine">${esc(adapter.label)}${adapter.vendor ? ` · ${esc(adapter.vendor)}` : ''}</div></div></div>
    ${seat.stance ? `<div class="stance">${esc(seat.stance)}</div>` : '<div class="stance none">no assigned stance</div>'}
  </div>`
}

function cell(roundId, seat) {
  const turn = readTurn(roundId, seat.id)
  if (!turn) return '<div class="cell empty"><span>—</span></div>'
  const state = turn.front.state ?? 'answered'
  if (state === 'thinking') {
    return `<div class="cell thinking"><div class="bar"></div><div class="bar"></div><div class="bar short"></div>
      <div class="cell-foot">thinking…</div></div>`
  }
  if (state === 'absent') {
    return `<div class="cell absent"><p class="why">No answer.</p><p class="why dim">${esc(turn.front.error ?? '')}</p></div>`
  }
  return `<div class="cell" tabindex="0" role="button" aria-expanded="false"><div class="turn">${md(trimToShape(turn.body, roundId))}</div>
    <div class="fade"></div>
    <div class="cell-foot"><span class="more">more</span>${esc(seconds(Number(turn.front.elapsed_ms)))}${turn.front.model && turn.front.model !== 'default' ? ` · ${esc(turn.front.model)}` : ''}</div></div>`
}

function claimsTable(room, claims) {
  if (!claims.length) return ''
  const mark = { agree: '<span class="m yes">✓</span>', disagree: '<span class="m no">✗</span>', silent: '<span class="m dim">—</span>' }
  const rows = claims.map((claim) => {
    const votes = room.seats.map((s) => claim.by?.[s.id] ?? 'silent')
    const settled = votes.every((v) => v === 'agree')
    const split = votes.includes('agree') && votes.includes('disagree')
    return `<tr class="${settled ? 'settled' : split ? 'split' : ''}">
      <td class="claim">${esc(claim.text)}</td>
      ${votes.map((v) => `<td>${mark[v] ?? mark.silent}</td>`).join('')}
      <td class="verdictcol">${settled ? 'settled' : split ? 'split' : 'open'}</td></tr>`
  }).join('')
  return `<section class="claims"><h2>Where they agree, and where they don't</h2>
    <table><thead><tr><th>Claim</th>${room.seats.map((s) => `<th class="seatcol">${esc(s.id)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows}</tbody></table></section>`
}

function phaseStrip(room) {
  const phases = [...room.rounds, { id: 'decision', name: 'Decision', state: room.status === 'decided' ? 'done' : 'pending' }]
  return `<div class="phases">${phases.map((p) => `<span class="phase ${p.state}">${esc(p.name)}</span>`).join('<i></i>')}</div>`
}

function readView(room) {
  const blocks = []
  for (const round of PROTOCOL) {
    const turns = room.seats.map((s) => ({ seat: s, turn: readTurn(round.id, s.id) })).filter((t) => t.turn?.body?.trim())
    if (!turns.length) continue
    blocks.push(`<h2 class="readround">${esc(round.name)}</h2>`)
    for (const { seat, turn } of turns) {
      blocks.push(`<article class="readturn" style="--hue:${ENGINE_HUE[seat.engine] ?? 210}">
        <header><span class="chip">${esc(seat.engine.slice(0, 2).toUpperCase())}</span><b>${esc(seat.id)}</b>
        <span class="dim">${esc(ADAPTERS[seat.engine]?.label ?? seat.engine)}</span></header>${md(trimToShape(turn.body, round.id))}</article>`)
    }
  }
  return blocks.join('\n')
}

export function renderHtml() {
  const room = readRoom()
  const { claims } = readClaims()
  const motionText = motion().replace(/^#.*\n/, '').trim()
  const call = decision()
  const answered = PROTOCOL.flatMap((r) => room.seats.map((s) => readTurn(r.id, s.id))).filter((t) => t?.front?.state === 'answered').length
  const cols = `160px repeat(${Math.max(room.seats.length, 1)}, minmax(220px, 1fr))`

  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(room.motion || 'Roundtable')}</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#fbfbfa,#161615);--fg:light-dark(#1b1b19,#eceae4);--dim:light-dark(#6b6a65,#9a9892);
--line:light-dark(#e2e0da,#2e2e2b);--card:light-dark(#fff,#1e1e1c);--accent:light-dark(#b8552a,#e08a5a);
--yes:light-dark(#2f7d4f,#63c48c);--no:light-dark(#b23b3b,#e8756f);font-family:ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-size:13.5px;line-height:1.5}
header.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 20px 10px}
.label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{font-size:19px;line-height:1.3;margin:4px 0 10px;font-weight:600;max-width:70ch}
.meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.phases{display:flex;align-items:center;gap:7px;font-size:11px}
.phases i{width:14px;height:1px;background:var(--line)}
.phase{color:var(--dim)}.phase.done{color:var(--fg)}.phase.done::before{content:"● "}
.phase.active{color:var(--accent);font-weight:600}.phase.active::before{content:"◐ "}.phase.pending::before{content:"○ "}
.count{margin-left:auto;font-size:11px;color:var(--dim)}
.views{display:flex;gap:2px;background:light-dark(#efeee9,#232321);border-radius:7px;padding:2px}
.views button{font:inherit;font-size:11.5px;border:0;background:transparent;color:var(--dim);padding:3px 11px;border-radius:5px;cursor:pointer}
.views button[aria-pressed=true]{background:var(--card);color:var(--fg);box-shadow:0 1px 2px #0002}
main{padding:16px 20px 60px}
.call{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:14px 18px;margin-bottom:18px}
.call h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 6px}
.claims{margin-bottom:22px}
.claims h2,.grid-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 8px;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
th.seatcol,td:not(.claim):not(.verdictcol){text-align:center;width:74px}
tr.settled td.claim{color:var(--dim)}tr.split{background:light-dark(#fff8f0,#26211c)}
.verdictcol{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;width:60px}
.m.yes{color:var(--yes)}.m.no{color:var(--no)}.m.dim{color:var(--dim)}
.grid{display:grid;grid-template-columns:${cols};gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.grid>*{background:var(--bg)}
.corner{background:var(--bg)}
.seat{padding:10px 12px;background:var(--card)}
.seat-top{display:flex;gap:8px;align-items:center}
.chip{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;font-size:9.5px;font-weight:700;letter-spacing:.02em;
background:oklch(.72 .13 var(--hue));color:#111;flex:none}
.seat-name{font-weight:600;font-size:12.5px}.seat-engine{font-size:10.5px;color:var(--dim)}
.stance{margin-top:7px;font-size:11px;color:var(--dim);line-height:1.35}.stance.none{font-style:italic;opacity:.7}
.rowhead{padding:12px;background:var(--card);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:600}
.cell{position:relative;padding:11px 13px 30px;max-height:340px;overflow:hidden;font-size:12.5px;cursor:pointer}
.cell.open{max-height:none;cursor:default}
.cell:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.cell .fade{position:absolute;left:0;right:0;bottom:26px;height:46px;pointer-events:none;
background:linear-gradient(transparent,var(--bg))}
.cell.open .fade{display:none}
.cell:not(.clipped) .fade,.cell:not(.clipped) .more{display:none}
.more{border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-right:7px;color:var(--accent)}
.cell.open .more::after{content:"less"}.cell.open .more{font-size:0}.cell.open .more::after{font-size:10px}
.cell.empty{display:grid;place-items:center;color:var(--line);min-height:70px}
.cell.absent .why{color:var(--dim);font-size:11.5px}.cell.absent .why.dim{opacity:.7;font-size:10.5px}
.turn h4{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:12px 0 3px}
.turn p,.readturn p{margin:0 0 7px}.turn strong,.readturn strong{font-weight:650}
.turn ul,.readturn ul{margin:0 0 8px;padding-left:16px}.turn li,.readturn li{margin:0 0 3px}
.turn p strong:first-child{color:var(--accent)}
.cell-foot{position:absolute;left:0;right:0;bottom:0;background:var(--bg);display:flex;align-items:center;
font-size:10px;color:var(--dim);border-top:1px solid var(--line);padding:5px 13px 6px}
.cell.thinking{display:flex;flex-direction:column;gap:7px;justify-content:center;min-height:90px}
.bar{height:7px;border-radius:4px;background:var(--line);animation:pulse 1.4s ease-in-out infinite}
.bar.short{width:55%}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.9}}
code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.92em;background:light-dark(#f0efe9,#262623);padding:1px 4px;border-radius:4px}
#read{display:none;max-width:74ch}#read.on{display:block}.grid.off,.claims.off{display:none}
.readround{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:26px 0 10px}
.readturn{border-left:2px solid oklch(.72 .13 var(--hue));padding:2px 0 2px 14px;margin-bottom:18px}
.readturn header{display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:12px}
.dim{color:var(--dim)}
.empty-room{color:var(--dim);padding:40px 0;text-align:center}
</style>
<header class="top">
  <div class="label">Roundtable${room.status === 'decided' ? ' · decided' : ''}</div>
  <h1>${esc(room.motion || 'No motion yet')}</h1>
  <div class="meta">${phaseStrip(room)}
    <div class="views"><button id="b-matrix" aria-pressed="true">Matrix</button><button id="b-read" aria-pressed="false">Read</button></div>
    <span class="count">${room.seats.length} seats · ${answered} turns${room.evidence?.length ? ` · evidence: ${esc(room.evidence.map((e) => e.split('/').pop()).join(', '))}` : ''}</span>
  </div>
</header>
<main>
  ${call ? `<section class="call"><h2>The call</h2>${md(call.replace(/^#\s+.*\n/, ''))}</section>` : ''}
  ${claimsTable(room, claims)}
  ${room.seats.length ? `<div class="grid-title">The room</div>
  <div class="grid">
    <div class="corner"></div>
    ${room.seats.map(seatHead).join('')}
    ${PROTOCOL.map((round) => `<div class="rowhead">${esc(round.name)}</div>${room.seats.map((s) => cell(round.id, s)).join('')}`).join('')}
  </div>` : '<div class="empty-room">No seats yet. The moderator is still setting the room.</div>'}
  ${motionText ? `<details style="margin-top:22px"><summary class="grid-title" style="cursor:pointer">The motion in full</summary><div style="max-width:74ch;margin-top:8px">${md(motionText)}</div></details>` : ''}
  <div id="read">${readView(room)}</div>
</main>
<script>
for(const cell of document.querySelectorAll('.cell[role=button]')){
  const turn=cell.querySelector('.turn');
  if(turn.scrollHeight>cell.clientHeight-30)cell.classList.add('clipped');
  cell.addEventListener('click',()=>{const open=cell.classList.toggle('open');cell.setAttribute('aria-expanded',open)});
}
const grid=document.querySelector('.grid'),claims=document.querySelector('.claims'),read=document.getElementById('read');
const set=(mode)=>{document.getElementById('b-matrix').setAttribute('aria-pressed',mode==='matrix');
 document.getElementById('b-read').setAttribute('aria-pressed',mode==='read');
 grid&&grid.classList.toggle('off',mode==='read');claims&&claims.classList.toggle('off',mode==='read');
 read.classList.toggle('on',mode==='read');try{localStorage.setItem('rt-view',mode)}catch{}};
document.getElementById('b-matrix').onclick=()=>set('matrix');document.getElementById('b-read').onclick=()=>set('read');
try{set(localStorage.getItem('rt-view')||'matrix')}catch{set('matrix')}
</script>
</html>`
}

export function writeIndex() {
  const html = renderHtml()
  writeFileSync(join(WORKSPACE, 'index.html'), html)
  return html.length
}
