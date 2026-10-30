/**
 * Windows: one core per data folder. Each start listens on a pipe of a new random name (lib/localSocket.ts), so
 * unlike the fixed Unix socket that listen never meets a second core on the same folder; and asking the recorded
 * pipe first (`refuseServedDataFolder`) cannot see two starts at once. So the core also holds a pipe of a FIXED
 * name per data folder for as long as it runs. libuv creates a pipe server with FILE_FLAG_FIRST_PIPE_INSTANCE, so
 * a second listen on that name fails with EADDRINUSE. Windows removes the claim with the process, however that ends.
 *
 * `\\.\pipe\` is one namespace for the whole computer, and any account may take a name nobody holds. So a start
 * that finds the name taken asks the holder to prove the daemon's token (pipeAuth.ts `claimProofValue`), the one
 * thing the claim answers. A core that proves it serves the folder: refused, unless its master is gone, which is
 * waited for as `refuseServedDataFolder` waits for one. A holder that may not be asked at all (access denied) is
 * refused too: a pipe takes the token of whoever made it, so that is what a daemon started as administrator or in
 * another Windows session looks like to an ordinary start (DESKTOP-0TFH0OJ, 2026-10-23: the second core ran beside
 * the first). Anything else (silent, closed, a wrong proof) is not Harness: the start goes on without the claim,
 * and says so.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { alreadyServing, ORPHAN_WAIT_MS, orphanStillServing } from '../localSocket.js'
import { claimProofValue, claimProven } from './pipeAuth.js'

export interface DataFolderClaim {
  /** The name the claim listens on. */
  path: string
  /** Whether this core holds the claim: false when something that is not Harness holds its name. */
  held: boolean
  /** Give the folder up: stop listening. Safe to call more than once. */
  release: () => void
}

/** Who holds a claim: the daemon's pid as everything outside knows it (its master's under one) and the core's. */
export interface ClaimHolder {
  pid: number
  corePid: number
}

export interface DataFolderClaimDeps {
  /** The folder's real path (made if missing): two spellings of one folder must name one claim. */
  realpath?: (dataDir: string) => string
  /** The fixed name for that real path. A spec puts a Unix socket here. */
  pipeFor?: (realDataDir: string) => string
  /** What this claim answers about its holder: this core and its master, if any. */
  holder?: ClaimHolder
  alive?: (pid: number) => boolean
  log?: (line: string) => void
  /** How long the holder of a taken name has to prove the token. */
  askTimeoutMs?: number
  /** How long a start waits for the core of a master that is gone to give the claim up. */
  waitMs?: number
  pollMs?: number
  /** Ask the holder of a taken name (`askHolder`); a spec stands in for a name that reads as gone. */
  ask?: (path: string, token: Buffer, timeoutMs: number) => Promise<ClaimHolder | 'gone' | 'denied' | null>
}

const ASK_TIMEOUT_MS = 3_000
const POLL_MS = 250
const NONCE = /^[0-9a-f]{64}$/
/** The most a request or an answer holds: a nonce and a newline, or a short line of JSON. */
const MAX_LINE = 1_024

/** `\\.\pipe\harness-claim-<first 32 hex of sha256 of the lowercased real path>`: Windows compares paths without case. */
export function dataFolderClaimPipe(realDataDir: string): string {
  return `\\\\.\\pipe\\harness-claim-${createHash('sha256').update(realDataDir.toLowerCase()).digest('hex').slice(0, 32)}`
}

