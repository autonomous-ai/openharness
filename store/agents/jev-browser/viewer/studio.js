// studio.js — the Jev Browser pane: the live browser, what Jev decided about every link on the
// page, and the rows as they land. Everything comes from the viewer over SSE; the pane asks for
// nothing the desktop web view cannot give it.
const $ = (id) => document.getElementById(id)
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const fmtN = (n) => Number(n || 0).toLocaleString('en-US')
const fmtCost = (v) => (v <= 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`)
const pct = (p) => `${Math.round(p * 100)}%`

let S = null, shownRows = 0, toastTimer = null
const tw = { rows: { v: 0, t: 0 }, pages: { v: 0, t: 0 }, links: { v: 0, t: 0 }, rate: { v: 0, t: 0 }, cost: { v: 0, t: 0 } }

async function post(cmd, body = {}) {
  try {
    const r = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, ...body }) })
    return await r.json()
  } catch { return { ok: false, error: 'the viewer is restarting' } }
}
function toast(msg, bad) {
  const t = $('toast')
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 7000 : 4000)
}

// ---- the job -------------------------------------------------------------------------------------
function renderJob() {
  const box = $('jobBody')
  box.textContent = ''
  if (!S.fields.length) { box.append(h('div', 'job-task', 'No job yet.'), h('div', 'job-line dim', 'Say what you want in the form on the left, or ask the agent on the right.')); return }
  box.append(h('div', 'job-task', S.task))
  const start = h('div', 'job-line')
  start.append(h('b', '', 'starts at '), h('span', 'mono', S.demoUrl && S.start === S.demoUrl ? 'a made-up job board on this machine' : S.start || 'nowhere yet'))
  box.append(start)
  const item = h('div', 'job-line')
  item.append(h('b', '', 'collects '), h('span', '', S.item))
  box.append(item)
  const fields = h('div', 'job-fields')
  for (const f of S.fields) {
    const chip = h('span', 'job-field')
    chip.append(h('b', '', f.name), h('i', '', f.type === 'yesno' ? 'yes / no' : f.type === 'score' ? 'scale' : 'off the page'))
    chip.title = f.ask
    fields.append(chip)
  }
  if (!S.fields.length && S.proposing) fields.append(h('span', 'job-line dim', 'Jev is reading the page to work them out…'))
  box.append(fields)
  if (S.keep) box.append(h('div', 'job-line keep', `keeps only: ${S.keep}`))
  box.append(h('div', 'job-line dim', `at most ${fmtN(S.maxItems)} things from ${fmtN(S.maxPages)} pages`))
}

// ---- the results table -----------------------------------------------------------------------------
function renderHead() {
  const tr = $('resultsHead')
  tr.textContent = ''
  tr.append(h('th', 'n', '#'))
  for (const f of S.fields) tr.append(h('th', '', f.name))
  if (S.keep) tr.append(h('th', '', 'matches'))
  tr.append(h('th', 'addr', 'page'))
}
function cellFor(row, f) {
  const td = h('td')
  const v = row.fields[f.id] ?? ''
  const c = row.confidence[f.id] ?? 0
  if (!v) { td.append(h('span', 'missing', 'not on the page')); return td }
  td.append(h('span', 'val', v))
  const bar = h('i', 'conf')
  bar.style.setProperty('--p', `${Math.round(c * 100)}%`)
  bar.title = `Jev's confidence: ${pct(c)}`
  if (c < 0.65) td.classList.add('unsure')
  td.append(bar)
  return td
}
function renderRows() {
  const body = $('resultsBody')
  if (shownRows > S.rows.length) { body.textContent = ''; shownRows = 0 }
  for (let i = shownRows; i < S.rows.length; i++) {
    const row = S.rows[i]
    const tr = h('tr', 'land')
    tr.append(h('td', 'n', String(row.n)))
    for (const f of S.fields) tr.append(cellFor(row, f))
    if (S.keep) { const td = h('td'); td.append(h('span', row.keep ? 'yes' : 'no', row.keep ? 'yes' : 'no')); tr.append(td) }
    const a = h('a', '', row.title || row.url)
    a.href = row.url; a.target = '_blank'; a.rel = 'noreferrer'; a.title = row.url
    const td = h('td', 'addr'); td.append(a); tr.append(td)
    body.append(tr)
    setTimeout(() => tr.classList.remove('land'), 40)
  }
  shownRows = S.rows.length
  $('resultsNote').textContent = S.rows.length ? `${fmtN(S.rows.length)} so far · saved to ${S.resultsFile} as they land` : 'nothing yet'
}

