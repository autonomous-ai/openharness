// Builder Studio: draws /state.json, redraws on every server-sent change.
const $ = (id) => document.getElementById(id)
const snapshotMode = new URLSearchParams(location.search).has('snapshot')
if (snapshotMode) document.documentElement.classList.add('snapshot')

const TABS = [
  { id: 'live', name: 'Live viewer' },
  { id: 'proofs', name: 'Proofs' },
  { id: 'brief', name: 'Brief' },
  { id: 'checks', name: 'Checks' },
  { id: 'package', name: 'Package' },
  { id: 'decisions', name: 'Decisions' },
]
const STAGE_TAB = { research: 'brief', toolchain: 'checks', skills: 'package', viewer: 'live', evaluation: 'checks', proof: 'proofs', store: 'package' }
const LEVELS = ['easy', 'medium', 'hard']

let state = null
// A tab a person picked, or null to follow the work. Kept in the URL's hash, so a reload — the Studio
// restarts with its viewer — or a link to #brief comes back to the same tab.
let chosenTab = tabFromHash()
let liveUrl = null

function tabFromHash() {
  const id = location.hash.slice(1)
  return TABS.some((t) => t.id === id) ? id : null
}

function chooseTab(id) {
  chosenTab = id
  history.replaceState(null, '', id ? `#${id}` : `${location.pathname}${location.search}`)
  if (state) draw()
}

window.addEventListener('hashchange', () => chooseTab(tabFromHash()))

/** Replace an element's markup only when it changed: no flicker, no lost hover, no restarted image loads. */
function setHtml(el, html) {
  if (el.__html === html) return false
  el.innerHTML = html
  el.__html = html
  return true
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function ago(iso) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}
function clock(iso) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function mmss(seconds) {
  if (seconds == null) return ''
  const m = Math.floor(seconds / 60)
  return `${m}:${String(seconds % 60).padStart(2, '0')}`
}
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function runningProof() {
  return Object.values(state.proofs).find((p) => p.running)
}
function liveProof() {
  const running = runningProof()
  if (running) return running
  const withViewer = Object.values(state.proofs).filter((p) => p.viewerAlive && p.viewer?.url)
  return withViewer.sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))[0]
}

function currentTab() {
  if (chosenTab) return chosenTab
  if (runningProof()) return 'live'
  const active = state.build.stages.find((s) => s.state === 'active')
  if (active) return STAGE_TAB[active.id]
  if (!state.build.target) return 'brief'
  return 'proofs'
}

function drawHeader() {
  const b = state.build
  const name = b.target?.name
  $('mark').textContent = name ? name.trim()[0].toUpperCase() : '·'
  // The promise leads: what a person can now finish. The tool's name is the subtitle, because the
  // tool is the means — the work is the product (work/SUPERPOWERS.md).
  $('title').textContent = b.promise || (name ? `A harness for ${name}` : 'Name a tool to build a harness for')
  $('eyebrow').textContent = b.promise && name ? `Harness Builder · ${name}` : 'Harness Builder'
  $('status').textContent = state.verdict?.summary ?? ''
  const gates = (state.verdict?.evaluation ?? []).map((g) => {
    const cls = g.passed === true ? 'pass' : g.passed === false ? 'fail' : ''
    const label = g.by.replace(/, reviewed frame by frame/, '')
    return `<span class="gate ${cls}" title="${esc(g.method)}: ${esc(g.by)}"><span class="dot"></span>${esc(label)}</span>`
  })
  if (state.verdict?.ready) gates.unshift('<span class="gate ready">Ready for the Store</span>')
  setHtml($('gates'), gates.join(''))
}

function drawTrack() {
  setHtml($('track'), state.build.stages.map((s, i) => `
    <div class="step ${s.state}" title="${esc(s.name)}${s.note ? ` — ${esc(s.note)}` : ''}">
      <div class="bar"><i></i></div>
      <div class="label"><span class="num">${i + 1}</span><span class="name">${esc(s.name)}</span></div>
    </div>`).join(''))
}

function drawSide() {
  setHtml($('stages'), state.build.stages.map((s) => `
    <li class="${s.state}"><span class="icon"></span><div><div class="name">${esc(s.name)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</div></li>`).join(''))
  setHtml($('log'), state.build.log.slice(-14).reverse().map((l) => `<li><time>${clock(l.at)}</time>${esc(l.message)}</li>`).join(''))
}

function drawTabs(active) {
  const counts = {
    proofs: Object.keys(state.proofs).length || '',
    checks: state.check ? state.check.counts.errors + state.check.counts.warnings : '',
  }
  const running = runningProof()
  setHtml($('tabs'), TABS.map((t) => `
    <button class="tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === active}">${t.name}${t.id === 'live' && running ? '<span class="live"></span>' : ''}${counts[t.id] ? `<span class="count">${counts[t.id]}</span>` : ''}</button>`).join(''))
}

function empty(title, body, chips = []) {
  return `<div class="empty"><div><h2>${title}</h2><p>${body}</p>${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}</div></div>`
}

