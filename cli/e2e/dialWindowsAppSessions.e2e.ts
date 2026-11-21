/**
 * The Claude and ChatGPT apps' sessions on the dial on Windows, and the ChatGPT follow
 * (docs/plans/2026-11-20-dial-app-sessions-win-linux-design.md), on a real daemon from the run's bundle, sealed in a
 * throwaway profile whose name needs escaping (harness/windowsDaemon.ts), with a stand-in dial that holds one app's ring:
 * - the Claude app's stores in both its roots, the MSIX app's private copy and `%APPDATA%`, are listed idle, a session in
 *   both once with the first root's title, and an archive takes its row away;
 * - the ChatGPT app's Codex home lists its threads in the sidebar's order, and an archive takes its row away;
 * - the title of ChatGPT's window on the real `harness hardware watch --json` turns the dial to the thread of that name,
 *   and a name two threads share turns it nowhere;
 * - a tap on a row opens it by the app's link: the app's program starts with that row's link and its window comes, or,
 *   with no app for the link's scheme, the opener's fallback line;
 * - the whole log names no title, folder or id of them.
 *
 * The stores are fixtures in the sealed profile (src/testing/claudeAppFixture.ts, codexAppFixture.ts), and the ChatGPT
 * app a file in the root's stand-in for its Store package (`HARNESS_APPLICATIONS_DIR`), so no store of the account is
 * read. The taps reach the apps of the account the run is started as: run it as the VM's test user in that user's
 * console session (the plan's Verification 4), where the apps start on its desktop and the case ends them. The case's
 * own reads of the apps' processes are read-only PowerShell calls from System32, never the daemon's.
 * Windows only: the Linux and macOS e2e runs find this file and skip it.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, win32 } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { chatGptPlaces, claudeStoreRoots } from '../src/cable/hosts/appPlaces.js'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { ACCOUNT, ORG, claudeAppFixture, type FixtureSession } from '../src/testing/claudeAppFixture.js'
import { NEVER_READ, codexAppFixture, type CodexAppFixture } from '../src/testing/codexAppFixture.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { startWindowsDaemon, type WindowsDaemon } from './harness/windowsDaemon.js'

const exec = promisify(execFile)

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** Every line the sources say (the plan's Global Constraints): fixed words and counts, never a title, folder, path or id. */
const CLAUDE_LINE = /^\[claude-app\] (watch · (on|none)|listed · \d+ sessions|read · \d+ ms · \d+ parsed · \d+ skipped|over · \d+)$/
const CODEX_LINE = /^\[codex-app\] (watch · (on|none)|listed · \d+ threads · \d+ in projects|read · \d+ ms · \d+ rows · \d+ skipped|read · failed · [A-Za-z][A-Za-z0-9_$]*( [A-Z][A-Z0-9_]+)?)$/
const THREAD_LINE = /^\[device\] thread · (moved|skipped · (echo|not in front|no match|ambiguous|no tile))$/
/** How long a tap's program has to start, then to show its window, then to end once it is ended. */
const STARTED_MS = 20_000
const WINDOW_MS = 30_000
const ENDED_MS = 30_000

const now = Date.now()
const claudeSession = (title: string, folder: string, at: number): FixtureSession =>
  ({ localId: `local_${randomUUID()}`, cliSessionId: randomUUID(), title, cwd: `C:\\work\\${folder}`, lastActivityAt: at })
/** One session in each root alone, and one in both whose MSIX copy, read first, names it. */
const msixOnly = claudeSession('Fixture Msix', 'e2e-msix', now - 1_000)
const shared = claudeSession('Fixture Shared', 'e2e-shared', now - 2_000)
const roamingShared = { ...shared, title: 'Fixture Shared Roaming' }
const roamingOnly = claudeSession('Fixture Roaming', 'e2e-roaming', now - 3_000)
const claudeSessions = [msixOnly, shared, roamingShared, roamingOnly]
const claudeLink = (session: FixtureSession): string => `claude://code/continue?session=${session.localId}`
const claudeAgent = (session: FixtureSession): string => observedAgentId('claude', session.cliSessionId)