// ---- Jev on the links --------------------------------------------------------------------------------
function renderLinks() {
  const box = $('linkList')
  box.textContent = ''
  if (!S.links.length) { box.append(h('div', 'dim small', 'Nothing judged yet.')); return }
  const yes = S.links.filter((l) => l.p >= 0.5).length
  $('linkNote').textContent = `${fmtN(S.links.length)} shown · ${fmtN(yes)} are items`
  for (const l of S.links) {
    const row = h('div', 'link-row' + (l.p >= 0.5 ? ' on' : ''))
    const bar = h('i', 'link-bar')
    bar.style.width = `${Math.max(2, Math.round(l.p * 100))}%`
    row.append(bar, h('span', 'link-label', l.label), h('span', 'link-p', pct(l.p)))
    row.title = l.label
    box.append(row)
  }
}

// ---- the feed ----------------------------------------------------------------------------------------
function renderFeed() {
  const box = $('feed')
  box.textContent = ''
  for (const e of S.feed.slice(0, 18)) {
    const row = h('div', `feed-row ${e.kind}`)
    row.append(h('span', 'feed-dot'), h('span', 'feed-text', e.text))
    box.append(row)
  }
  if (!S.feed.length) box.append(h('div', 'dim small', S.fields.length ? 'Press Start.' : 'Fill in the form on the left and it goes.'))
}

// ---- the top bar and the state -------------------------------------------------------------------------
function renderTop() {
  const p = S.progress
  tw.rows.t = p.rows; tw.pages.t = p.pages; tw.links.t = p.links; tw.rate.t = p.perSec; tw.cost.t = p.costUsd
  $('phasePill').textContent = S.proposing ? 'reading the page' : S.phase === 'running' ? 'browsing' : S.phase
  $('phasePill').className = 'pill ' + (S.phase === 'running' ? 'ok' : S.phase === 'done' ? 'ok' : S.phase === 'stopped' ? 'warn' : '')
  $('startBtn').classList.toggle('hidden', S.phase === 'running')
  $('stopBtn').classList.toggle('hidden', S.phase !== 'running')
  $('rateStat').classList.toggle('hot', S.phase === 'running')
}
function applyState(s) {
  const first = !S
  const sameFields = S && S.fields.length === s.fields.length && S.fields.every((f, i) => f.id === s.fields[i].id && f.name === s.fields[i].name)
  S = s
  $('taskLine').textContent = !s.fields.length ? 'no job yet — say what you want below' : s.task
  const noJobYet = !s.fields.length && !s.rows.length
  const problem = (noJobYet ? '' : s.error) || (s.jevError ? `Jev: ${s.jevError}` : '')
  $('cfgError').classList.toggle('hidden', !problem)
  $('cfgError').textContent = problem
  if (!sameFields) { renderHead(); shownRows = 0; $('resultsBody').textContent = '' }
  renderJob(); renderRows(); renderLinks(); renderFeed(); renderTop()
  if (first) showAsk(!s.rows.length && s.phase === 'idle')
  else if (askOpen && s.phase === 'running') showAsk(false)
  // A go that came to nothing used to leave a blank screen with no form and no reason: the only
  // way back in was a button in the top bar nobody had reason to look at. Put the form back.
  else if (!askOpen && !closedByHand && s.lastProblem && !s.proposing && s.phase !== 'running' && !s.fields.length && !s.rows.length) showAsk(true)
  else if (askOpen && s.lastProblem && $('askMsg').textContent !== s.lastProblem && !$('askSubmit').disabled) {
    $('askMsg').className = 'ask-msg bad'; $('askMsg').textContent = s.lastProblem
  }
  $('chromeNote').textContent = s.walled ? s.walled + '. This harness does not work around a block. Try a site that allows reading, or open the page yourself in the window and see what it wants.'
    : !s.chrome.found
    ? 'Google Chrome was not found on this machine. Install it, or set CHROME_PATH to where it is.'
    : s.client === 'mock' ? 'No Jev key yet, so an offline stand-in will answer. It only matches words: good enough to watch, not good enough to act on. Paste a key in the panel on the right.' : ''
  $('chromeNote').className = 'screen-note' + (!s.chrome.found || s.walled ? ' bad' : s.client === 'mock' ? ' warn' : '')
  // The form already carries the reason. Printing it again underneath reads as two problems.
  if (askOpen && s.lastProblem && $('chromeNote').textContent && s.lastProblem.startsWith($('chromeNote').textContent.slice(0, 40))) $('chromeNote').textContent = ''
  if (document.activeElement !== $('urlInput')) $('urlInput').value = s.here.url || ''
  $('urlInput').placeholder = s.chrome.open ? 'where the browser is' : 'the browser is not open yet'
  if (first) $('screen').classList.toggle('hidden', true)
}

// ---- tweened numbers and the frame loop -------------------------------------------------------------------
function step() {
  for (const [id, t] of Object.entries(tw)) {
    if (Math.abs(t.t - t.v) < 0.001) { t.v = t.t } else t.v += (t.t - t.v) * 0.18
  }
  $('sRows').textContent = fmtN(Math.round(tw.rows.v))
  $('sPages').textContent = fmtN(Math.round(tw.pages.v))
  $('sLinks').textContent = fmtN(Math.round(tw.links.v))
  $('sRate').textContent = tw.rate.v >= 10 ? Math.round(tw.rate.v) : tw.rate.v.toFixed(1)
  $('sCost').textContent = fmtCost(tw.cost.v)
  requestAnimationFrame(step)
}