function drawLive(panel) {
  const proof = liveProof()
  if (!proof?.viewer?.url) {
    liveUrl = null
    panel.className = 'panel'
    setHtml(panel, empty('No viewer running yet', 'When the harness has a viewer, its pane appears here live: while you try it by hand, and while each proof runs.'))
    return
  }
  panel.className = 'panel flush'
  const url = proof.viewer.url
  const bar = `<div class="livebar"><span class="pill ${proof.running ? 'running' : proof.state}">${proof.running ? `running ${mmss(proof.seconds)}` : esc(proof.state)}</span><strong>${esc(proof.id)}</strong><span class="prompt">${esc(proof.prompt ?? 'a workspace to try the viewer by hand')}</span></div>`
  if (liveUrl === url && panel.querySelector('iframe')) {
    panel.firstElementChild.outerHTML = bar
    return
  }
  liveUrl = url
  setHtml(panel, `${bar}<iframe class="frame" src="${esc(url)}" title="The harness's viewer"></iframe>`)
}

function drawProofs(panel) {
  panel.className = 'panel'
  const ids = [...new Set([...LEVELS, ...Object.keys(state.proofs)])]
  const cards = ids.map((id) => {
    const p = state.proofs[id]
    if (!p) {
      if (!LEVELS.includes(id)) return ''
      return `<article class="proof"><div class="proof-head"><span class="level">${id}</span><span class="prompt" style="color:var(--faint)">Not run yet</span></div></article>`
    }
    const hero = p.finalImage ?? p.frames.at(-1)?.url
    const film = p.frames.length ? `<div class="film">${p.frames.map((f) => `<figure data-src="${esc(f.url)}" data-caption="${esc(`${id} · ${mmss(f.at)} · ${f.verdict?.summary ?? ''}`)}"><img loading="lazy" src="${esc(f.url)}" alt="frame at ${mmss(f.at)}" /><figcaption>${mmss(f.at)}${f.verdict?.summary ? ` · ${esc(f.verdict.summary)}` : ''}</figcaption></figure>`).join('')}</div>` : ''
    const verdict = p.result?.verdict ?? p.verdict
    const facts = []
    if (verdict) facts.push(`<div class="verdict">Verdict: <strong>${verdict.ready ? 'ready' : 'not ready'}</strong> · ${esc(verdict.summary ?? '')}</div>`)
    if (p.result?.firstFrameWithContentAt != null) facts.push(`<div>First change in the pane after ${mmss(p.result.firstFrameWithContentAt)}</div>`)
    if (p.note) facts.push(`<div>Review: ${esc(p.note)}</div>`)
    const activity = p.running && p.activity.length ? `<ul class="activity">${p.activity.slice(-6).map((a) => `<li><span class="t">${mmss(a.at)}</span>${a.kind === 'tool' ? `${esc(a.tool)} ${esc(a.detail)}` : esc((a.text ?? '').split('\n')[0])}</li>`).join('')}</ul>` : ''
    return `<article class="proof">
      <div class="proof-head"><span class="level">${esc(id)}</span><span class="prompt">${esc(p.prompt ?? 'Opened by hand')}</span><span class="pill ${p.running ? 'running' : esc(p.state)}">${p.running ? `running ${mmss(p.seconds)}` : esc(p.state)}</span></div>
      ${hero ? `<img class="proof-hero" src="${esc(hero)}" data-src="${esc(hero)}" data-caption="${esc(p.prompt ?? id)}" alt="What the viewer showed" />` : '<div class="placeholder">The first frame appears when the agent saves something.</div>'}
      ${film}
      ${facts.length || activity ? `<div class="proof-foot">${facts.join('')}${activity}</div>` : ''}
      ${p.review ? `<div class="proof-foot prose">${p.review}</div>` : ''}
    </article>`
  })
  setHtml(panel, `<div class="proofs">${cards.join('')}</div>`)
}

function drawBrief(panel) {
  panel.className = 'panel'
  if (!state.build.target && !state.brief) {
    setHtml(panel, empty('Name a tool', 'Tell the Builder which tool to wrap. It researches the tool, pins its toolchain, writes expert skills, crafts a live viewer, designs an honest evaluation, proves the result on three real prompts, and packages it for the Harness Store.', ['Vega-Lite', 'LilyPond', 'QGIS', 'KiCad', 'Godot']))
    return
  }
  setHtml(panel, state.brief ? `<div class="prose">${state.brief}</div>` : empty('Researching', 'The brief appears here as it is written: how the tool runs headless, what verifies its work, the stages a viewer should show, and the three proof prompts.'))
}

