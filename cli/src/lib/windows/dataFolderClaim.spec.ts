// The Windows single-instance claim on a data folder. Here a Unix socket stands in for the fixed pipe (its second
// listen fails with EADDRINUSE as a pipe's does); the real pipe is checked in dataFolderClaim.real.spec.ts.
import { randomBytes } from 'node:crypto'
import { connect, createServer, type Server } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimDataFolder, dataFolderClaimPipe, type DataFolderClaim, type DataFolderClaimDeps } from './dataFolderClaim.js'
import { claimProofValue, pipeAuthValue, pipeProofValue } from './pipeAuth.js'

const dirs: string[] = []
const claims: DataFolderClaim[] = []
const servers: Server[] = []
afterEach(() => {
  claims.splice(0).forEach((claim) => claim.release())
  servers.splice(0).forEach((server) => server.close())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const TOKEN = Buffer.alloc(32, 7)
const lines: string[] = []
afterEach(() => { lines.length = 0 })

/** A data folder and deps that put its claim at a socket named for the folder's real path, as the pipe is. */
function folder(more: Partial<DataFolderClaimDeps> = {}): { dataDir: string; deps: DataFolderClaimDeps } {
  const root = mkdtempSync('/tmp/hclaim-')
  dirs.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  return {
    dataDir,
    deps: { realpath: (dir) => dir, pipeFor: (real) => join(real, '..', 'claim.sock'), log: (line) => lines.push(line), ...more },
  }
}

const take = async (...args: Parameters<typeof claimDataFolder>) => {
  const claim = await claimDataFolder(...args)
  claims.push(claim)
  return claim
}

/** Something that is not Harness listening on [path], doing [onConnect] with each connection. */
function squat(path: string, onConnect: (socket: import('node:net').Socket) => void): Promise<void> {
  const server = createServer(onConnect)
  servers.push(server)
  return new Promise((resolve) => server.listen(path, () => resolve()))
}

/** Ask the claim at [path] with [request] and return everything it answers before it closes. */
function ask(path: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let answer = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => { answer += chunk.toString('utf8') })
    socket.on('error', () => resolve(answer))
    socket.on('close', () => resolve(answer))
    socket.setTimeout(2_000, () => { socket.destroy(); resolve(answer) })
  })
}

describe('the data folder claim', () => {
  it('names one fixed pipe per data folder, whatever its case', () => {
    const pipe = dataFolderClaimPipe('C:\\Users\\Ann\\.harness\\cli\\data')
    expect(pipe).toMatch(/^\\\\\.\\pipe\\harness-claim-[0-9a-f]{32}$/)
    expect(dataFolderClaimPipe('c:\\users\\ann\\.harness\\cli\\DATA')).toBe(pipe)
    expect(dataFolderClaimPipe('C:\\Users\\Bob\\.harness\\cli\\data')).not.toBe(pipe)
  })
})

