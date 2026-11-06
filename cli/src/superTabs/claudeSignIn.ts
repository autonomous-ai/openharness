/**
 * Claude Code signed in on this machine from the phone, with no terminal and no code to copy (owner, 2026-11-05): the
 * phone setting up a new computer for its Buddy asks for `claude auth login`'s page, opens it, and the person signs in
 * there. The page returns to `http://localhost:PORT/callback`, which on the phone is the phone itself: the phone catches
 * that redirect, as it does for a sign-in in a pane (core/terminals/browser.ts), and sends it here, and it is handed to
 * the login waiting on that port on this machine.
 *
 * The localhost page is the one `claude auth login` hands BROWSER, so BROWSER here is a script that only writes it down.
 * The login also prints a page for a browser elsewhere ("If the browser didn't open, visit: …"), whose end is Claude's
 * code page: kept as `codeUrl`, for a phone that cannot catch the redirect, whose code then goes into the login's input
 * ("Paste code here if prompted").
 *
 * One sign-in at a time, by the phone's operation id: asked again under it, the phone reads how it goes; a new id stops
 * the one before. Bounded in time and output (core/AGENTS.md rule 4).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineInstallPaths, engineInstallRecipe } from '../lib/engineInstall.js'
import { identifier } from './host.js'

type Json = Record<string, unknown>

/** How long the person has to sign in on the phone. */
export const CLAUDE_SIGN_IN_MS = 15 * 60_000
const MAX_OUTPUT = 64 * 1024

/** The page `claude auth login` prints for a browser elsewhere: the one whose end is Claude's code page. */
export function claudeSignInPageOf(output: string): string | null {
  return /visit:\s*(https:\/\/\S+)/i.exec(output)?.[1] ?? null
}

