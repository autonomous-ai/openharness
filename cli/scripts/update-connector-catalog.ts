#!/usr/bin/env -S npx tsx
/**
 * Rebuild src/lib/connectors/assets/catalog.json and its icons from the Grid connector gateway
 * (GET /v1/grid/connectors), the list the Grid app shows, then the generated modules.
 *
 *   npx tsx scripts/update-connector-catalog.ts             # needs `harness login` (or `grid login`)
 *   npx tsx scripts/update-connector-catalog.ts rows.json   # from a saved GET /v1/grid/connectors
 *
 * Grid's `dcr` services sign in from the computer; its `app` services through the gateway, unless their
 * MCP server also allows dynamic client registration (checked here, live). Icons are fetched once, 64 px
 * PNG via `sips` (macOS) or ImageMagick, so neither the page nor the app loads anything from the network.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { call } from '../src/lib/connectors/gateway.js'
import { probe } from '../src/lib/connectors/oauth.js'
import type { GatewayRow } from '../src/lib/connectors/catalog.js'

const assets = fileURLToPath(new URL('../src/lib/connectors/assets/', import.meta.url))
const icons = join(assets, 'web/icons')

async function selfRegisters(url: string): Promise<boolean> {
  try {
    const meta = await probe(url)
    return meta.kind === 'oauth' && Boolean(meta.registration_endpoint) && meta.s256
  } catch { return false }
}

async function icon(code: string, url?: string): Promise<void> {
  if (!url || ['.png', '.svg'].some(ext => existsSync(join(icons, code + ext)))) return
  let data: Buffer
  try { data = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).arrayBuffer()) } catch { console.error(`${code}: no icon`); return }
  if (data.subarray(0, 300).toString().includes('<svg')) { writeFileSync(join(icons, code + '.svg'), data); return }
  const source = join(mkdtempSync(join(tmpdir(), 'icon-')), 'source')
  writeFileSync(source, data)
  const target = join(icons, code + '.png')
  try { execFileSync('sips', ['-s', 'format', 'png', '-Z', '64', source, '--out', target], { stdio: 'ignore' }) } catch {
    execFileSync('magick', [source + '[0]', '-resize', '64x64>', target])
  }
}

const file = join(assets, 'catalog.json')
const old = JSON.parse(readFileSync(file, 'utf8')) as { _note: string, connectors: { code: string, description: string }[] }
const before = Object.fromEntries(old.connectors.map(item => [item.code, item]))
const rows = (process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await call('connectors')) as { connectors?: GatewayRow[] } | GatewayRow[]
const items = []
for (const row of [...(Array.isArray(rows) ? rows : rows.connectors ?? [])].sort((a, b) => a.code.localeCompare(b.code))) {
  let auth = row.auth_type
  if (auth === 'app' && row.mcp_url && await selfRegisters(row.mcp_url)) auth = 'dcr'
  if (auth !== 'app' && auth !== 'dcr') continue
  // A description written here is kept: the gateway's has carried placeholder text. Review new ones.
  items.push({ code: row.code, label: row.label ?? row.code, auth, description: before[row.code]?.description || row.description || '', ...(row.mcp_url ? { mcp_url: row.mcp_url } : {}) })
  await icon(row.code, (row as { image_url?: string }).image_url)
  console.log(`${auth} ${row.code}`)
}
writeFileSync(file, JSON.stringify({ _note: old._note, connectors: items }, null, 1) + '\n')
execFileSync(process.execPath, [fileURLToPath(new URL('./connector-assets.mjs', import.meta.url))], { stdio: 'inherit' })
