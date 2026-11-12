// The agent's browser tools: a line server (one JSON-RPC message per line, no MCP handshake) that runs inside the
// browser's container as `node /opt/harness-browser/browser-tools.mjs`, started by the daemon's `podman exec -i`. It
// answers `tools/call`, one per command the agent runs, and `window`, which sizes Chrome's window to the person's
// panel. It drives the Chrome the person also sees, over CDP, with public playwright-core API only.
import { createInterface } from 'node:readline'
import { chromium } from 'playwright-core'
import { answer, connectWithRetry, navigable, roleSnapshot, setWindow, withTimeout } from './browser-tools-lib.mjs'
import { CHALLENGE_ELEMENTS, detectChallenge, frameKind, withChallenge } from './challenge.mjs'
import { humanInput, modeOf } from './human-input.mjs'

const CDP = process.env.HARNESS_BROWSER_CDP || 'http://127.0.0.1:9222'
// Inside both engines' tool limits (Codex 300 s; Claude Code moves a call to the background at 120 s).
const TOOL_MS = 20_000
const NAVIGATE_MS = 60_000
const WAIT_MAX_MS = 30_000
const CHALLENGE_MS = 3_000
const STALE = 'Element not found; take a new snapshot'
// The tools after which the page may be asking for a person.
const CHECKED = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot'])

let browser = null
let current = null
// Refs of the last snapshot, per page: a ref from another tab or an older snapshot is never resolved against this one.
const refsOf = new WeakMap()
const sleep = ms => new Promise(done => setTimeout(done, ms))
const human = humanInput(Math.random, sleep)

async function connect(timeout) {
  const connected = await chromium.connectOverCDP(CDP, { timeout })
  // Chrome restarted or the socket dropped: the next call connects again.
  connected.on('disconnected', () => { if (browser === connected) { browser = null; current = null } })
  browser = connected
  return connected
}

async function page() {
  const context = (browser ?? await connectWithRetry(connect, sleep)).contexts()[0]
  if (current && !current.isClosed()) return current
  current = context.pages().at(-1) ?? await withTimeout(context.newPage(), TOOL_MS, 'Opening a tab')
  return current
}

async function element(ref) {
  const p = await page()
  const target = refsOf.get(p)?.[ref]
  if (!target) throw new Error(STALE)
  const byRole = target.name === undefined
    ? p.getByRole(target.role)
    : p.getByRole(target.role, { name: target.name, exact: true })
  const found = byRole.nth(target.nth)
  if (await found.count() === 0) throw new Error(STALE)
  return found
}

/** A visible challenge on the current page: only frames from a challenge's host are measured, so ads cost nothing. */
async function challenge() {
  const p = await page()
  const frames = await Promise.all(p.frames().filter(f => f.parentFrame() && frameKind(f.url())).map(async (f) => {
    const owner = await f.frameElement()
    try {
      const box = await owner.isVisible() ? await owner.boundingBox() : null
      return { url: f.url(), visible: Boolean(box), width: box?.width ?? 0, height: box?.height ?? 0 }
    } finally {
      await owner.dispose()
    }
  }))
  const elements = []
  // isVisible() does not wait, and is true only for an element with a size.
  for (const selector of CHALLENGE_ELEMENTS.keys()) if (await p.locator(selector).first().isVisible()) elements.push(selector)
  return detectChallenge(frames, elements)
}

const text = value => ({ content: [{ type: 'text', text: value }] })
const where = async p => `${p.url()} · ${await p.title()}`

