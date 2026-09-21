// USB pairing is what authorizes a dial on WiFi. The token lives next to the rest of this
// computer's daemon state, keyed by the dial's MAC, so a second OpenHarness on the same LAN
// cannot welcome the device: it never saw the USB session that minted the secret.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { env } from '../config/env.js'

export const DIAL_BIND_FILE = 'dial-bind.json'

let dirOverride: string | undefined

export function setDialBindDirForTest(dir: string | undefined): void {
  dirOverride = dir
}

function filePath(): string {
  return join(dirOverride ?? env.ADAPTER_DATA_DIR, DIAL_BIND_FILE)
}

function normMac(mac: string): string {
  return mac.trim().toUpperCase()
}

function load(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as { tokens?: Record<string, string> }
    return raw.tokens && typeof raw.tokens === 'object' ? { ...raw.tokens } : {}
  } catch {
    return {}
  }
}

function save(tokens: Record<string, string>): void {
  const dir = dirOverride ?? env.ADAPTER_DATA_DIR
  mkdirSync(dir, { recursive: true })
  writeFileSync(filePath(), `${JSON.stringify({ tokens }, null, 2)}\n`)
}

/** Mint (or reuse) the token this computer presents after a USB hello. */
export function bindTokenForUsb(mac: string): string {
  const key = normMac(mac)
  if (!key) return ''
  const tokens = load()
  if (tokens[key]) return tokens[key]
  const token = randomBytes(32).toString('hex')
  tokens[key] = token
  save(tokens)
  return token
}

/** Token for a TCP hello. Null if this Mac has never USB-paired that dial. */
export function bindTokenForTcp(mac: string): string | null {
  const key = normMac(mac)
  if (!key) return null
  return load()[key] ?? null
}

export function isTcpDialPath(path: string): boolean {
  return path.startsWith('tcp:')
}
