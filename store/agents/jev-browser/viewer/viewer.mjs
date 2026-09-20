// viewer.mjs — the Jev Browser viewer server.
//
// It owns a real Chrome, reads `browse.json`, and walks real web pages: one Jev call per page,
// which judges every link on it and pulls every field at once. Rows land in `results.csv`.
// `browse.json` is also the recipe: run it again tomorrow and you get today's answer again.
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { evaluate, PRICE_PER_MTOK, resolveCredentials, describeCredentials } from '../toolchain/jev.mjs'
import { serveViewer, writeVerdict, watchConfig, clean } from './kit.mjs'
import { openChrome, findChrome, Refused } from '../toolchain/chrome.mjs'
import { normalizeJob, runJob, proposeJob, findThePage, LIMITS } from './crawl.mjs'
import { browserMock } from './mock.mjs'
import { startDemoSite } from './demosite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'browse.json'
const RESULTS = 'results.csv'
const FEED = 40

export async function startBrowserViewer({ workspace, port = 0, show = null } = {}) {
  let server = null, watcher = null, chrome = null, demo = null, running = null, stopFlag = false
  let job = normalizeJob({}).job, configError = null, jevError = null
  let rows = [], feed = [], links = [], here = { url: '', title: '' }
  let counters = { pages: 0, calls: 0, questions: 0, tokens: 0, costUsd: 0, links: 0, errors: 0 }
  let phase = 'idle', startedAt = 0, finishedAt = 0, lastRun = null, proposing = false
  let shotTimer = null, shotBusy = false
  let expecting = { expecting: 'list', item: '' }
  const mock = browserMock(() => expecting)
  const liveRoute = () => resolveCredentials()?.provider ?? null
  const chromePath = findChrome()

  // ---- what the pane sees ---------------------------------------------------------------------
  const view = () => ({
    task: job.task, item: job.item, start: job.start, search: job.search, fields: job.fields.map((f) => ({ id: f.id, name: f.name, ask: f.ask, type: f.type })),
    walled: lastRun?.walled ?? null, want: job.want, proposing,
    keep: job.keep, maxItems: job.maxItems, maxPages: job.maxPages, limits: LIMITS,
    error: configError, jevError, client: liveRoute() ?? 'mock', jevSays: describeCredentials(),
    chrome: { found: !!chromePath, open: !!chrome?.alive },
    demoUrl: demo?.url ?? null, phase, here,
    progress: {
      ...counters,
      rows: rows.length,
      elapsedMs: startedAt ? (finishedAt || Date.now()) - startedAt : 0,
      perSec: counters.questions / Math.max(0.5, ((finishedAt || Date.now()) - startedAt) / 1000 || 1),
    },
    links, feed, rows, resultsFile: RESULTS,
  })
  const push = (event = 'state') => server?.broadcast(view(), event)
  const say = (text, kind = 'info') => { feed = [{ at: Date.now(), kind, text: clean(text).slice(0, 220) }, ...feed].slice(0, FEED) }

  // ---- results.csv ------------------------------------------------------------------------------
  // A value that starts with = + - @ would run as a formula in a spreadsheet: quote it.
  const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  function resultsCsv() {
    const head = ['item', 'page title', 'address', ...job.fields.flatMap((f) => [f.name, `${f.name} confidence`])]
    if (job.keep) head.push('matches what you asked', 'matches confidence')
    const lines = [head.map(cell).join(',')]
    for (const r of rows) {
      const line = [r.n, r.title, r.url, ...job.fields.flatMap((f) => [r.fields[f.id] ?? '', (r.confidence[f.id] ?? 0).toFixed(2)])]
      if (job.keep) line.push(r.keep ? 'yes' : 'no', (r.keepConfidence ?? 0).toFixed(2))
      lines.push(line.map(cell).join(','))
    }
    return lines.join('\n') + '\n'
  }
  function saveResults() {
    try { const f = join(workspace, RESULTS); writeFileSync(f + '.tmp', resultsCsv()); renameSync(f + '.tmp', f) } catch { /* workspace gone */ }
  }

  // ---- the verdict -------------------------------------------------------------------------------
  function verdict() {
    const filled = job.fields.map((f) => {
      const got = rows.filter((r) => String(r.fields[f.id] ?? '') !== '')
      const conf = got.length ? got.reduce((s, r) => s + (r.confidence[f.id] ?? 0), 0) / got.length : 0
      return { id: f.id, name: f.name, ask: f.ask, type: f.type, found: got.length, of: rows.length, avgConfidence: Math.round(conf * 1000) / 1000, thin: rows.length > 2 && got.length / rows.length < 0.6 }
    })
    const findings = []
    if (configError) findings.push({ severity: 'error', kind: 'job', ref: MARKER, message: configError })
    if (jevError) findings.push({ severity: 'warning', kind: 'jev', message: jevError })
    if (!chromePath) findings.push({ severity: 'error', kind: 'chrome', message: 'Google Chrome was not found on this machine. Install it, or set CHROME_PATH.' })
    if (lastRun?.walled) findings.push({ severity: 'error', kind: 'walled', message: `${lastRun.walled}. This is the site refusing an automated browser, not a fault here. Do not retry it: pick a site that allows reading.` })
    if (liveRoute() === null && rows.length) findings.push({ severity: 'warning', kind: 'jev', message: 'These rows came from the offline stand-in, not from Jev. They are not good enough to act on.' })
    for (const f of filled) if (f.thin) findings.push({ severity: 'warning', kind: 'field', ref: f.id, message: `"${f.name}" was found on only ${f.found} of ${f.of} pages. Reword what it asks for, or the value may not be on those pages.` })
    for (const e of (lastRun?.errors ?? []).slice(0, 3)) findings.push({ severity: 'warning', kind: 'page', ref: e.url, message: clean(e.message) })
    return {
      ready: phase === 'done' && rows.length > 0 && !configError,
      summary: clean(configError ? `${MARKER} needs a fix: ${configError}`
        : phase === 'idle' ? `Ready: ${job.task}. Press Start.`
        : `${rows.length} collected from ${counters.pages} pages, ${counters.links} links judged, ${counters.calls} calls, $${counters.costUsd.toFixed(4)}${phase === 'running' ? ' (still going)' : ''}`).slice(0, 200),
      findings, artifact: MARKER, resultsFile: RESULTS,
      phases: [
        { id: 'job', name: 'Job', state: configError ? 'failed' : 'done' },
        { id: 'browse', name: 'Browsing', state: phase === 'running' ? 'active' : rows.length ? 'done' : 'pending' },
        { id: 'review', name: 'Review', state: phase === 'done' ? (filled.some((f) => f.thin) ? 'active' : 'done') : 'pending' },
      ],
      run: {
        client: liveRoute() ?? 'mock', task: job.task, start: job.start, item: job.item,
        walled: lastRun?.walled ?? null,
        rows: rows.length, pages: counters.pages, linksJudged: counters.links, calls: counters.calls,
        questions: counters.questions, costUsd: Math.round(counters.costUsd * 1e6) / 1e6,
        elapsedMs: startedAt ? (finishedAt || Date.now()) - startedAt : 0, fields: filled,
        kept: job.keep ? rows.filter((r) => r.keep).length : null,
      },
    }
  }
  let verdictTimer = null
  const saveVerdict = () => { clearTimeout(verdictTimer); verdictTimer = null; try { writeVerdict(workspace, verdict()) } catch { /* gone */ } }
  const verdictSoon = () => { if (!verdictTimer) verdictTimer = setTimeout(saveVerdict, 400) }

  // ---- asking Jev --------------------------------------------------------------------------------
  async function ask({ state, questions }) {
    try {
      const res = await evaluate({ state, questions, salt: 3, mock, model: process.env.JEV_MODEL || 'jev-latest' })
      const n = Object.keys(questions).length
      const real = Number(res.usage?.input_tokens)
      counters.calls++
      counters.questions += n
      counters.tokens += Number.isFinite(real) && real > 0 ? real : Math.ceil((JSON.stringify(state).length + JSON.stringify(questions).length) / 4)
      counters.costUsd = (counters.tokens * PRICE_PER_MTOK) / 1e6
      jevError = null
      return res
    } catch (e) {
      counters.errors++
      jevError = clean(e?.message ?? e)
      throw e
    }
  }

  // ---- the browser --------------------------------------------------------------------------------
  async function openBrowser() {
    if (chrome?.alive) return { open: true }
    if (!chromePath) return { ok: false, error: 'Google Chrome was not found on this machine. Install it, or set CHROME_PATH to where it is.' }
    const hosts = [...job.hosts]
    if (demo) hosts.push('127.0.0.1', 'localhost')
    chrome = await openChrome({
      profileDir: join(workspace, '.harness', 'chrome-profile'),
      show: show ?? (process.env.JEV_BROWSER_HEADLESS === '1' ? false : job.show),
      allowedHosts: job.sameSiteOnly ? hosts : [],
    })
    say('The browser is open. Sign in to a site here if the pages you want need it.', 'browser')
    startShots()
    return { open: true }
  }
  async function closeBrowser() {
    stopShots()
    const c = chrome
    chrome = null
    await c?.close()
    return { open: false }
  }
  function startShots() {
    stopShots()
    shotTimer = setInterval(async () => {
      if (shotBusy || !chrome?.alive || !(server?.clients.size)) return
      shotBusy = true
      try { const s = await chrome.shot(); server?.broadcast({ ...s, url: here.url, at: Date.now() }, 'shot') } catch { /* between pages */ } finally { shotBusy = false }
    }, 900)
  }
  function stopShots() { clearInterval(shotTimer); shotTimer = null }

  // ---- the run --------------------------------------------------------------------------------------
  async function start() {
    if (running) return { ok: false, error: 'it is already running' }
    if (configError) return { ok: false, error: configError }
    // "demo" means the little made-up job board this harness serves itself.
    if (/^demo$/i.test(job.start)) {
      demo ??= await startDemoSite()
      job = { ...job, start: demo.url, hosts: [...new Set([...job.hosts, '127.0.0.1', 'localhost'])] }
    }
    const opened = await openBrowser()
    if (opened.ok === false) return opened
    rows = []; links = []; feed = []
    // Nobody should have to name the columns. Jev reads one page and proposes them, in about a
    // second, and the answer is written back into browse.json so the job stays the recipe.
    if (!job.fields.length) {
      proposing = true
      say('Looking for the right page…', 'start')
      counters = { pages: 0, calls: 0, questions: 0, tokens: 0, costUsd: 0, links: 0, errors: 0 }
      startedAt = Date.now(); finishedAt = 0; phase = 'running'
      push()
      const watch = (e) => {
        if (e.type === 'judged') links = e.links ?? []
        if (e.type === 'going') here = { url: e.url, title: '' }
        if (e.type === 'step') say(`Following "${e.label}" (${Math.round(e.p * 100)}%)`, 'go')
        if (e.type === 'searching') say(`Searching the site for "${e.words}"`, 'go')
        if (e.type === 'arrived') say(`This is the page: ${e.url}`, 'judge')
        push('view')
      }
      let got
      try {
        // The address may be a whole site rather than the list itself. Walk to it first.
        const found = await findThePage({ chrome, ask, start: job.start, want: job.want, search: job.search, onEvent: watch, stopped: () => stopFlag })
        if (found.walled) { got = { walled: found.walled, columns: [] } }
        else {
          if (found.gaveUp) say(`Still looking: ${found.gaveUp}. Reading this page anyway.`, 'bad')
          if (found.url !== job.start) { job = { ...job, start: found.url }; counters.pages = found.steps }
          got = await proposeJob({ chrome, ask, start: found.url, page: found.page, want: job.want, search: job.search, onEvent: watch })
        }
      } catch (e) { got = { columns: [], error: String(e.message ?? e) } }
      proposing = false
      if (got.walled) { lastRun = { walled: got.walled, errors: [] }; say(got.walled, 'bad'); phase = 'done'; finishedAt = Date.now(); push(); saveVerdict(); return { ok: false, error: got.walled } }
      if (!got.columns.length) {
        phase = 'idle'; finishedAt = Date.now()
        const why = got.error || got.none || 'nothing on that page looked like a value worth a column'
        say(`No columns could be worked out: ${why}`, 'bad')
        push(); saveVerdict()
        return { ok: false, error: `${why}. Write the columns yourself, one per line.` }
      }
      const saidItem = String(watcher.get()?.item ?? '').trim()
      // Write back the page it walked to, not the address that was typed: otherwise the job resets
      // to the site's front page and collects whatever happens to be on it.
      const next = { ...watcher.get(), start: job.start, item: saidItem || got.item, fields: got.columns.map((c) => ({ id: c.id, name: c.name, ask: c.ask })) }
      writeMarker(next)
      applyJobQuiet(next)
      say(`Jev found ${got.columns.length} columns in ${got.ms} ms: ${got.columns.map((c) => c.name).slice(0, 6).join(', ')}`, 'judge')
      push()
    }
    counters = { pages: 0, calls: 0, questions: 0, tokens: 0, costUsd: 0, links: 0, errors: 0 }
    stopFlag = false; phase = 'running'; startedAt = Date.now(); finishedAt = 0
    say(`Starting: ${job.task}`, 'start')
    push(); saveVerdict()

    running = (async () => {
      try {
        lastRun = await runJob({
          chrome, job, ask, stopped: () => stopFlag,
          onEvent: (e) => {
            if (e.type === 'going') { here = { url: e.url, title: '' }; expecting = { expecting: e.what?.startsWith('list page') || e.url === job.start ? 'list' : 'item', item: job.item }; say(`Opening ${e.what || e.url}`, 'go') }
            else if (e.type === 'read') { here = { url: e.url, title: e.title }; counters.pages++ }
            else if (e.type === 'judged') { links = e.links ?? []; counters.links += e.judged; say(`${e.judged} links judged in one call: ${e.found} are ${job.item}${e.next ? `, next page "${e.next}"` : ''}`, 'judge') }
            else if (e.type === 'row') { rows = [...rows, e.row]; say(`Collected #${e.row.n}: ${Object.values(e.row.fields).find(Boolean) ?? e.row.title}`, 'row'); saveResults() }
            else if (e.type === 'skipped') say(`Nothing of the job on ${e.url}`, 'skip')
            else if (e.type === 'trouble') { counters.errors++; say(`Trouble on ${e.url}: ${e.message}`, 'bad') }
            else if (e.type === 'done') say(`Finished: ${e.rows} collected from ${e.pages} pages`, 'done')
            push('view'); verdictSoon()
          },
        })
      } catch (e) {
        counters.errors++
        say(e instanceof Refused ? `Refused: ${e.message}` : `Stopped: ${String(e.message ?? e)}`, 'bad')
      } finally {
        phase = stopFlag ? 'stopped' : 'done'
        finishedAt = Date.now()
        running = null
        saveResults(); saveVerdict(); push()
      }
    })()
    return { started: true }
  }

  async function stop() { stopFlag = true; say('Stopping after this page…', 'stop'); await running; return { phase } }

  // ---- controls ---------------------------------------------------------------------------------
  async function control(cmd, body) {
    switch (cmd) {
      case 'start': return start()
      case 'stop': return stop()
      case 'run': { const r = await start(); await running; return { ...r, rows: rows.length, phase } }   // used by tests: runs to the end
      case 'openBrowser': return openBrowser()
      case 'closeBrowser': return closeBrowser()
      case 'reset': {
        await stop()
        rows = []; links = []; feed = []; phase = 'idle'; startedAt = 0; finishedAt = 0; lastRun = null
        counters = { pages: 0, calls: 0, questions: 0, tokens: 0, costUsd: 0, links: 0, errors: 0 }
        applyJob(watcher.get(), true); saveResults(); saveVerdict(); push()
        return { phase }
      }
      case 'export': { saveResults(); return { file: RESULTS, rows: rows.length } }
      // The pane's own form. It writes browse.json exactly as the agent would, so the file stays
      // the one place a job lives, and the recipe is the same however it was made.
      case 'propose': {
        // Just the proposal, without running: the pane can show it and let a person untick.
        if (!chrome?.alive) { const o = await openBrowser(); if (o.ok === false) return o }
        proposing = true; push()
        try { return await proposeJob({ chrome, ask, start: String(body.start ?? job.start), want: String(body.want ?? job.want ?? ''), search: String(body.search ?? '') }) }
        catch (e) { return { ok: false, error: String(e.message ?? e) } } finally { proposing = false; push() }
      }
      case 'setJob': {
        const columns = String(body.columns ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, LIMITS.fields)
        const start = String(body.start ?? '').trim()
        if (!start) return { ok: false, error: 'Put in the address of the page to start on.' }
        const next = {
          task: String(body.task ?? '').trim() || String(body.want ?? '').trim() || (columns[0] ? `${columns[0]} for every ${String(body.item ?? 'thing').trim()}` : `Read ${start.replace(/^https?:\/\//, '').split('/')[0]}`),
          start: /^[a-z]+:\/\//i.test(start) || /^demo$/i.test(start) ? start : `https://${start}`,
          search: String(body.search ?? '').trim(),
          item: String(body.item ?? '').trim(),
          fields: columns.map((ask) => (/^(is|are|does|do|can|has|have|will|should|was|were)\b/i.test(ask) || ask.endsWith('?')
            ? { ask, type: 'yesno', name: ask.replace(/\?$/, '').slice(0, 40) }
            : { ask, name: ask.slice(0, 40) })),
          want: String(body.want ?? '').trim(),
          keep: String(body.keep ?? '').trim(),
          maxItems: Math.max(1, Math.min(LIMITS.maxItems, Math.floor(Number(body.maxItems) || 25))),
          maxPages: Math.max(1, Math.min(LIMITS.maxPages, Math.floor(Number(body.maxPages) || 5))),
          sameSiteOnly: true, show: true,
        }
        const { errors } = normalizeJob(next)
        if (errors.length) return { ok: false, error: errors.join('; ') }
        writeMarker(next)
        applyJob(next)          // this starts it
        return { ok: true, start: next.start, fields: next.fields.length }
      }
      case 'openHere': {
        // The person asks the browser to go somewhere, from the pane. Same rules as everything else.
        if (!chrome?.alive) { const o = await openBrowser(); if (o.ok === false) return o }
        try { const r = await chrome.go(String(body.url ?? '')); here = { url: r.url, title: await chrome.title() }; push(); return { url: r.url } }
        catch (e) { return { ok: false, error: e instanceof Refused ? e.message : String(e.message ?? e) } }
      }
      default: return { ok: false, error: `unknown command "${cmd}"` }
    }
  }

  // ---- the job file --------------------------------------------------------------------------------
  // What makes a job a different job. A changed title or budget is not worth a new run.
  const jobPrint = (j) => JSON.stringify([j.start, j.search, j.item, j.keep, j.fields.map((f) => [f.id, f.ask, f.type, f.levels])])
  let lastPrint = null, autoTimer = null

  /** browse.json is the recipe, so anything the pane works out is written back into it. */
  function writeMarker(obj) {
    const f = join(workspace, MARKER)
    writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2) + '\n'); renameSync(f + '.tmp', f)
  }
  /** Take a job on without setting it running: used from inside a run that is already going. */
  function applyJobQuiet(raw) {
    const { job: next, errors } = normalizeJob(raw)
    configError = errors.length ? `${MARKER}: ${errors.join('; ')}` : null
    job = demo && /^demo$/i.test(next.start) ? { ...next, start: demo.url, hosts: [...new Set([...next.hosts, '127.0.0.1', 'localhost'])] } : next
    if (chrome) chrome.allowedHosts = job.sameSiteOnly ? [...job.hosts, ...(demo ? ['127.0.0.1', 'localhost'] : [])] : []
    lastPrint = jobPrint(job)
  }

  function applyJob(raw, fresh = false) {
    const { job: next, errors } = normalizeJob(raw)
    configError = errors.length ? `${MARKER}: ${errors.join('; ')}` : null
    if (!configError || fresh || !job.fields.length) job = next
    if (demo && /^demo$/i.test(job.start)) job = { ...job, start: demo.url, hosts: [...new Set([...job.hosts, '127.0.0.1', 'localhost'])] }
    if (chrome) chrome.allowedHosts = job.sameSiteOnly ? [...job.hosts, ...(demo ? ['127.0.0.1', 'localhost'] : [])] : []
    const print = jobPrint(job)
    const changed = lastPrint !== null && print !== lastPrint
    lastPrint = print
    push(); verdictSoon()
    // Somebody just asked for something different. Go and get it, rather than waiting to be told
    // twice: the person who typed it, or the agent that wrote the file for them, has already said so.
    if (changed && !configError && job.autoStart && !running) {
      clearTimeout(autoTimer)
      autoTimer = setTimeout(() => { if (!running && !configError) start().catch(() => {}) }, 400)
    }
  }

  mkdirSync(join(workspace, '.harness'), { recursive: true })
  watcher = watchConfig(join(workspace, MARKER), {}, (cfg, err) => {
    if (err) { configError = `${err}. Keeping the last good job`; push(); verdictSoon(); return }
    applyJob(cfg)
  })
  server = await serveViewer({
    here: HERE, port,
    files: ['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js'],
    state: view, control,
    downloads: () => { saveResults(); return { [RESULTS]: join(workspace, RESULTS) } },
    onConnect: () => { jevError = null; push() },
  })
  applyJob(watcher.get(), true)
  saveResults(); saveVerdict()

  return {
    url: server.url,
    async close() {
      stopFlag = true
      await running
      stopShots(); clearTimeout(verdictTimer); clearTimeout(autoTimer)
      watcher.close()
      await closeBrowser()
      await demo?.close()
      await server.close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startBrowserViewer({ workspace, port })
  console.log(`Jev Browser listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