function realDataFolder(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return realpathSync.native(dataDir)
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Listen on [path]: resolves with the server, rejects with the listen's error (EADDRINUSE when the name is taken). */
function listenClaim(path: string, token: Buffer, holder: ClaimHolder): Promise<Server> {
  // One request: a nonce on a line. One answer: its proof and the holder, on a line. Anything else is closed.
  const server = createServer((socket) => {
    let request = ''
    socket.setTimeout(ASK_TIMEOUT_MS, () => socket.destroy())
    socket.on('error', () => { /* the asker left */ })
    socket.on('data', (chunk) => {
      request += chunk.toString('latin1')
      const end = request.indexOf('\n')
      if (end < 0) { if (request.length > 64) socket.destroy(); return }
      const nonce = request.slice(0, end).replace(/\r$/, '')
      if (!NONCE.test(nonce)) { socket.destroy(); return }
      socket.end(`${JSON.stringify({ proof: claimProofValue(token, nonce), pid: holder.pid, corePid: holder.corePid })}\n`)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.removeAllListeners('error')
      server.on('error', () => { /* a listening claim has nothing to report */ })
      // Never what keeps the core running: it lives as long as the core does.
      server.unref()
      resolve(server)
    })
  })
}

/** Ask whoever holds [path] to prove [token]: the holder it names when it does, `gone` when nobody holds it, `denied`
 *  when this process may not open it, else null. */
function askHolder(path: string, token: Buffer, timeoutMs: number): Promise<ClaimHolder | 'gone' | 'denied' | null> {
  return new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex')
    const socket = connect(path)
    let answer = ''
    let done = false
    const finish = (result: ClaimHolder | 'gone' | 'denied' | null): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('connect', () => socket.write(`${nonce}\n`))
    socket.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'gone'
      : error.code === 'EPERM' || error.code === 'EACCES' ? 'denied' : null))
    socket.on('close', () => finish(null))
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8')
      const end = answer.indexOf('\n')
      if (end < 0) { if (answer.length > MAX_LINE) finish(null); return }
      try {
        const said = JSON.parse(answer.slice(0, end)) as { proof?: unknown; pid?: unknown; corePid?: unknown }
        const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
        finish(claimProven(said.proof, token, nonce) && whole(said.pid) && whole(said.corePid) ? { pid: said.pid, corePid: said.corePid } : null)
      } catch {
        finish(null)
      }
    })
  })
}

/**
 * Claim [dataDir] for this process, proving [token] to a later start that asks. Rejects with `alreadyServing` when a
 * core of this token holds it, with ORPHAN_STILL_SERVING when the core of a master that is gone does not give it up
 * in time, or with the listen's error. Resolves with `held: false` when the name is taken by something else.
 */
export async function claimDataFolder(dataDir: string, token: Buffer, deps: DataFolderClaimDeps = {}): Promise<DataFolderClaim> {
  const path = (deps.pipeFor ?? dataFolderClaimPipe)((deps.realpath ?? realDataFolder)(dataDir))
  const holder = deps.holder ?? { pid: process.pid, corePid: process.pid }
  const log = deps.log ?? ((line: string) => console.log(line))
  const isAlive = deps.alive ?? alive
  const deadline = performance.now() + (deps.waitMs ?? ORPHAN_WAIT_MS)
  let orphanSeen = false
  for (;;) {
    try {
      const server = await listenClaim(path, token, holder)
      if (orphanSeen) log('[cli] the core whose master is gone has given the data folder up — starting')
      let released = false
      return { path, held: true, release: () => { if (!released) { released = true; server.close() } } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
    const found = await (deps.ask ?? askHolder)(path, token, deps.askTimeoutMs ?? ASK_TIMEOUT_MS)
    if (found === 'denied') {
      throw Object.assign(new Error(`${path} is held by something this process may not open, most likely a Harness daemon started as administrator or in another Windows session. Stop it there, then start Harness again.`), { code: 'EADDRINUSE' })
    }
    if (found === null) {
      log(`[cli] something that is not Harness holds ${path}; starting without the data folder claim`)
      return { path, held: false, release: () => { /* nothing held */ } }
    }
    if (found !== 'gone') {
      if (found.pid === found.corePid || isAlive(found.pid)) throw alreadyServing(dataDir)
      if (!orphanSeen) log(`[cli] this data folder is still claimed by the core (pid ${found.corePid}) of a master that is gone (pid ${found.pid}) — waiting for it to leave`)
      orphanSeen = true
      if (performance.now() >= deadline) throw orphanStillServing(dataDir, found.corePid)
    } else if (performance.now() >= deadline) {
      // Taken at every listen, gone at every ask: nothing that proves the token holds it, so nothing here may keep this
      // daemon down (re-review N2).
      log(`[cli] ${path} stays taken by something that does not answer; starting without the data folder claim`)
      return { path, held: false, release: () => { /* nothing held */ } }
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS))
  }
}
