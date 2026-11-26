/**
 * Claude Code or Codex signed in on this machine from the phone's Chat UI, with no terminal and no code to copy: a
 * harness started on a computer where its engine is signed out opens on the engine's own first-run screens, which a chat
 * cannot show, so Chat UI asks for a sign-in instead (Pixel, 2026-11-26). The phone asks for the engine's login page,
 * opens it, and the person signs in there. The page returns to `http://localhost:PORT/callback`, which on the phone is the
 * phone itself: the phone catches that redirect, as it does for a sign-in in a pane (core/terminals/browser.ts), and sends
 * it here, and it is handed to the login waiting on that port on this machine.
 *
 * Brought back from the Swarm's sign-in (#3149, owner 2026-11-05 and 2026-11-06), deleted with it (#4303).
 *
 * The localhost page is the one the login hands BROWSER, so BROWSER here is a script that only writes it down. Claude
 * Code also prints a page for a browser elsewhere ("If the browser didn't open, visit: …"), whose end is Claude's code
 * page: kept as `codeUrl`, for a phone that cannot catch the redirect, whose code then goes into the login's input.
 *
 * One sign-in at a time, by the phone's operation id: asked again under it, the phone reads how it goes; a new id stops
 * the one before. Bounded in time and output.
 */
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { recordTrustIn, replaceConfigFile } from '../engines/kit/folderTrust.js'
import { launchContract } from '../engines/launches.js'
import { engineInstallPaths, engineInstallRecipe } from './engineInstall.js'
import { launchHomeOf, launchPersonalHome } from './engineHomes.js'
import { projectsRoot } from './projectFolder.js'
import { spawnTied } from './tied.js'

type Json = Record<string, unknown>

/** How long the person has to sign in on the phone. */
export const ENGINE_SIGN_IN_MS = 15 * 60_000
const MAX_OUTPUT = 64 * 1024
const OPERATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/** The engines the phone signs in here. */
export type SignInEngine = 'claude' | 'codex'

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