// ---- the front door -----------------------------------------------------------------------------------------
// The pane takes the job itself. Before this the only way in was the agent or the JSON file, and a
// person looking at the pane could not tell what to do.
let askOpen = false
let closedByHand = false   // the form comes back on its own, unless the person put it away
function showAsk(on) {
  askOpen = on
  $('screenIdle').classList.toggle('hidden', !on)
  $('screenWrap').classList.toggle('asking', on)
  document.querySelector('.results-head').classList.toggle('hidden', on && !(S?.rows.length))
  document.querySelector('.table-wrap').classList.toggle('hidden', on && !(S?.rows.length))
  if (on) {
    $('askStart').value = S?.demoUrl && S.start === S.demoUrl ? '' : (S?.start ?? '')
    $('askSearch').value = S?.search ?? ''
    $('askItem').value = S?.item && S.item !== 'one of the things to collect' ? S.item : ''
    $('askWant').value = S?.want ?? ''
    $('askColumns').value = (S?.fields ?? []).map((f) => f.ask).join('\n')
    $('askKeep').value = S?.keep ?? ''
    $('askMax').value = S?.fields.length ? S.maxItems : 25
    // Whatever went wrong last time belongs here, where the person is already looking.
    $('askMsg').className = S?.lastProblem ? 'ask-msg bad' : 'ask-msg'
    $('askMsg').textContent = S?.lastProblem ?? ''
    // The extra boxes stay folded away unless this job is actually using one of them.
    showMore(!!(S?.search || S?.keep || S?.fields.length))
    setTimeout(() => $('askStart').focus(), 30)
  }
}
async function sendJob(over = {}) {
  const body = {
    start: $('askStart').value.trim(), search: $('askSearch').value.trim(), item: $('askItem').value.trim(), want: $('askWant').value.trim(),
    columns: $('askColumns').value, keep: $('askKeep').value.trim(), maxItems: Number($('askMax').value) || 25,
    ...over,
  }
  $('askMsg').className = 'ask-msg'
  $('askMsg').textContent = body.columns.trim() ? 'Setting the job…' : 'Reading the page to work out the columns…'
  $('askSubmit').disabled = true
  const r = await post('setJob', body)
  $('askSubmit').disabled = false
  if (!r.ok) { $('askMsg').className = 'ask-msg bad'; $('askMsg').textContent = r.error || 'that did not work'; return }
  closedByHand = false
  showAsk(false)
  toast('Off it goes. The browser is opening.')
}
function showMore(on) {
  $('askExtra').classList.toggle('hidden', !on)
  $('askMore').setAttribute('aria-expanded', String(on))
  $('askMore').textContent = on ? 'Fewer ▴' : 'More ▾'
}
$('askMore').addEventListener('click', () => showMore($('askExtra').classList.contains('hidden')))
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); sendJob() })
$('askDemo').addEventListener('click', () => sendJob({
  start: 'demo', search: '', item: '', want: 'what each one is called and what it pays', columns: '', keep: '',
}))
$('editBtn').addEventListener('click', () => { closedByHand = askOpen; showAsk(!askOpen) })

// ---- controls ---------------------------------------------------------------------------------------------
$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true
  const r = await post('start')
  $('startBtn').disabled = false
  if (r.ok === false) toast(r.error || 'it could not start', true)
})
$('stopBtn').addEventListener('click', () => post('stop'))
$('resetBtn').addEventListener('click', () => post('reset'))
$('downloadBtn').addEventListener('click', async () => {
  await post('export')
  const a = document.createElement('a'); a.href = '/download/results.csv'; a.download = 'results.csv'
  document.body.append(a); a.click(); a.remove()
  toast('results.csv is also in this project folder.')
})
async function go() {
  const url = $('urlInput').value.trim()
  if (!url) return
  const r = await post('openHere', { url })
  if (r.ok === false) toast(r.error, true)
}
$('goBtn').addEventListener('click', go)
$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go() } })

// ---- the stream ----------------------------------------------------------------------------------------------
const es = new EventSource('/events')
es.addEventListener('state', (e) => applyState(JSON.parse(e.data)))
es.addEventListener('view', (e) => applyState(JSON.parse(e.data)))
es.addEventListener('shot', (e) => {
  const s = JSON.parse(e.data)
  const img = $('screen')
  img.src = `data:image/jpeg;base64,${s.jpegBase64}`
  img.classList.remove('hidden')
  if (!askOpen) $('screenIdle').classList.add('hidden')   // a live page must not shove the form away mid-typing
})
window.addEventListener('jev-connected', () => toast('Connected. The next page is read by the real model.'))
requestAnimationFrame(step)
