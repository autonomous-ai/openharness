import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { localSocketName, socketPathIn } from '../lib/localSocket.js'
import { SOCKET_PATH_ROOM, assertSocketPathFits, suiteSocketPath } from './socketPathRoom.js'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fullDisk.spec.ts loads
// fullDisk.ts.
const setup = (await import('../../e2e/harness/socketRoom.js' as string) as { default: () => void }).default

const said = (path: string) => `TMPDIR is too long for the daemon's Unix socket: ${path} would be ${Buffer.byteLength(path)} bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`
const LONG = 'a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be'

const tmpdirBefore = process.env.TMPDIR
let base: string | undefined
afterEach(() => {
  if (tmpdirBefore === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = tmpdirBefore
  if (base) rmSync(base, { recursive: true, force: true })
  base = undefined
})

it('the default macOS and Linux TMPDIRs pass', () => {
  expect(suiteSocketPath('/tmp')).toBe('/tmp/htmux-XXXXXX/data/daemon-65535.sock')
  expect(() => assertSocketPathFits(suiteSocketPath('/tmp'))).not.toThrow()
  expect(() => assertSocketPathFits(suiteSocketPath('/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T'))).not.toThrow()
})

it('a long folder fails, saying so', () => {
  const tmp = '/private/tmp/claude-502/-Users-someone-workspaces-project/0f8fad5b-d9cb-469f-a165-70867728950e/scratchpad'
  expect(() => assertSocketPathFits(suiteSocketPath(tmp))).toThrow(
    `TMPDIR is too long for the daemon's Unix socket: ${tmp}/htmux-XXXXXX/data/daemon-65535.sock would be 141 bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`)
})

it('its room is the daemon\'s own, to the byte', () => {
  const name = localSocketName(65535), fits = `/${'a'.repeat(77)}`, over = `${fits}a`   // 96 and 97 bytes with the name
  expect(SOCKET_PATH_ROOM).toBe(96)
  expect(socketPathIn(fits, name, '/h')).toBe(join(fits, name))
  expect(() => assertSocketPathFits(join(fits, name))).not.toThrow()
  expect(socketPathIn(over, name, '/h')).not.toBe(join(over, name))
  expect(() => assertSocketPathFits(join(over, name))).toThrow(said(join(over, name)))
})

it('counts bytes, not characters', () => {
  const path = suiteSocketPath(`/${'é'.repeat(30)}`)   // 67 characters, 97 bytes
  expect(() => assertSocketPathFits(path)).toThrow(' would be 97 bytes; ')
})

it('the suite\'s setup measures the real TMPDIR, as macOS\'s /var is /private/var', () => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 's-'))
  const real = join(base, LONG), link = join(base, 't')
  mkdirSync(real)
  symlinkSync(real, link)
  process.env.TMPDIR = link
  expect(() => setup()).toThrow(said(join(real, 'htmux-XXXXXX', 'data', 'daemon-65535.sock')))
  process.env.TMPDIR = '/tmp'
  expect(() => setup()).not.toThrow()
})