/** [engine]'s executable here: where Harness installs it first (lib/engineInstall.ts), else the PATH's. */
export function engineExecutable(engine: SignInEngine, exists: (path: string) => boolean = executable): string {
  const recipe = engineInstallRecipe(engine)
  return (recipe ? engineInstallPaths(recipe, homedir()) : []).find(exists) ?? engine
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/** A login under way: its process, and the file its BROWSER writes the localhost page to. */
export interface EngineLogin {
  child: ChildProcess; page: () => string | null; done: () => void
  /** False for a login that prints no code page of its own (Codex's prints the localhost page itself): its page is the one
   *  BROWSER wrote, and nothing is typed into it. */
  codePages?: boolean
}

/** Who the person signs in to, for what is said to them. */
const ACCOUNT: Record<SignInEngine, string> = { claude: 'Claude', codex: 'ChatGPT' }
const NAME: Record<SignInEngine, string> = { claude: 'Claude Code', codex: 'Codex' }

interface Job {
  id: string; engine: SignInEngine; login: EngineLogin; output: string; result: Json; timer: NodeJS.Timeout
  codeUrl: string | null; codeAt: number
  /** The redirect's replay failed or timed out: the login's own exit says whether it took all the same. */
  undelivered?: boolean
}

const NOT_DELIVERED: Json = { error: 'NOT_DELIVERED', detail: 'The engine on this computer did not take the sign-in. Try again.' }

/** How long after its printed page the localhost one may still be on its way from BROWSER. */
const LOCAL_PAGE_WAIT_MS = 3_000

export class EngineSignIns {
  private job: Job | null = null
  constructor(
    private readonly start: (engine: SignInEngine) => EngineLogin = startEngineLogin,
    private readonly replay: (url: string) => Promise<number> = loopbackGet,
    private readonly now: () => number = Date.now,
    /** What finishing the engine's own first-run screens records, once it is signed in. */
    private readonly firstRun: (engine: SignInEngine) => void = finishFirstRun,
    /** The folder trust recorded for the harness's own folder, once it is signed in. */
    private readonly trust: (engine: SignInEngine, folder: string) => void = trustHarnessFolder,
  ) {}

  /** `engine_sign_in` {operationId, engine, callback?, code?, folder?}: starts the sign-in of [engine] under a new id;
   *  hands it the redirect the phone caught ([callback]) or the code Claude's page showed ([code]); answers how it goes:
   *  `starting`, `page` with its `url` (and `codeUrl`), `checking`, `done`, or an error. Once `done`, [folder], the
   *  harness's own folder, is trusted where Harness made it ([trustHarnessFolder]). */
  async read(input: Json): Promise<Json> {
    const answer = await this.answer(input)
    if (answer.state === 'done' && typeof input.folder === 'string') {
      // Never a reason to fail a sign-in that took: the engine then asks, as it would have.
      try { this.trust(input.engine as SignInEngine, input.folder) } catch { /* the engine asks */ }
    }
    return answer
  }

  private async answer(input: Json): Promise<Json> {
    if (input.engine !== 'claude' && input.engine !== 'codex') return { error: 'INVALID_REQUEST' }
    const engine: SignInEngine = input.engine
    // `firstRun`: the engine is signed in already, and a harness started before still waits on its first-run screens
    // (MSI, 2026-11-26: signed in from the phone, the app gone before it started the harness again). Recorded as
    // finishing them would, for the phone to start it again past them.
    if (input.firstRun === true) {
      try { this.firstRun(engine) } catch { return { error: 'FIRST_RUN_UNRECORDED', detail: 'Could not finish the setup on this computer.' } }
      return { ok: true, state: 'done' }
    }
    if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) return { error: 'INVALID_REQUEST' }
    let job = this.job
    if (job?.id !== input.operationId) {
      // A redirect or a code for a sign-in no longer here (stopped as this computer's connection dropped): a new one would
      // never take it, so the phone is told to open the sign-in page again.
      if (typeof input.callback === 'string' || typeof input.code === 'string') {
        return { error: 'SIGN_IN_EXPIRED', detail: `The sign-in stopped on this computer. Open ${ACCOUNT[engine]}'s page again.` }
      }
      this.stop()
      job = this.job = this.begin(input.operationId, engine)
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
        // A token exchange slower than the replay's wait still signs in: while the login runs, its exit decides. One
        // already gone did not take it.
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
   *  the code page alone. A login with no code page (Codex) has the localhost page only, once BROWSER wrote it. */
  private look(job: Job): void {
    if (job.result.state !== 'starting') return
    if (job.login.codePages === false) {
      const local = job.login.page()
      if (local && loopbackRedirectOf(local)) job.result = { ok: true, state: 'page', url: local, codeUrl: null }
      return
    }
    if (!job.codeUrl) return
    const local = job.login.page()
    if (!local && this.now() - job.codeAt < LOCAL_PAGE_WAIT_MS) return
    job.result = { ok: true, state: 'page', url: local && loopbackRedirectOf(local) ? local : job.codeUrl, codeUrl: job.codeUrl }
  }

  private begin(id: string, engine: SignInEngine): Job {
    const login = this.start(engine)
    const { child } = login
    const job: Job = { id, engine, login, output: '', codeUrl: null, codeAt: 0, result: { ok: true, state: 'starting' },
      timer: setTimeout(() => {
        child.kill('SIGKILL')
        job.result = { error: 'SIGN_IN_EXPIRED', detail: 'The sign-in took too long. Try again.' }
      }, ENGINE_SIGN_IN_MS) }
    const read = (chunk: Buffer): void => {
      if (job.output.length < MAX_OUTPUT) job.output += chunk.toString('utf8')
      if (job.codeUrl || login.codePages === false) return
      job.codeUrl = claudeSignInPageOf(job.output)
      if (job.codeUrl) job.codeAt = this.now()
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.stdin?.on('error', () => { /* it exited before reading the code */ })
    child.on('error', () => {
      clearTimeout(job.timer)
      login.done()
      job.result = { error: 'ENGINE_UNAVAILABLE', detail: `${NAME[engine]} is not installed on this computer.` }
    })
    child.on('close', (status) => {
      clearTimeout(job.timer)
      login.done()
      // Signed in, whatever the replay of its redirect said on the way.
      if (status === 0) {
        // The harness waiting on its first-run screens starts again past them (the phone restarts it).
        try { this.firstRun(engine) } catch { /* its screens ask, as before */ }
        job.result = { ok: true, state: 'done' }
        return
      }
      if (job.result.error) return
      if (job.undelivered) { job.result = NOT_DELIVERED; return }
      // Its last line says why, in its words ("Invalid code", …); never a page, which carries the sign-in's state.
      const last = job.output.replace(/https?:\/\/\S+/g, '').trim().split('\n').pop()?.trim().slice(0, 200)
      const who = engine === 'codex' ? 'Codex' : 'Claude'
      job.result = { error: 'SIGN_IN_FAILED', detail: last ? `${who} did not take it: ${last}` : `${who} did not take it. Try again.` }
    })
    return job
  }
}

/** `claude auth login --claudeai`, or `codex login`, its pages for the phone: BROWSER writes the one it is handed into a
 *  file of its own, and opens nothing; no display either, so nothing opens on this computer's screen. Claude Code's input
 *  stays open for a code; Codex prints the localhost page itself and asks for none. */
export function startEngineLogin(engine: SignInEngine): EngineLogin {
  const folder = mkdtempSync(join(tmpdir(), `harness-${engine}-sign-in-`))
  const page = join(folder, 'page'), browser = join(folder, 'browser')
  writeFileSync(browser, '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$HARNESS_SIGN_IN_PAGE"\n', { mode: 0o700 })
  const { WAYLAND_DISPLAY: _wayland, DISPLAY: _x11, ...env } = process.env
  const args = engine === 'codex' ? ['login'] : ['auth', 'login', '--claudeai']
  const child = spawnTied(engineExecutable(engine), args,
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, BROWSER: browser, HARNESS_SIGN_IN_PAGE: page } })
  return {
    child,
    page: () => { try { return readFileSync(page, 'utf8').trim() || null } catch { return null } },
    done: () => rmSync(folder, { recursive: true, force: true }),
    ...(engine === 'codex' ? { codePages: false } : {}),
  }
}

/** The program's own pages after its callback, followed as the phone's browser would. */
const FOLLOWED_PAGES = 3
/** The whole replay of a caught redirect, its pages included. */
const REPLAY_MS = 15_000

/** GET [url] on this machine: the login's own callback, which finishes it. A login that finishes on a page of its own,
 *  sent there by a redirect on the same port (Codex's callback answers 302 to its `/success`, and `codex login` ends only
 *  once a browser opens it), is followed there, as the phone's browser would have; nowhere else. The callback's status. */
async function loopbackGet(url: string): Promise<number> {
  // One wait for the whole replay, its redirects included, well inside the phone's 40 s for its answer: 20 s a page
  // let Codex's sign-in answer the phone after it gave up, which said "not reachable" over a sign-in that had taken
  // (MSI, 2026-11-26).
  const signal = AbortSignal.timeout(REPLAY_MS)
  const first = await fetch(url, { redirect: 'manual', signal })
  let answer = first, at = new URL(url)
  try {
    for (let page = 0; page < FOLLOWED_PAGES && answer.status >= 300 && answer.status < 400; page++) {
      const location = answer.headers.get('location')
      if (!location) break
      const next = new URL(location, at)
      if (next.protocol !== 'http:' || (next.hostname !== '127.0.0.1' && next.hostname !== 'localhost') || next.port !== at.port) break
      at = new URL(`http://127.0.0.1:${next.port}${next.pathname}${next.search}`)
      answer = await fetch(at, { redirect: 'manual', signal })
    }
  } catch {
    // The sign-in is the login's already; its exit says whether it took.
  }
  return first.status
}

/**
 * The folder trust a harness made on a computer where its engine had never run (MSI, 2026-11-26, after a factory reset):
 * its folder was trusted at its start only into a settings file already there (engines/kit/folderTrust.ts leaves a
 * missing one missing), so once signed in from Chat UI, Claude Code stopped at "Is this a project you trust?", which a
 * chat cannot show. Recorded here as its start would have, for the same folders only: one directly in the projects root,
 * where this daemon and the apps make the harnesses' folders, never one the person chose. The settings file is made
 * empty first when the engine has written none yet; the engine adds its own keys to it at its next start.
 */
export function trustHarnessFolder(engine: SignInEngine, folder: string, environment?: NodeJS.ProcessEnv): void {
  if (!isAbsolute(folder) || normalize(folder) !== folder || dirname(folder) !== projectsRoot(launchPersonalHome(environment))) return
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return
  const contract = launchContract(engine)?.trust
  if (!contract) return
  const file = join(launchHomeOf(contract.home, null, environment), contract.file)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try { writeFileSync(file, contract.format === 'json' ? '{}' : '', { mode: 0o600, flag: 'wx' }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  recordTrustIn(contract, file, folder)
}

/**
 * Claude Code's "Welcome to Claude Code … Choose the text style" and its notes, the first time it runs on a machine:
 * finishing them writes `hasCompletedOnboarding: true` to `.claude.json` (in CLAUDE_CONFIG_DIR, else the home folder),
 * with the text style picked kept as `theme`. Recorded here as finishing them would, with Claude Code's own first choice,
 * once the person signed in from Chat UI, which cannot show those screens. Only ever adds: a file that is not an object,
 * or a key the person set already, stays as it is. Codex has no such screens.
 */
export function finishFirstRun(engine: SignInEngine, environment?: NodeJS.ProcessEnv): void {
  if (engine !== 'claude') return
  const file = join(launchHomeOf({ variable: 'CLAUDE_CONFIG_DIR', otherwise: 'home' }, null, environment), '.claude.json')
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(file, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true }, null, 2), { mode: 0o600, flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  let settings: unknown
  try { settings = JSON.parse(readFileSync(file, 'utf8')) } catch { return }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return
  const own = settings as Json
  if (own.hasCompletedOnboarding !== undefined && own.theme !== undefined) return
  replaceConfigFile(file, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, ...own }, null, 2))
}