const run = {
  async browser_navigate({ url }) {
    const p = await page()
    await p.goto(navigable(url), { timeout: NAVIGATE_MS, waitUntil: 'domcontentloaded' })
    return text(await where(p))
  },
  async browser_back() {
    const p = await page()
    await p.goBack({ timeout: TOOL_MS, waitUntil: 'domcontentloaded' })
    return text(await where(p))
  },
  async browser_snapshot() {
    const p = await page()
    const { text: tree, refs } = roleSnapshot(await p.locator('body').ariaSnapshot({ timeout: TOOL_MS }))
    refsOf.set(p, refs)
    return text(`${await where(p)}\n${tree}`)
  },
  async browser_click({ ref }, mode) {
    await human.click(await page(), await element(ref), mode, TOOL_MS)
    return text('Clicked')
  },
  async browser_type({ ref, text: value, submit }, mode) {
    await human.type(await page(), await element(ref), value, submit, mode, TOOL_MS)
    return text(submit ? 'Typed and submitted' : 'Typed')
  },
  async browser_press({ key }) {
    await (await page()).keyboard.press(key)
    return text('Pressed')
  },
  async browser_select({ ref, values }) {
    const chosen = await (await element(ref)).selectOption(values, { timeout: TOOL_MS })
    return text(`Selected ${chosen.join(', ')}`)
  },
  async browser_scroll({ dy }) {
    await (await page()).mouse.wheel(0, dy)
    return text('Scrolled')
  },
  async browser_screenshot() {
    const shot = await (await page()).screenshot({ type: 'jpeg', quality: 70, timeout: TOOL_MS })
    return { content: [{ type: 'image', data: shot.toString('base64'), mimeType: 'image/jpeg' }] }
  },
  async browser_tabs({ action, index }) {
    const p = await page()
    const pages = p.context().pages()
    if (action === 'new') {
      current = await p.context().newPage()
      return text(`Opened tab ${pages.length}`)
    }
    if (action !== 'list') {
      const tab = index === undefined ? p : pages[index]
      if (!tab) throw new Error(`No tab ${index}`)
      if (action === 'close') {
        await tab.close()
        if (tab === current) current = null
        return text('Closed')
      }
      await tab.bringToFront()
      current = tab
      return text(await where(tab))
    }
    const lines = await Promise.all(pages.map(async (tab, n) => `${n}${tab === p ? ' (current)' : ''}: ${await where(tab)}`))
    return text(lines.join('\n'))
  },
  async browser_wait({ text: wanted, ms }) {
    const p = await page()
    if (wanted) await p.getByText(wanted).first().waitFor({ state: 'visible', timeout: WAIT_MAX_MS })
    else await p.waitForTimeout(Math.min(Math.max(Number(ms) || 0, 0), WAIT_MAX_MS))
    return text('Done')
  },
}

async function call({ name, arguments: args = {}, _harness }) {
  if (!run[name]) return { ...text(`Unknown tool ${name}`), isError: true }
  const limit = name === 'browser_navigate' ? NAVIGATE_MS : name === 'browser_wait' ? WAIT_MAX_MS : TOOL_MS
  try {
    // A little over the tool's own Playwright timeout, so Playwright's clearer message wins when both fire.
    return await withTimeout((async () => {
      const reply = await run[name](args, modeOf(_harness))
      if (!CHECKED.has(name)) return reply
      // The tool did its work: a check that fails or hangs leaves its reply as it is, and says so on stderr.
      const kind = await withTimeout(challenge(), CHALLENGE_MS, 'Challenge check').catch((error) => {
        process.stderr.write(`browser-tools: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`)
        return null
      })
      return withChallenge(reply, kind)
    })(), limit + 5_000, name)
  } catch (error) {
    return { ...text(error instanceof Error ? error.message.split('\n')[0] : String(error)), isError: true }
  }
}

/** Chrome's window takes the panel's size, through a CDP session of its own that ends with the call. */
async function window({ width, height }) {
  return withTimeout((async () => {
    const p = await page()
    const session = await p.context().newCDPSession(p)
    try {
      return await setWindow((method, params) => session.send(method, params), { width, height })
    } finally {
      await session.detach().catch(() => {})
    }
  })(), TOOL_MS, 'window')
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin })
  .on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }) }
    // A notification (no id) is never answered.
    if (message.id === undefined) return
    let result
    try {
      result = await answer(message, { call, window })
    } catch (error) {
      // Only `window` throws (a call answers its failure as isError): the daemon reads an error as the window not set.
      return send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message.split('\n')[0] : String(error) } })
    }
    send(result === null ? { id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } } : { id: message.id, result })
  })
  // The daemon closed stdin: exit without browser.close(), which on a CDP connection would close the person's Chrome.
  .on('close', () => process.exit(0))
