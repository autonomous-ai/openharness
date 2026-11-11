import type { ExecFileException } from 'node:child_process'
import * as childProcess from 'node:child_process'
import * as fsPromises from 'node:fs/promises'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { peerIsThisAccount } from './peerAccount.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

type Done = (error: ExecFileException | null, stdout: string, stderr: string) => void
const caller = () => ({ remoteAddress: '127.0.0.1', remotePort: 50_000, localAddress: '127.0.0.1', localPort: 18473 }) as Socket
const uid = process.getuid?.()

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(childProcess.execFile).mockReset()
})

// Under load, macOS's lsof ran past its 3 s limit and was killed; that was kept as "not this account" for the socket,
// so the person's own keep-alive client was refused LOCAL_CREDENTIAL_REQUIRED on every later request (hookServer.spec).
it.skipIf(uid === undefined)('asks lsof again on the next request of a connection whose lookup was killed or could not run', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const answers: Array<[ExecFileException | null, string]> = [
    [Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }) as ExecFileException, ''],
    [Object.assign(new Error('spawn /usr/sbin/lsof EAGAIN'), { code: 'EAGAIN' }) as ExecFileException, ''],
    [null, 'p1\nf3\nn127.0.0.1:50000->127.0.0.1:18473\n'],
  ]
  vi.mocked(childProcess.execFile).mockImplementation(((..._args: unknown[]) => {
    const [error, stdout] = answers.shift()!
    ;(_args.at(-1) as Done)(error, stdout, '')
  }) as unknown as typeof childProcess.execFile)
  const socket = caller()
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(true)
  expect(childProcess.execFile).toHaveBeenCalledTimes(3)
  expect(warn).toHaveBeenCalledWith('[peer] could not ask lsof who is calling: no answer in 3000 ms')
  expect(warn).toHaveBeenCalledWith('[peer] refused a valid secret on 127.0.0.1:18473: the lookup of who is calling gave no answer; asked again on its next request')
})

it.skipIf(uid === undefined)('keeps an answered no on the connection', async () => {
  vi.mocked(childProcess.execFile).mockImplementation(((..._args: unknown[]) => {
    ;(_args.at(-1) as Done)(Object.assign(new Error('exit 1'), { code: 1 }) as ExecFileException, '', '')
  }) as unknown as typeof childProcess.execFile)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const socket = caller()
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  expect(childProcess.execFile).toHaveBeenCalledOnce()
})

it.skipIf(uid === undefined)('reads /proc/net/tcp again on the next request when it could not be read', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const row = `   0: 0100007F:C350 0100007F:4829 01 00000000:00000000 00:00000000 00000000 ${uid}        0 1`
  vi.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }))
    .mockResolvedValueOnce(`header\n${row}\n`)
  const socket = caller()
  expect(await peerIsThisAccount(socket, 'linux')).toBe(false)
  expect(await peerIsThisAccount(socket, 'linux')).toBe(true)
})
