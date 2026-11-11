import type { ExecFileException } from 'node:child_process'
import * as childProcess from 'node:child_process'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { LSOF_MS, peerIsThisAccount } from './peerAccount.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }))

type Done = (error: ExecFileException | null, stdout: string, stderr: string) => void
const caller = () => ({ remoteAddress: '127.0.0.1', remotePort: 50_000, localAddress: '127.0.0.1', localPort: 18473 }) as Socket
const lsofAnswers = (...answers: Array<[ExecFileException | null, string]>) => {
  vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
    const [error, stdout] = answers.shift()!
    ;(args.at(-1) as Done)(error, stdout, '')
  }) as unknown as typeof childProcess.execFile)
}
const failed = (fields: Partial<ExecFileException>) => Object.assign(new Error('Command failed'), fields) as ExecFileException

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(childProcess.execFile).mockReset()
})

// Under load, macOS's lsof ran past its limit and was killed; that was kept as "not this account" for the socket, so
// the person's own keep-alive client was refused LOCAL_CREDENTIAL_REQUIRED on every later request (hookServer.spec).
it.skipIf(process.getuid === undefined)('asks lsof again on the next request of a connection whose lookup ran out of time', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  lsofAnswers([failed({ killed: true, code: null as unknown as undefined, signal: 'SIGTERM' }), ''], [null, 'p1\nf3\nn127.0.0.1:50000->127.0.0.1:18473\n'])
  const socket = caller()
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  expect(await peerIsThisAccount(socket, 'darwin')).toBe(true)
  expect(childProcess.execFile).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledWith(`[peer] lsof did not say who is calling in ${LSOF_MS} ms`)
  expect(warn).toHaveBeenCalledWith('[peer] refused a valid secret on 127.0.0.1:18473: lsof did not answer in time; asked again on its next request')
})

it.skipIf(process.getuid === undefined)('keeps a no on the connection: lsof found nothing, or failed for any reason but time', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  lsofAnswers([failed({ code: 1 }), ''], [failed({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), ''], [failed({ code: 'EAGAIN' }), ''])
  for (let n = 0; n < 3; n++) {
    const socket = caller()
    expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
    expect(await peerIsThisAccount(socket, 'darwin')).toBe(false)
  }
  expect(childProcess.execFile).toHaveBeenCalledTimes(3)
})
