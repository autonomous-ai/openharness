// chrome.mjs — drive a real Chrome, with no dependencies (Node 22+ has WebSocket built in).
//
// The browser is the person's own: a visible window with a profile kept in the workspace, so a site
// they log into once stays logged in for the next run. The harness never types a password.
//
// What this file will NOT do, whatever it is asked:
//   * leave http/https, or reach a host the job did not name
//   * submit a form, or click something that reads like pay, buy, delete or send
//   * type into a password, card or one-time-code field
// Those refusals live here, next to the only code that can touch the page, so nothing above can
// route around them.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { platform } from 'node:os'

export const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
}

/** Where Chrome is on this machine, or null. `CHROME_PATH` wins. */
export function findChrome() {
  const envPath = process.env.CHROME_PATH
  if (envPath) return existsSync(envPath) ? envPath : null
  for (const p of CHROME_PATHS[platform()] ?? []) if (existsSync(p)) return p
  return null
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A click on one of these is a door that does not open twice. Jev is never given the chance. */
const DANGER = /\b(pay|buy|purchase|checkout|order now|place order|subscribe|donate|confirm and pay|delete|remove|deactivate|close account|unsubscribe|send|post|publish|submit|apply now|book now|reserve|sign out|log out)\b/i
const SECRET_FIELD = /pass|pwd|secret|otp|2fa|one.?time|cvv|cvc|card|iban|account.?number|ssn|social.?security|pin\b/i

export class Refused extends Error {}

/** Only http(s), and only a host the job named. */
export function checkUrl(raw, allowedHosts) {
  let u
  try { u = new URL(String(raw)) } catch { throw new Refused(`"${String(raw).slice(0, 80)}" is not a web address`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refused(`${u.protocol} is not a web address this harness opens`)
  if (allowedHosts?.length) {
    const host = u.hostname.toLowerCase()
    const ok = allowedHosts.some((h) => host === h || host.endsWith('.' + h))
    if (!ok) throw new Refused(`${u.hostname} is not one of the sites this job named (${allowedHosts.join(', ')})`)
  }
  return u.toString()
}

/**
 * Open a Chrome and talk to it.
 * @param {object} o
 * @param {string}  o.profileDir     kept between runs, so a login lasts
 * @param {boolean} [o.show]         a window the person can watch and take over (false for tests)
 * @param {string[]} [o.allowedHosts]
 * @param {number}  [o.width] [o.height]
 */
export async function openChrome({ profileDir, show = true, allowedHosts = [], width = 1280, height = 900, chromePath = findChrome(), fresh = false } = {}) {
  if (!chromePath) throw new Error('Google Chrome was not found. Install it, or set CHROME_PATH to where it is.')
  if (fresh) rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const port = await freePort()
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-popup-blocking',
    `--window-size=${width},${height}`, 'about:blank',
  ]
  if (!show) args.unshift('--headless=new')
  const proc = spawn(chromePath, args, { stdio: 'ignore', detached: false })
  // Chrome exiting is expected at the end of every run, so this must never be an unheard rejection:
  // an unhandled one takes the whole viewer down with it, and then nothing at all happens.
  let exited = null
  proc.once('exit', (code) => { exited = code ?? 0 })
  proc.once('error', () => { exited = -1 })
  const dead = new Promise((resolve) => proc.once('exit', resolve))
  dead.catch(() => {})

  // Wait for the debugging port. Chrome takes a moment on a cold profile.
  let version = null
  for (let i = 0; i < 100 && !version && exited === null; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await sleep(100) }
  }
  if (!version) {
    proc.kill()
    // Chrome will not open a second window on a profile another Chrome is holding: it hands the
    // request to that window and quits (code 21 on macOS). The fix is to close the other window,
    // and the person needs telling that, not "it did not start".
    if (exited !== null) {
      throw new Error(exited === 21 || exited === 0
        ? 'A browser window from an earlier run is still open on this harness\'s profile. Close that window and press Go again.'
        : `Chrome would not start (it exited with code ${exited}).`)
    }
    throw new Error('Chrome started but never opened its debugging port')
  }

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([
    new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('Chrome refused the debugging connection')) }),
    dead.then(() => { throw new Error('Chrome closed before it could be driven') }),
  ])

  let nextId = 1
  const pending = new Map()
  const events = new Map() // method -> Set(handler)
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) }
    else if (m.method) for (const h of events.get(m.method) ?? []) h(m.params)
  }
  ws.onclose = () => { for (const { j } of pending.values()) j(new Error('Chrome went away')); pending.clear() }
  const on = (method, handler) => { if (!events.has(method)) events.set(method, new Set()); events.get(method).add(handler); return () => events.get(method).delete(handler) }
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    if (ws.readyState !== 1) return reject(new Error('Chrome is not connected'))
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome did not answer ${method} in time`)) }, timeoutMs)
    pending.set(id, { r: (v) => { clearTimeout(timer); resolve(v) }, j: (e) => { clearTimeout(timer); reject(e) } })
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.setLifecycleEventsEnabled', { enabled: true })
  // A download would put a file on the person's disk without them asking. Refuse them all.
  await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})

  let lastStatus = null
  on('Network.responseReceived', (p) => { if (p.type === 'Document') lastStatus = p.response.status })

  async function evaluate(expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs)
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result.value
  }

  /** Wait until the page has stopped loading, or the time runs out. Never throws. */
  async function settle(ms = 12000) {
    const end = Date.now() + ms
    let lastHtmlSize = -1, still = 0
    while (Date.now() < end) {
      await sleep(250)
      let state
      try { state = await evaluate('[document.readyState, document.documentElement.innerHTML.length]', { timeoutMs: 5000 }) } catch { continue }
      if (state?.[0] !== 'complete') { still = 0; continue }
      if (state[1] === lastHtmlSize) { if (++still >= 2) return true } else still = 0
      lastHtmlSize = state[1]
    }
    return false
  }

  const api = {
    port,
    /** Which hosts this session may reach. The job sets it; nothing else changes it. */
    allowedHosts,
    async go(url) {
      const safe = checkUrl(url, api.allowedHosts)
      lastStatus = null
      await send('Page.navigate', { url: safe })
      await settle()
      return { url: await evaluate('location.href'), status: lastStatus }
    },
    evaluate,
    settle,
    async url() { return evaluate('location.href') },
    async title() { return evaluate('document.title') },
    /**
     * Open one link. A link is followed by going to its address, not by clicking: a click can fire a
     * script that buys something. The address is checked like any other.
     */
    async open(href) { return api.go(href) },
    /** Click an element the page reader found, by the css path it gave. Refused on a danger word. */
    async click(cssPath, label = '') {
      if (DANGER.test(label)) throw new Refused(`"${label.trim().slice(0, 60)}" looks like it does something for real. This harness only reads pages.`)
      const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); if (!e) return null
        const t = (e.tagName || '').toLowerCase(), ty = (e.getAttribute('type') || '').toLowerCase()
        if (t === 'form' || ty === 'submit' || ty === 'image' || (t === 'button' && (e.type === 'submit' || e.form))) return 'submit'
        if (e.closest('form') && (t === 'button' || t === 'input')) return 'submit'
        e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect()
        return r.width < 1 || r.height < 1 ? null : [r.x + r.width / 2, r.y + r.height / 2] })()`)
      if (box === 'submit') throw new Refused('that control submits a form, and this harness only reads pages')
      if (!box) throw new Refused('that element is not on the page any more')
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
      }
      await settle(8000)
      return { url: await evaluate('location.href') }
    },
    /**
     * Search a site: type words into its search box and press Enter. This is the ONLY form control
     * the harness may work: a search asks a question of the site, it does not buy, send or delete.
     * Anything that is not recognisably a search box is refused here as everywhere else.
     */
    async search(cssPath, words) {
      const look = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); if (!e) return null
        const t = (e.tagName || '').toLowerCase(), ty = (e.getAttribute('type') || '').toLowerCase()
        if (t !== 'input' && t !== 'textarea') return 'not a field'
        if (ty && !['search', 'text', ''].includes(ty)) return 'not a search box'
        return [ty, [e.getAttribute('name'), e.getAttribute('id'), e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('role')].join(' ')] })()`)
      if (!look) throw new Refused('that search box is not on the page any more')
      if (typeof look === 'string') throw new Refused(`${look}: this harness only ever types into a search box`)
      const [type, about] = look
      if (type !== 'search' && !/search|query|\bq\b|keyword|find|look ?up/i.test(about)) throw new Refused('that field does not look like a search box, so it is left alone')
      if (SECRET_FIELD.test(about)) throw new Refused('that field wants something private')
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); e.focus(); e.value = '' })()`)
      await send('Input.insertText', { text: String(words).slice(0, 200) })
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      for (const type2 of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: type2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type2 === 'keyDown' ? '\r' : undefined })
      await settle(12000)
      return { url: await evaluate('location.href') }
    },
    /** Type into a field. A field that could hold a secret is refused, whoever asks. */
    async type(cssPath, text) {
      const kind = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); if (!e) return null
        return [(e.getAttribute('type') || '').toLowerCase(), (e.getAttribute('name') || '') + ' ' + (e.getAttribute('id') || '') + ' ' + (e.getAttribute('autocomplete') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '')] })()`)
      if (!kind) throw new Refused('that field is not on the page any more')
      if (kind[0] === 'password' || SECRET_FIELD.test(kind[1]) || SECRET_FIELD.test(kind[0])) {
        throw new Refused('that field wants a password, a card or a code. This harness never types those. Type it yourself in the browser window.')
      }
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); e.focus(); e.value = ''; })()`)
      await send('Input.insertText', { text: String(text).slice(0, 400) })
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(cssPath)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      return true
    },
    async back() { await send('Page.navigate', { url: 'javascript:history.back()' }).catch(() => {}); await evaluate('history.back()').catch(() => {}); await settle(8000); return evaluate('location.href') },
    async shot({ quality = 55, maxWidth = 900 } = {}) {
      const res = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false }, 15000)
      return { jpegBase64: res.data, maxWidth }
    },
    on,
    async close() {
      try { ws.close() } catch { /* already gone */ }
      try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}) } catch { /* fine */ }
      try { proc.kill() } catch { /* already gone */ }
      await sleep(80)
      try { proc.kill('SIGKILL') } catch { /* gone */ }
    },
    get alive() { return ws.readyState === 1 && proc.exitCode === null },
  }
  return api
}