/** deviceCodexAppThreads.e2e.ts's threads: two in a project, three Recent, one archived, one of `codex exec`. The named
 *  thread is the second row, not the first: the dial lands on the first, and a follow to the agent shown moves nothing. */
const [p1, p2, r1, r2, r3, a1, e1] = Array.from({ length: 7 }, () => randomUUID())
const threads = [p1, p2, r1, r2, r3, a1, e1]
const folder = (id: string): string => `C:\\work\\e2e-${id.slice(0, 8)}`
const codexLink = (id: string): string => `codex://threads/${id}`
const codexAgent = (id: string): string => observedAgentId('codex', id)

const inside = (root: string, path: string): boolean => isAbsolute(path) && !relative(root, path).startsWith('..')

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`. */
function rosters(dial: FakeDial, since = 0): DialMessage[][] {
  const out: DialMessage[][] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push(rows); rows = null }
  }
  return out
}
/** The list the dial shows now, once its rows are [ids] in that order. */
const showing = (dial: FakeDial, what: string, ids: readonly string[], ms = 45_000): Promise<DialMessage[]> =>
  until(what, () => {
    const last = rosters(dial).at(-1)
    return last && JSON.stringify(last.map((row) => row.id)) === JSON.stringify(ids) ? last : null
  }, ms, 50)
/** The daemon's lines: harness.log on Windows ends each with CRLF. */
const lines = (d: WindowsDaemon): string[] => d.log().split(/\r?\n/)
const said = (d: WindowsDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => lines(d).some((logged) => logged.endsWith(line)), 30_000, 50)
const linesOf = (d: WindowsDaemon, tag: string): string[] =>
  lines(d).filter((line) => line.includes(tag)).map((line) => line.slice(line.indexOf(tag)))

/** Runs [script] in System32's PowerShell and answers what it printed. The script goes encoded, so no quoting rule
 *  between Node and PowerShell touches it. */
async function powershell(script: string[]): Promise<string> {
  const program = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(script.join('\n'), 'utf16le').toString('base64')
  const { stdout } = await exec(program, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30_000 })
  return stdout
}

interface Running { pid: number; commandLine: string; window: boolean }

/** The processes of [program] in this console session, each with its command line and whether it has a window yet. */
async function running(program: string): Promise<Running[]> {
  return JSON.parse(await powershell([
    '$session = (Get-Process -Id $PID).SessionId',
    `$found = @(Get-CimInstance Win32_Process -Filter "Name='${program}' AND SessionId=$session" | ForEach-Object {`,
    '  $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue',
    '  [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine; window = [bool]($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) }',
    '})',
    'ConvertTo-Json -InputObject $found -Compress',
  ])) as Running[]
}

/**
 * Whether Windows has a program for links of [scheme], asked as `harness-pty open-link` asks before it opens one
 * (pty/src/raise.rs `handled`): `AssocQueryStringW` with `ASSOCF_IS_PROTOCOL` (0x1000) for `ASSOCSTR_PROGID` (20), which
 * a packaged handler answers too, where its command and executable give `ERROR_NO_ASSOCIATION`
 * (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 37 §3). With no buffer, a registered one answers S_FALSE.
 */
async function handled(scheme: string): Promise<boolean> {
  // [NullString]: PowerShell hands a .NET string parameter "" for $null, and the call takes no extra.
  const answer = await powershell([
    "Add-Type -Namespace Harness -Name Links -MemberDefinition '[DllImport(\"shlwapi.dll\", CharSet = CharSet.Unicode)] public static extern int AssocQueryStringW(uint flags, int str, string assoc, string extra, System.Text.StringBuilder result, ref uint length);'",
    '$length = [uint32]0',
    `[Harness.Links]::AssocQueryStringW(0x1000, 20, '${scheme}', [NullString]::Value, $null, [ref]$length) -ge 0`,
  ])
  return answer.trim() === 'True'
}

describe.runIf(process.platform === 'win32')("the Claude and ChatGPT apps' sessions on the dial on Windows", () => {
  let d: WindowsDaemon
  let claudeRoots: string[] = []
  let msixStore: ReturnType<typeof claudeAppFixture>
  let roamingStore: ReturnType<typeof claudeAppFixture>
  let codex: CodexAppFixture
  const children: ChildProcess[] = []

  beforeAll(async () => {
    d = await startWindowsDaemon({
      capabilities: FILTER,
      prepare: ({ profile, applications }) => {
        // The sealed profile's LOCALAPPDATA and APPDATA are its defaults (windowsDaemon.ts), so these are the roots its
        // daemon reads; the first case checks it against the daemon's own environment.
        claudeRoots = claudeStoreRoots('win32', {}, profile).map(({ root }) => root)
        const codexHome = join(profile, '.codex')
        const chatGpt = chatGptPlaces('win32', applications, profile)
        for (const path of [...claudeRoots, codexHome]) expect(inside(profile, path), path).toBe(true)
        expect(chatGpt).toHaveLength(1)
        expect(inside(applications!, chatGpt[0]), chatGpt[0]).toBe(true)

        msixStore = claudeAppFixture(claudeRoots[0])
        roamingStore = claudeAppFixture(claudeRoots[1])
        for (const session of [msixOnly, shared]) msixStore.write(session, { mtime: session.lastActivityAt as number })
        for (const session of [roamingShared, roamingOnly]) roamingStore.write(session, { mtime: session.lastActivityAt as number })

        codex = codexAppFixture(codexHome)
        codex.threads([
          { id: p1, cwd: folder(p1), recencyAtMs: now - 5_000 },
          { id: p2, cwd: folder(p2), recencyAtMs: now - 6_000 },
          { id: r1, cwd: folder(r1), recencyAtMs: now - 1_000 },
          { id: r2, cwd: folder(r2), recencyAtMs: now - 2_000 },
          { id: r3, cwd: folder(r3), recencyAtMs: now - 3_000 },
          { id: a1, cwd: folder(a1), recencyAtMs: now, archived: 1 },
          { id: e1, cwd: folder(e1), recencyAtMs: now, source: 'exec' },
        ])
        const local = { projectKind: 'local', projectId: 'P' }
        codex.state({ projectOrder: ['P'], assignments: { [p1]: local, [p2]: local } })
        codex.name(p2, 'Fixture Named')
        codex.name(r1, 'Twice')
        codex.name(r3, 'Twice')

        mkdirSync(win32.dirname(chatGpt[0]), { recursive: true })
        writeFileSync(chatGpt[0], '')
      },
    })
    await d.dial.greet(90_000)
  })
  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  afterAll(async () => { await d?.close() })
  const showLog = (): void => onTestFailed(() => { console.log(`---- daemon log\n${lines(d).slice(-200).join('\n')}`) })

  /** The dial's page of [app], picked as a person picks it, once the dial has been told the app has rows. */
  const pick = async (app: string): Promise<void> => {
    await until(`the ${app} app among the dial's apps`, () => {
      const apps = d.dial.messages.filter((m) => m.t === 'apps').at(-1)?.apps as Array<{ id: string }> | undefined
      return apps?.some((entry) => entry.id === app)
    }, 45_000, 50)
    d.dial.send({ t: 'app.pick', app })
  }

  /**
   * A tap on [agentId], whose app's [program] must start with [link] and show its window, or the opener's fallback line
   * for [adapter] when no app takes the link's scheme. No process of [program] may run before: a running app takes the
   * link in its first process, and this check would not see it. Every process of it the tap started is ended after, so
   * nothing of the app holds a file of the root when `close` removes it.
   */
  const tap = async (tapped: { app: string; adapter: string; program: string; agentId: string; link: string; others: string[] }): Promise<void> => {
    const { app, adapter, program, agentId, link, others } = tapped
    const before = await running(program)
    if (before.length) {
      throw new Error(`close the ${app} app in this session first: ${program} runs (pid ${before.map((p) => p.pid).join(', ')})`)
    }
    const since = d.log().length
    const fallback = `[device] open · ${adapter} · fallback`
    const wrong = new Set<number>()
    const look = async (): Promise<Running[]> => {
      const found = await running(program)
      for (const p of found) if (others.some((other) => p.commandLine.includes(other))) wrong.add(p.pid)
      return found
    }
    d.dial.send({ t: 'agent.open', agentId })
    try {
      const outcome = await until(`${program} started with the row's link, or the fallback`, async () => {
        if (d.log().slice(since).includes(fallback)) return 'fallback'
        return (await look()).some((p) => p.commandLine.includes(link)) ? 'opened' : null
      }, STARTED_MS, 250)
      if (outcome === 'fallback') {
        // The fallback is right only when no app takes the scheme: with one registered, the link should have opened it.
        const scheme = link.slice(0, link.indexOf(':'))
        expect(await handled(scheme), `the fallback, while a program is registered for ${scheme}:// links`).toBe(false)
        console.log('tap: fallback · no handler')
        return
      }
      await until(`the window of the ${program} the link started`, async () =>
        (await look()).some((p) => p.commandLine.includes(link) && p.window), WINDOW_MS, 250)
      expect([...wrong], `a ${program} holds another row's link`).toEqual([])
      console.log(`tap: ${program} · the row's link · window shown`)
    } finally {
      const taskkill = win32.join(process.env.SystemRoot!, 'System32', 'taskkill.exe')
      for (const p of await running(program)) {
        // One already gone with its parent's tree is no failure.
        await exec(taskkill, ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }).catch(() => null)
      }
      await until(`every ${program} the tap started to end`, async () => (await running(program)).length === 0, ENDED_MS, 250)
    }
  }

  it("the Claude app's sessions in both its roots are listed idle, once each, and an archive takes its row away", async () => {
    showLog()
    // The roots written are the ones the daemon's own environment names, inside its throwaway root.
    expect(claudeStoreRoots('win32', d.env, d.env.USERPROFILE!).map(({ root }) => root)).toEqual(claudeRoots)
    for (const root of claudeRoots) expect(inside(d.root, root), root).toBe(true)

    await pick('claude')
    const rows = await showing(d.dial, 'the three sessions', [msixOnly, shared, roamingOnly].map(claudeAgent))
    expect(rows).toEqual([msixOnly, shared, roamingOnly].map((session) =>
      expect.objectContaining({ id: claudeAgent(session), name: session.title, engine: 'claude', host: 'claude', caps: 'sf' })))
    const ids = new Set(rows.map((row) => row.id))
    expect(d.dial.messages.filter((m) => (m.t === 'turn.started' || m.t === 'turn.done') && ids.has(String(m.agentId)))).toEqual([])

    roamingStore.write({ ...roamingOnly, isArchived: true }, { mtime: Date.now() })
    await said(d, '[claude-app] listed · 2 sessions')
    await showing(d.dial, 'the archived session gone', [msixOnly, shared].map(claudeAgent))
  })

  it("the ChatGPT app's threads are listed idle in the sidebar's order, and an archive takes its row away", async () => {
    showLog()
    await pick('codex')
    const rows = await showing(d.dial, 'the five threads', [p1, p2, r1, r2, r3].map(codexAgent))
    const names: Record<string, string> = { [p2]: 'Fixture Named', [r1]: 'Twice', [r3]: 'Twice' }
    expect(rows).toEqual([p1, p2, r1, r2, r3].map((id) =>
      expect.objectContaining({ id: codexAgent(id), name: names[id] ?? win32.basename(folder(id)), host: 'codex', caps: 'sf' })))
    const ids = new Set(rows.map((row) => row.id))
    expect(d.dial.messages.filter((m) => (m.t === 'turn.started' || m.t === 'turn.done') && ids.has(String(m.agentId)))).toEqual([])

    codex.update(r2, { archived: 1 })
    await said(d, '[codex-app] listed · 4 threads · 2 in projects')
    await showing(d.dial, 'the archived thread gone', [p1, p2, r1, r3].map(codexAgent))
  })

  // Before the taps: a report within two seconds of the dial's own move to a thread is taken for its echo.
  it("the dial follows the thread named by ChatGPT's window, from the watch's stdin, and no thread of a shared name", async () => {
    showLog()
    // The watch as Harness Device runs it, under the daemon's environment only: this daemon's data folder and the devices'
    // pipe recorded in it, never the account's daemon's.
    expect(d.env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    const watch = spawn(process.execPath, [process.env.E2E_BUNDLE_PATH!, 'hardware', 'watch', '--json'],
      { cwd: CLI_ROOT, env: d.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    children.push(watch)
    const write = (value: unknown): void => { watch.stdin!.write(`${JSON.stringify(value)}\n`) }
    write({ front: 'ChatGPT.exe' })

    // The report waits for ChatGPT's settle by itself.
    let since = d.dial.messages.length
    write({ thread: 'Fixture Named' })
    await said(d, '[device] thread · moved')
    await d.dial.next((m) => m.t === 'focus' && m.agentId === codexAgent(p2), 30_000, "the named thread's focus", since)

    since = d.dial.messages.length
    write({ thread: 'Twice' })
    await said(d, '[device] thread · skipped · ambiguous')
    expect(d.dial.messages.slice(since).filter((m) => m.t === 'focus' && (m.agentId === codexAgent(r1) || m.agentId === codexAgent(r3)))).toEqual([])
  })

  it('a tap on a Claude row opens that session in the Claude app by its link', async () => {
    showLog()
    await pick('claude')
    await showing(d.dial, 'the Claude page', [msixOnly, shared].map(claudeAgent))
    await tap({ app: 'Claude', adapter: 'claude', program: 'claude.exe', agentId: claudeAgent(msixOnly), link: claudeLink(msixOnly),
      others: [shared, roamingOnly].map(claudeLink) })
  })

  it('a tap on a ChatGPT row opens that thread in the ChatGPT app by its link', async () => {
    showLog()
    await pick('codex')
    await showing(d.dial, 'the ChatGPT page', [p1, p2, r1, r3].map(codexAgent))
    await tap({ app: 'ChatGPT', adapter: 'codex', program: 'ChatGPT.exe', agentId: codexAgent(r1), link: codexLink(r1),
      others: [p1, p2, r2, r3].map(codexLink) })
  })

  it('the whole log names no title, folder or id of the sessions and threads', () => {
    showLog()
    for (const line of linesOf(d, '[claude-app]')) expect(line).toMatch(CLAUDE_LINE)
    for (const line of linesOf(d, '[codex-app]')) expect(line).toMatch(CODEX_LINE)
    for (const line of linesOf(d, '[device] thread')) expect(line).toMatch(THREAD_LINE)
    const log = d.log()
    const claudeSecrets = claudeSessions.flatMap((session) =>
      [String(session.title), session.cwd, win32.basename(session.cwd), session.localId, session.cliSessionId])
    const codexSecrets = [...threads, ...threads.map(folder), ...threads.map((id) => win32.basename(folder(id)))]
    for (const secret of [ACCOUNT, ORG, NEVER_READ, 'Fixture Named', 'Twice', ...claudeSecrets, ...codexSecrets]) {
      expect(log).not.toContain(secret)
    }
  })
})
