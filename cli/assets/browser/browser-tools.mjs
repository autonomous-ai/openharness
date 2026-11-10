// The agent's browser tools: a stdio MCP server (one JSON-RPC message per line) that runs inside the browser's
// container as `node /opt/harness-browser/browser-tools.mjs`, started by `podman exec` from `harness browser-mcp`.
// It drives the Chrome the person also sees, over CDP, with public playwright-core API only.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright-core'
import { connectWithRetry, roleSnapshot, withTimeout } from './browser-tools-lib.mjs'

const CDP = process.env.HARNESS_BROWSER_CDP || 'http://127.0.0.1:9222'
// Inside both engines' tool limits (Codex 300 s; Claude Code moves a call to the background at 120 s).
const TOOL_MS = 20_000
const NAVIGATE_MS = 60_000
const WAIT_MAX_MS = 30_000
const STALE = 'Element not found; take a new snapshot'
const TOOLS = JSON.parse(readFileSync(new URL('./browser-tools.json', import.meta.url), 'utf8')).tools

let browser = null
let current = null
// Refs of the last snapshot, per page: a ref from another tab or an older snapshot is never resolved against this one.
const refsOf = new WeakMap()

async function connect(timeout) {
  const connected = await chromium.connectOverCDP(CDP, { timeout })
  // Chrome restarted or the socket dropped: the next call connects again.
  connected.on('disconnected', () => { if (browser === connected) { browser = null; current = null } })
  browser = connected
  return connected
}

async function page() {
  const context = (browser ?? await connectWithRetry(connect, ms => new Promise(done => setTimeout(done, ms)))).contexts()[0]
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

const text = value => ({ content: [{ type: 'text', text: value }] })
const where = async p => `${p.url()} · ${await p.title()}`

const run = {
  async browser_navigate({ url }) {
    const p = await page()
    await p.goto(url, { timeout: NAVIGATE_MS, waitUntil: 'domcontentloaded' })
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
  async browser_click({ ref }) {
    await (await element(ref)).click({ timeout: TOOL_MS })
    return text('Clicked')
  },
  async browser_type({ ref, text: value, submit }) {
    const field = await element(ref)
    await field.fill(value, { timeout: TOOL_MS })
    if (submit) await field.press('Enter', { timeout: TOOL_MS })
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

async function call({ name, arguments: args = {} }) {
  if (!run[name]) return { ...text(`Unknown tool ${name}`), isError: true }
  const limit = name === 'browser_navigate' ? NAVIGATE_MS : name === 'browser_wait' ? WAIT_MAX_MS : TOOL_MS
  try {
    // A little over the tool's own Playwright timeout, so Playwright's clearer message wins when both fire.
    return await withTimeout(run[name](args), limit + 5_000, name)
  } catch (error) {
    return { ...text(error instanceof Error ? error.message.split('\n')[0] : String(error)), isError: true }
  }
}

async function answer(message) {
  if (message.method === 'initialize') {
    return { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'browser', version: '1' } }
  }
  if (message.method === 'tools/list') return { tools: TOOLS }
  if (message.method === 'tools/call') return await call(message.params ?? {})
  if (message.method === 'ping') return {}
  return null
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin })
  .on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }) }
    // A notification (no id) is never answered.
    if (message.id === undefined) return
    const result = await answer(message)
    send(result === null ? { id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } } : { id: message.id, result })
  })
  // The relay closed stdin: exit without browser.close(), which on a CDP connection would close the person's Chrome.
  .on('close', () => process.exit(0))