/** Where [page] returns to on this machine: its `http://localhost:PORT/…` redirect, or null for any other page. */
export function loopbackRedirectOf(page: string): URL | null {
  try {
    const redirect = new URL(new URL(page).searchParams.get('redirect_uri') ?? '')
    return redirect.protocol === 'http:' && (redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1') && redirect.port
      ? redirect : null
  } catch {
    return null
  }
}

/** Claude Code's executable here: where Harness installs it first (lib/engineInstall.ts), else the PATH's. */
export function claudeExecutable(exists: (path: string) => boolean = executable): string {
  const recipe = engineInstallRecipe('claude')
  return (recipe ? engineInstallPaths(recipe, homedir()) : []).find(exists) ?? 'claude'
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/** A login under way: its process, and the file its BROWSER writes the localhost page to. */
export interface ClaudeLogin { child: ChildProcess; page: () => string | null; done: () => void }

interface Job {
  id: string; login: ClaudeLogin; output: string; result: Json; timer: NodeJS.Timeout; codeUrl: string | null; codeAt: number
  /** The redirect's replay failed or timed out: the login's own exit says whether it took all the same. */
  undelivered?: boolean
}

const NOT_DELIVERED: Json = { error: 'NOT_DELIVERED', detail: 'Claude Code on this computer did not take the sign-in. Try again.' }

/** How long after its printed page the localhost one may still be on its way from BROWSER. */
const LOCAL_PAGE_WAIT_MS = 3_000

export class ClaudeSignIns {
  private job: Job | null = null
  constructor(
    private readonly start: () => ClaudeLogin = startClaudeLogin,
    private readonly replay: (url: string) => Promise<number> = loopbackGet,
    private readonly now: () => number = Date.now,
  ) {}

  /** `claudeSignIn` {operationId, callback?, code?}: starts the sign-in under a new id; hands it the redirect the phone
   *  caught ([callback]) or the code Claude's page showed ([code]); answers how it goes: `starting`, `page` with its
   *  `url` (and `codeUrl`), `checking`, `done`, or an error. */
  async read(input: Json): Promise<Json> {
    if (!identifier(input.operationId)) return { error: 'INVALID_REQUEST' }
    let job = this.job
    if (job?.id !== input.operationId) {
      // A redirect or a code for a sign-in no longer here (stopped as this computer's connection dropped): a new one would
      // never take it, so the phone is told to open Claude's page again (review of #3149).
      if (typeof input.callback === 'string' || typeof input.code === 'string') {
        return { error: 'SIGN_IN_EXPIRED', detail: 'The sign-in stopped on this computer. Open Claude\'s page again.' }
      }
      this.stop()
      job = this.job = this.begin(input.operationId as string)
    }
    this.look(job)
    if (job.result.state !== 'page') return job.result
    if (typeof input.callback === 'string') {
      const expected = loopbackRedirectOf(String(job.result.url))
      let caught: URL | null = null
      try { caught = new URL(input.callback) } catch { /* answered below */ }
      // Only to the port and path the login is waiting on: the phone must not reach any other port of this machine.
      if (!expected || !caught || caught.protocol !== 'http:' || caught.port !== expected.port || caught.pathname !== expected.pathname) {
        return { error: 'NOT_EXPECTED', detail: 'That sign-in is not the one this computer is waiting for. Try again.' }
      }
      job.result = { ok: true, state: 'checking' }
      try {
        await this.replay(`http://127.0.0.1:${expected.port}${caught.pathname}${caught.search}`)
      } catch {
        // A token exchange slower than the replay's wait still signs in: while the login runs, its exit decides (review of
        // #3149). One already gone did not take it.
        job.undelivered = true
        if (job.login.child.exitCode !== null && job.result.state === 'checking') job.result = NOT_DELIVERED
      }
      return job.result
    }
    if (typeof input.code === 'string' && input.code.trim()) {
      job.login.child.stdin?.write(`${input.code.trim()}\n`)
      job.result = { ok: true, state: 'checking' }
    }
    return job.result
  }

  stop(): void {
    if (!this.job) return
    clearTimeout(this.job.timer)
    if (this.job.login.child.exitCode === null) this.job.login.child.kill('SIGKILL')
    this.job.login.done()
    this.job = null
  }

  /** The page once both are known: the localhost one its BROWSER wrote, else (an older Claude Code that opens none)
   *  the code page alone. */
  private look(job: Job): void {
    if (job.result.state !== 'starting' || !job.codeUrl) return
    const local = job.login.page()
    if (!local && this.now() - job.codeAt < LOCAL_PAGE_WAIT_MS) return
    job.result = { ok: true, state: 'page', url: local && loopbackRedirectOf(local) ? local : job.codeUrl, codeUrl: job.codeUrl }
  }

  private begin(id: string): Job {
    const login = this.start()
    const { child } = login
    const job: Job = { id, login, output: '', codeUrl: null, codeAt: 0, result: { ok: true, state: 'starting' },
      timer: setTimeout(() => {
        child.kill('SIGKILL')
        job.result = { error: 'SIGN_IN_EXPIRED', detail: 'The sign-in took too long. Try again.' }
      }, CLAUDE_SIGN_IN_MS) }
    const read = (chunk: Buffer): void => {
      if (job.output.length < MAX_OUTPUT) job.output += chunk.toString('utf8')
      if (job.codeUrl) return
      job.codeUrl = claudeSignInPageOf(job.output)
      if (job.codeUrl) job.codeAt = this.now()
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.stdin?.on('error', () => { /* it exited before reading the code */ })
    child.on('error', () => {
      clearTimeout(job.timer)
      login.done()
      job.result = { error: 'CLAUDE_UNAVAILABLE', detail: 'Claude Code is not installed on this computer.' }
    })
    child.on('close', (status) => {
      clearTimeout(job.timer)
      login.done()
      // Signed in, whatever the replay of its redirect said on the way.
      if (status === 0) { job.result = { ok: true, state: 'done' }; return }
      if (job.result.error) return
      if (job.undelivered) { job.result = NOT_DELIVERED; return }
      // Its last line says why, in its words ("Invalid code", …); never a page, which carries the sign-in's state.
      const last = job.output.replace(/https?:\/\/\S+/g, '').trim().split('\n').pop()?.trim().slice(0, 200)
      job.result = { error: 'SIGN_IN_FAILED', detail: last ? `Claude did not take it: ${last}` : 'Claude did not take it. Try again.' }
    })
    return job
  }
}

/** `claude auth login --claudeai`, its pages for the phone: BROWSER writes the one it is handed into a file of its own,
 *  and opens nothing; no display either, so nothing opens on this computer's screen. Its input stays open for a code. */
export function startClaudeLogin(): ClaudeLogin {
  const folder = mkdtempSync(join(tmpdir(), 'harness-claude-sign-in-'))
  const page = join(folder, 'page'), browser = join(folder, 'browser')
  writeFileSync(browser, '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$HARNESS_CLAUDE_PAGE"\n', { mode: 0o700 })
  const { WAYLAND_DISPLAY: _wayland, DISPLAY: _x11, ...env } = process.env
  const child = spawn(claudeExecutable(), ['auth', 'login', '--claudeai'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, BROWSER: browser, HARNESS_CLAUDE_PAGE: page } })
  return {
    child,
    page: () => { try { return readFileSync(page, 'utf8').trim() || null } catch { return null } },
    done: () => rmSync(folder, { recursive: true, force: true }),
  }
}

/** GET [url] on this machine: the login's own callback, which finishes it. */
async function loopbackGet(url: string): Promise<number> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  return response.status
}