// A Unix socket for the pipe: on Windows the real pipe is what dataFolderClaim.real.spec.ts checks.
describe.skipIf(process.platform === 'win32')('the data folder claim, a Unix socket standing in for its pipe', () => {

  it('refuses a second claim on the same folder as a daemon already serving it, and allows one once released', async () => {
    const { dataDir, deps } = folder()
    const first = await claimDataFolder(dataDir, TOKEN, { ...deps, holder: { pid: process.pid, corePid: process.pid } })
    const second = claimDataFolder(dataDir, TOKEN, deps)
    await expect(second).rejects.toMatchObject({ code: 'EADDRINUSE', message: `A Harness daemon is already serving ${dataDir}` })
    first.release()
    first.release()
    expect((await take(dataDir, TOKEN, deps)).held).toBe(true)
  })

  it('refuses a second claim while the master of the core holding it is alive', async () => {
    const { dataDir, deps } = folder({ alive: (pid) => pid === 41 })
    await take(dataDir, TOKEN, { ...deps, holder: { pid: 41, corePid: 42 } })
    await expect(claimDataFolder(dataDir, TOKEN, deps)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('lets a claim on another folder through', async () => {
    const a = folder(), b = folder()
    await take(a.dataDir, TOKEN, a.deps)
    await take(b.dataDir, TOKEN, b.deps)
  })

  it('answers only a nonce, with its proof of the token, its own and never a pipe auth or a pipe proof', async () => {
    const { dataDir, deps } = folder()
    const claim = await take(dataDir, TOKEN, { ...deps, holder: { pid: 41, corePid: 42 } })
    const nonce = randomBytes(32).toString('hex')
    const answer = JSON.parse(await ask(claim.path, `${nonce}\n`)) as { proof: string; pid: number; corePid: number }
    expect(answer).toEqual({ proof: claimProofValue(TOKEN, nonce), pid: 41, corePid: 42 })
    expect(answer.proof).not.toBe(pipeProofValue(TOKEN, nonce))
    expect(pipeAuthValue(TOKEN, nonce)).not.toContain(answer.proof)
    expect(await ask(claim.path, 'GET / HTTP/1.1\r\n\r\n')).toBe('')
  })

  it('starts without the claim, and says so, when what holds its name is not Harness', async () => {
    for (const behaviour of [
      (socket: import('node:net').Socket) => socket.destroy(),
      (socket: import('node:net').Socket) => socket.end('{"proof":"' + 'ab'.repeat(32) + '","pid":1,"corePid":1}\n'),
      (socket: import('node:net').Socket) => { socket.on('data', () => { /* never answers */ }) },
    ]) {
      const { dataDir, deps } = folder({ askTimeoutMs: 200 })
      const path = deps.pipeFor!(dataDir)
      await squat(path, behaviour)
      const claim = await take(dataDir, TOKEN, deps)
      expect(claim).toMatchObject({ path, held: false })
      claim.release()
      expect(lines.at(-1)).toBe(`[cli] something that is not Harness holds ${path}; starting without the data folder claim`)
    }
  })

  // DESKTOP-0TFH0OJ, 2026-10-23: a core started over ssh as administrator held the claim; the Desktop then started one
  // with an ordinary token, whose ask was refused with EPERM. It read that as "not Harness" and ran beside the first:
  // two hosts wrote one observer file and claimed the same deliveries. A socket nobody may write stands in for that pipe.
  it.skipIf(process.getuid?.() === 0)('refuses the start when the holder of its name may not be asked', async () => {
    const { dataDir, deps } = folder()
    await take(dataDir, TOKEN, { ...deps, holder: { pid: process.pid, corePid: process.pid } })
    const path = deps.pipeFor!(dataDir)
    chmodSync(path, 0)
    await expect(claimDataFolder(dataDir, TOKEN, deps)).rejects.toMatchObject({ code: 'EADDRINUSE',
      message: `${path} is held by something this process may not open, most likely a Harness daemon started as administrator or in another Windows session. Stop it there, then start Harness again.` })
  })

  it('starts without the claim when the core holding it proves another token', async () => {
    const { dataDir, deps } = folder()
    await take(dataDir, Buffer.alloc(32, 9), { ...deps, holder: { pid: process.pid, corePid: process.pid } })
    expect((await take(dataDir, TOKEN, deps)).held).toBe(false)
  })

  it('waits for the core of a master that is gone, then claims the folder once it leaves', async () => {
    let orphanObserved!: () => void
    const waiting = new Promise<void>((resolve) => { orphanObserved = resolve })
    const { dataDir, deps } = folder({ alive: () => false, pollMs: 20, log: (line) => {
      lines.push(line)
      orphanObserved()
    } })
    const orphan = await claimDataFolder(dataDir, TOKEN, { ...deps, holder: { pid: 41, corePid: 42 } })
    const claiming = take(dataDir, TOKEN, deps)
    // A timed close could cut the holder's proof in half under CI load and test the unrelated
    // "not Harness" path. Release only after the claimant has proved and observed the orphan.
    await waiting
    orphan.release()
    expect((await claiming).held).toBe(true)
    expect(lines).toContain(`[cli] this data folder is still claimed by the core (pid 42) of a master that is gone (pid 41) — waiting for it to leave`)
  })

  it('ends the start in the orphan code when the core of a master that is gone does not leave in time', async () => {
    const { dataDir, deps } = folder({ alive: () => false, pollMs: 20, waitMs: 100 })
    await take(dataDir, TOKEN, { ...deps, holder: { pid: 41, corePid: 42 } })
    await expect(claimDataFolder(dataDir, TOKEN, deps)).rejects.toMatchObject({ code: 'ORPHAN_STILL_SERVING' })
  })

  // Re-review N2: a name that kept reading as taken at the listen and as absent at the ask ended the start as "already
  // serving" after a busy loop. It is tried again at the poll interval, and at the deadline the start goes on without it.
  it('starts without the claim when its name keeps reading as taken, then gone, until the deadline, asking at the poll interval', async () => {
    const { dataDir, deps } = folder({ waitMs: 200, pollMs: 50 })
    const path = deps.pipeFor!(dataDir)
    await squat(path, (socket) => socket.destroy())
    let asked = 0
    const claim = await take(dataDir, TOKEN, { ...deps, ask: async () => { asked++; return 'gone' } })
    expect(claim).toMatchObject({ path, held: false })
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(asked).toBeLessThanOrEqual(6)
    expect(lines.at(-1)).toBe(`[cli] ${path} stays taken by something that does not answer; starting without the data folder claim`)
  })

  it('fails the start on any other error', async () => {
    const { dataDir } = folder()
    await expect(claimDataFolder(dataDir, TOKEN, { realpath: (dir) => dir, pipeFor: (real) => join(real, 'missing', 'claim.sock') }))
      .rejects.toMatchObject({ syscall: 'listen' })
  })

  it('by default, claims the real path of the folder, made if missing', async () => {
    const root = mkdtempSync('/tmp/hclaim-')
    dirs.push(root)
    const dataDir = join(root, 'new', 'data')
    let named = ''
    const claim = await take(dataDir, TOKEN, { pipeFor: (real) => { named = real; return join(root, 'claim.sock') } })
    expect(named).toBe(join(realpathSync.native(root), 'new', 'data'))
    expect(claim.path).toBe(join(root, 'claim.sock'))
  })
})