function drawChecks(panel) {
  panel.className = 'panel'
  const parts = []
  if (state.check) {
    const findings = state.check.findings
    parts.push(`<div class="section"><div class="section-title">Quality bar · ${state.check.counts.errors} errors · ${state.check.counts.warnings} warnings · ${ago(state.check.at)}</div>${findings.length ? `<ul class="findings">${findings.map((f) => `<li class="${esc(f.severity)}"><span class="sev">${esc(f.severity)}</span><div>${esc(f.message)}${f.ref ? `<div class="ref">${esc(f.ref)}</div>` : ''}</div></li>`).join('')}</ul>` : '<p>No findings: the package clears the bar.</p>'}</div>`)
  }
  if (state.fresh) {
    parts.push(`<div class="section"><div class="section-title">Fresh-machine install · ${state.fresh.passed ? 'passed' : `failed at ${esc(state.fresh.failedAt)}`} · ${state.fresh.seconds}s · ${esc(state.fresh.platform)}</div><div class="steps">${state.fresh.steps.map((s) => `<details ${s.exit !== 0 ? 'open' : ''}><summary>${s.exit === 0 && !s.timedOut ? '✓' : '✗'} ${esc(s.name)} · ${s.seconds}s</summary><pre>${esc(s.output)}</pre></details>`).join('')}</div></div>`)
  }
  setHtml(panel, parts.length ? parts.join('') : empty('Nothing checked yet', 'The quality bar ("$BUILDER" check) and the fresh-machine install ("$BUILDER" fresh) report here.'))
}

function treeHtml(nodes, newest) {
  return nodes.map((n) => n.dir
    ? `<li><span class="dir">${esc(n.name)}/</span><ul>${treeHtml(n.children, newest)}</ul></li>`
    : `<li><span class="file ${newest.has(n) ? 'fresh' : ''}">${esc(n.name)}</span><span class="size">${size(n.size)}</span></li>`).join('')
}

function drawPackage(panel) {
  panel.className = 'panel'
  const m = state.manifest
  if (!m) { setHtml(panel, empty('No package yet', 'The package appears here the moment it is scaffolded.')); return }
  const files = []
  const collect = (nodes) => nodes.forEach((n) => (n.dir ? collect(n.children) : files.push(n)))
  collect(state.tree)
  const newest = new Set(files.filter((f) => Date.now() - f.mtime < 120_000))
  const viewer = m.viewer ? (m.viewer.use ? `shared: ${m.viewer.use}` : 'its own') : 'none'
  setHtml(panel, `
    <dl class="manifest">
      <dt>Id</dt><dd>${esc(m.id)}</dd>
      <dt>Name</dt><dd>${esc(m.name)}</dd>
      <dt>Category</dt><dd>${esc(m.category || '—')}</dd>
      <dt>Author</dt><dd>${esc(m.author || '—')}</dd>
      <dt>Engine</dt><dd>${esc(m.engine)}</dd>
      <dt>Viewer</dt><dd>${esc(viewer)}</dd>
      <dt>Description</dt><dd>${esc(m.description || '—')}</dd>
    </dl>
    ${state.showcase.length ? `<div class="section"><div class="section-title">Store pictures</div><div class="showcase">${state.showcase.map((s) => `<img src="${esc(s)}" data-src="${esc(s)}" alt="" />`).join('')}</div></div>` : ''}
    <div class="section"><div class="section-title">package/ · ${files.length} files</div><ul class="tree">${treeHtml(state.tree, newest)}</ul></div>`)
}

function drawDecisions(panel) {
  panel.className = 'panel'
  setHtml(panel, state.decisions ? `<div class="prose">${state.decisions}</div>` : empty('No decisions yet', 'Every choice the Builder makes, and why, is written here as it goes.'))
}

function draw() {
  if (!state || state.error) return
  drawHeader()
  drawTrack()
  drawSide()
  const tab = currentTab()
  drawTabs(tab)
  const panel = $('panel')
  const scroll = panel.scrollTop
  if (tab !== 'live') liveUrl = null
  ;({ live: drawLive, proofs: drawProofs, brief: drawBrief, checks: drawChecks, package: drawPackage, decisions: drawDecisions })[tab](panel)
  if (tab !== 'live') panel.scrollTop = scroll
  panel.dataset.tab = tab
}

let loading = false
let again = false
async function load() {
  if (loading) { again = true; return }
  loading = true
  try {
    state = await (await fetch('/state.json', { cache: 'no-store' })).json()
    draw()
  } catch { /* the server restarts with its viewer; the next event reloads */ }
  loading = false
  if (again) { again = false; load() }
}

$('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]')
  if (!button) return
  chooseTab(button.dataset.tab === currentTab() && !chosenTab ? null : button.dataset.tab)
})
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-src]')
  if (target) {
    $('lightbox-img').src = target.dataset.src
    $('lightbox-caption').textContent = target.dataset.caption ?? ''
    $('lightbox').hidden = false
    return
  }
  if (event.target.closest('#lightbox')) $('lightbox').hidden = true
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('lightbox').hidden = true
  if (event.target.closest('input, textarea')) return
  const n = Number(event.key)
  if (n >= 1 && n <= TABS.length) chooseTab(TABS[n - 1].id)
})

load()
if (!snapshotMode) {
  const events = new EventSource('/events')
  events.addEventListener('change', load)
  events.addEventListener('tick', load)
}
