#!/usr/bin/env node
// brand.mjs — logos and icons for the Jev harnesses. A harness opts in by having a hand-drawn
// store/agents/jev-*/brand/icon.svg. That file is the source of truth. This tool writes everything
// else from it (no dependencies; Node 22+).
//
//   node store/tools/jev-kit/brand.mjs [--cdp 9555]                         write logo.svg, logo-dark.svg, icon.png and assets.json,
//                                                                           and copy icon.png to desktop/assets/engine-icons/<folder>.png
//   node store/tools/jev-kit/brand.mjs --check                              no browser needed. Exit 1 and say what drifted
//   node store/tools/jev-kit/brand.mjs --sheet /abs/sheet.png [--cdp 9555]  every icon at 96, 48, 24 and 16 px, on light and on dark
//
// Rendering drives a headless Chrome over CDP. Start one first:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9555 --user-data-dir=<a scratch folder> --no-first-run --no-default-browser-check about:blank
// The lockup text and assets.json match store/tools/build-experience-branding.mjs, so every store identity reads as one family.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const agents = join(repo, 'store', 'agents')
const desktopIcons = join(repo, 'desktop', 'assets', 'engine-icons')

// The word before "· AUTONOMOUS" under each name: one word for what Jev does there. Add a line when a harness gets a brand/icon.svg.
export const WORDS = { 'jev-sheets': 'COLUMNS' }
// Two of the store's older identities, shown at the end of the sheet so new marks are judged beside them.
const BESIDE = ['drone-pilot', 'game-master']
const FRAME = '<rect x="4" y="4" width="88" height="88" rx="23" fill="'
const MAX_PNG = 100 * 1024

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const dataURL = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function lockup(icon, name, subtitle, dark) {
  const shapes = icon.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '').trim()
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="112" viewBox="0 0 480 112">
  <title>${xml(name)} logo</title>
  <rect width="480" height="112" rx="24" fill="${dark ? '#18252b' : '#f5f2e9'}"/>
  <g transform="translate(8 8)">${shapes}</g>
  <text x="120" y="53" fill="${dark ? '#f4f0e4' : '#243732'}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600" letter-spacing="-.8">${xml(name)}</text>
  <text x="121" y="76" fill="${dark ? '#a7bbb7' : '#63746b'}" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="600" letter-spacing="2.1">${xml(subtitle)} · AUTONOMOUS</text>
