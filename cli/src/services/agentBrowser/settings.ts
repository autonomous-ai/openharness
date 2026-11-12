import { createHash } from 'node:crypto'

/** The daemon's own zone and language, read once from `Intl.DateTimeFormat().resolvedOptions()`. */
export interface BrowserHost {
  timeZone: string
  languages: string
}

const SCHEMES = ['http', 'https', 'socks5'] as const
// Portrait first, and the default: the Desktop's Browser panel sits beside the chat, taller than wide, and a
// 1920x1080 window left black bands above and below it. Each is a real monitor turned on its side.
const SCREENS = ['1080x1920', '1200x1920', '1050x1680', '1920x1080', '1680x1050', '1536x864', '1440x900', '1366x768'] as const
const SPEEDS = ['slow', 'normal', 'fast'] as const

export type BrowserSettings = {
  proxy: {
    scheme: (typeof SCHEMES)[number]
    host: string
    port: number
    username: string
    password: string
  } | null
  /** null is Auto: the proxy's exit zone when a proxy is set, the machine's otherwise. */
  timeZone: string | null
  languages: string
  screen: (typeof SCREENS)[number]
  humanInput: boolean
  humanSpeed: (typeof SPEEDS)[number]
  device: { gpuVendor: string; gpuRenderer: string; cpuCores: number; memoryGb: number } | null
}

// SOCKS5 carries the username and the password in one byte of length each.
const MAX_LOGIN = 255
const MAX_LANGUAGES = 10
const MAX_DEVICE_NAME = 200

export function defaultSettings(host: BrowserHost): BrowserSettings {
  return {
    proxy: null,
    timeZone: null,
    languages: host.languages,
    screen: '1080x1920',
    humanInput: true,
    humanSpeed: 'normal',
    device: null,
  }
}

function invalid(field: string): never {
  throw new Error(`invalid browser setting: ${field}`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field)
  return value as Record<string, unknown>
}

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  return values.includes(value as T) ? (value as T) : invalid(field)
}

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim() === '')) invalid(field)
  return value
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid(field)
  return value as number
}

function parseTimeZone(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') invalid('timeZone')
  let zone: string
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    invalid('timeZone')
  }
  // Intl also takes offsets such as +07:00; the browser's TZ needs a named IANA zone.
  return /^[+-]/.test(zone) ? invalid('timeZone') : zone
}

function parseLanguages(value: unknown): string {
  const tags = text(value, 'languages', 200).split(',').map((tag) => tag.trim())
  if (tags.length > MAX_LANGUAGES) invalid('languages')
  try {
    return Intl.getCanonicalLocales(tags).join(', ')
  } catch {
    invalid('languages')
  }
}

function parseProxy(value: unknown, current: BrowserSettings['proxy']): BrowserSettings['proxy'] {
  if (value === null) return null
  const raw = record(value, 'proxy')
  const host = text(raw.host, 'proxy.host', 253)
  // A host name, an IPv4 address or an IPv6 address; anything else would change the proxy URL.
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) invalid('proxy.host')
  const scheme = oneOf(SCHEMES, raw.scheme, 'proxy.scheme')
  const port = integer(raw.port, 'proxy.port', 1, 65535)
  const username = text(raw.username, 'proxy.username', MAX_LOGIN, true)
  if (raw.password !== undefined) return { scheme, host, port, username, password: text(raw.password, 'proxy.password', MAX_LOGIN, true) }
  // The password is write-only: a form that never saw it sends none, and the stored one stays. Only for the same
  // proxy and login: a changed host would otherwise be sent a password the person never gave it.
  const same = current?.scheme === scheme && current.host === host && current.port === port && current.username === username
  return { scheme, host, port, username, password: same ? current.password : '' }
}

function parseDevice(value: unknown): BrowserSettings['device'] {
  if (value === null) return null
  const raw = record(value, 'device')
  return {
    gpuVendor: text(raw.gpuVendor, 'device.gpuVendor', MAX_DEVICE_NAME),
    gpuRenderer: text(raw.gpuRenderer, 'device.gpuRenderer', MAX_DEVICE_NAME),
    cpuCores: integer(raw.cpuCores, 'device.cpuCores', 1, 256),
    memoryGb: integer(raw.memoryGb, 'device.memoryGb', 1, 1024),
  }
}

export function parseSettings(raw: unknown, current: BrowserSettings): BrowserSettings {
  const s = record(raw, 'settings')
  if (typeof s.humanInput !== 'boolean') invalid('humanInput')
  return {
    proxy: parseProxy(s.proxy, current.proxy),
    timeZone: parseTimeZone(s.timeZone),
    languages: parseLanguages(s.languages),
    screen: oneOf(SCREENS, s.screen, 'screen'),
    humanInput: s.humanInput,
    humanSpeed: oneOf(SPEEDS, s.humanSpeed, 'humanSpeed'),
    device: parseDevice(s.device),
  }
}

export function publicSettings(s: BrowserSettings) {
  if (!s.proxy) return { ...s, proxy: null }
  const { password, ...proxy } = s.proxy
  return { ...s, proxy: { ...proxy, passwordSet: password !== '' } }
}

/** The container's `harness.settings` label: human input applies per tool call, so it never recreates the container. */
export function settingsHash(s: BrowserSettings): string {
  const { humanInput: _humanInput, humanSpeed: _humanSpeed, ...container } = s
  return createHash('sha256').update(JSON.stringify(container)).digest('hex')
}

export function humanMode(s: BrowserSettings): 'off' | 'slow' | 'normal' | 'fast' {
  return s.humanInput ? s.humanSpeed : 'off'
}

// The smallest window a page lays out for a desktop; below it pages switch to their phone layout.
const MIN_WINDOW = { width: 1024, height: 640 }

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** The size Chrome's window takes for the panel's (spec: The window fits the panel): whole numbers, at least
 *  1024x640, at most `screen` ("1080x1920"); null for anything that is not two positive numbers. A panel under
 *  1024x640 grows by one factor on both sides, so the window keeps the panel's shape and the viewer, scaling it down
 *  evenly, fills the panel; only the screen's cap can change the shape. Every screen in SCREENS is at least 1024 wide,
 *  portrait ones too, so a window always has a desktop's width. */
export function clampWindow(width: unknown, height: unknown, screen: string): { width: number; height: number } | null {
  if (!isSize(width) || !isSize(height)) return null
  const [maxWidth, maxHeight] = screen.split('x').map(Number) as [number, number]
  const grow = Math.max(1, MIN_WINDOW.width / width, MIN_WINDOW.height / height)
  return {
    width: Math.round(Math.min(maxWidth, width * grow)),
    height: Math.round(Math.min(maxHeight, height * grow)),
  }
}
