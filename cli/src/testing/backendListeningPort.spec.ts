import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { backendListeningPort, backendListeningPortIn } from './backendListeningPort.js'

const at = '[2026-11-14T03:04:05.678Z] [INFO] '
const proxy = `${at}backend subdomain app-proxy listening on 0 {"suffix":".harness.autonomous.ai"}\n`

it('reads the port the backend said it bound', () => {
  expect(backendListeningPort(`${proxy}${at}backend listening on 43121\n`)).toBe(43121)
})
it('has no port before the backend said one: the app proxy\'s line is another listener\'s', () => {
  expect(backendListeningPort('')).toBeNull()
  expect(backendListeningPort(proxy)).toBeNull()
})
it('does not read a line caught in the middle of its port', () => {
  expect(backendListeningPort(`${proxy}${at}backend listening on 431`)).toBeNull()
})
it('reads a log file, and has no port while the file is not there yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backend-port-'))
  try {
    expect(backendListeningPortIn(join(dir, 'backend.log'))).toBeNull()
    writeFileSync(join(dir, 'backend.log'), `${proxy}${at}backend listening on 43121\n`)
    expect(backendListeningPortIn(join(dir, 'backend.log'))).toBe(43121)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