</svg>\n`
}

// Every Jev harness that ships a brand/icon.svg, with the two lockups this tool derives from it.
export function plan() {
  return readdirSync(agents).filter((n) => n.startsWith('jev-') && existsSync(join(agents, n, 'brand', 'icon.svg'))).sort().map((folder) => {
    const dir = join(agents, folder, 'brand')
    const icon = readFileSync(join(dir, 'icon.svg'), 'utf8')
    const name = JSON.parse(readFileSync(join(agents, folder, 'harness.json'), 'utf8')).name
    const word = WORDS[folder] ?? ''
    return { folder, dir, icon, name, word, logos: { 'logo.svg': lockup(icon, name, word, false), 'logo-dark.svg': lockup(icon, name, word, true) }, native: join(desktopIcons, `${folder}.png`) }
  })
}

const record = (h, png) => JSON.stringify({ source: 'icon.svg', license: 'MIT', sha256: { 'icon.svg': hash(h.icon), 'logo.svg': hash(h.logos['logo.svg']), 'logo-dark.svg': hash(h.logos['logo-dark.svg']), 'icon.png': hash(png) } }, null, 2) + '\n'

function sourceProblems(h) {
  const out = []
  if (!h.word) out.push(`brand.mjs has no subtitle word for ${h.folder} in WORDS`)
  if (!h.icon.includes('width="256" height="256" viewBox="0 0 96 96"')) out.push('icon.svg must be 256x256 with viewBox 0 0 96 96')
  if (!/<title>[^<]+<\/title>/.test(h.icon)) out.push('icon.svg needs a <title>')
  if (!h.icon.includes(FRAME)) out.push('icon.svg must start with the shared rounded square')
  return out
}

export function check() {
  const problems = []
  for (const h of plan()) {
    const say = (msg) => problems.push(`${h.folder}: ${msg}`)
    const source = sourceProblems(h)
    source.forEach(say)
    if (source.length) continue
    for (const [file, want] of Object.entries(h.logos)) {
      if (!existsSync(join(h.dir, file))) say(`brand/${file} is missing`)
      else if (readFileSync(join(h.dir, file), 'utf8') !== want) say(`brand/${file} drifted from icon.svg`)
    }
    if (!existsSync(join(h.dir, 'icon.png'))) { say('brand/icon.png is missing'); continue }
    const png = readFileSync(join(h.dir, 'icon.png'))
    if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG' || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) say('brand/icon.png must be a 256x256 PNG')
    if (png.length > MAX_PNG) say(`brand/icon.png is ${png.length} bytes (max ${MAX_PNG})`)
    if (!existsSync(join(h.dir, 'assets.json'))) say('brand/assets.json is missing')
    else if (readFileSync(join(h.dir, 'assets.json'), 'utf8') !== record(h, png)) say('brand/assets.json does not match the files (wrong hash or format)')
    if (!existsSync(h.native)) say(`desktop/assets/engine-icons/${h.folder}.png is missing`)
    else if (!readFileSync(h.native).equals(png)) say(`desktop/assets/engine-icons/${h.folder}.png differs from brand/icon.png`)
  }
  return problems
}

// One blank Chrome tab, sized to the picture, with a see-through background.
export async function openPage(port, width, height) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (!m.id || !pending.has(m.id)) return
    const { r, j } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? j(new Error(m.error.message)) : r(m.result)
  }
  const send = (method, params = {}) => new Promise((r, j) => { const id = nextId++; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result.value
  }
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  const { frameTree } = await send('Page.getFrameTree')
  return {
    evalJs,
    async show(html) {
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html })
      await evalJs('Promise.all([...document.images].map((img) => img.decode()))')
      await sleep(60)
    },
    async shot(w = width, h = height) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true })
      return Buffer.from(data, 'base64')
    },
    async close() { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}); ws.close() },
  }
}

export async function build(port) {
  const all = plan()
  for (const h of all) for (const p of sourceProblems(h)) throw new Error(`${h.folder}: ${p}`)
  const page = await openPage(port, 256, 256)
  try {
    for (const h of all) {
      for (const [file, svg] of Object.entries(h.logos)) writeFileSync(join(h.dir, file), svg)
      await page.show(`<style>html,body{margin:0;background:transparent}img{display:block;width:256px;height:256px}</style><img alt="" src="${dataURL(h.icon)}">`)
      const png = await page.shot()
      writeFileSync(join(h.dir, 'icon.png'), png)
      writeFileSync(h.native, png)
      writeFileSync(join(h.dir, 'assets.json'), record(h, png))
      console.log(`built ${h.folder} (icon.png is ${png.length} bytes)`)
    }
  } finally { await page.close() }
}

export async function sheet(port, out) {
  const beside = BESIDE.filter((n) => existsSync(join(agents, n, 'brand', 'icon.svg'))).map((n) => ({ folder: `${n} (for scale)`, icon: readFileSync(join(agents, n, 'brand', 'icon.svg'), 'utf8') }))
  const rows = [...plan(), ...beside]
  const strip = (h, dark) => `<div class="strip${dark ? ' dark' : ''}">${[96, 48, 24, 16].map((s) => `<img alt="" width="${s}" height="${s}" src="${dataURL(h.icon)}">`).join('')}</div>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:26px 30px;background:#e8e4d8;color:#243732;font:600 12px Arial,Helvetica,sans-serif}
  h1{font-size:18px;letter-spacing:-.4px;margin:0 0 16px}h1 span{font-weight:400;color:#63746b}
  .row{display:grid;grid-template-columns:96px 1fr 1fr;gap:8px;align-items:center;margin-top:8px}
  .strip{display:flex;align-items:center;justify-content:space-around;height:112px;border-radius:14px;padding:0 10px;background:#fffdf7}.dark{background:#15191d}img{display:block}
  </style></head><body><h1>Jev harness icons <span>at 96, 48, 24 and 16 px</span></h1>${rows.map((h) => `<div class="row"><span>${xml(h.folder.replace('jev-', ''))}</span>${strip(h, false)}${strip(h, true)}</div>`).join('')}</body></html>`
  const page = await openPage(port, 760, 900)
  try {
    await page.show(html)
    writeFileSync(out, await page.shot(760, await page.evalJs('Math.ceil(document.body.getBoundingClientRect().bottom)')))
    console.log(`sheet -> ${out} (${rows.length - beside.length} Jev icons, ${beside.length} for scale)`)
  } finally { await page.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
  const port = Number(opt('cdp', 9555))
  if (args.includes('--check')) {
    const problems = check()
    for (const p of problems) console.log(p)
    console.log(problems.length ? `${problems.length} problem(s). Fix the source, then run: node store/tools/jev-kit/brand.mjs` : `every Jev identity is current (${plan().map((h) => h.folder).join(', ')})`)
    process.exit(problems.length ? 1 : 0)
  }
  try {
    if (args.includes('--sheet')) {
      if (!opt('sheet') || opt('sheet').startsWith('--')) { console.error('need --sheet <out.png>'); process.exit(2) }
      await sheet(port, resolve(opt('sheet')))
    } else await build(port)
  } catch (e) {
    console.error(e.cause?.code === 'ECONNREFUSED' ? `no Chrome on CDP port ${port}. Start one (see the top of this file) or pass --cdp <port>` : e.message)
    process.exit(1)
  }
}
