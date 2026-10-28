/**
 * The Windows pieces of the team daemon and of `harness team status` (docs/superpowers/plans/2026-10-28-harness-team-
 * account-windows.md, Tasks 4 and 5), as pure functions and PowerShell queries the platform code runs: the privacy
 * probes, the relay folder's ACL, the pinned gh zips, and what status asks Windows about the account and its task.
 *
 * A query is a short script and its inputs, for lib/windows/powershell.ts `runPowershell`: the inputs travel in
 * environment variables, never in the script's text.
 */
import { closeSync, openSync, readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import type { JobState } from './command.js'
import type { TeamConfig } from './config.js'
import type { GhBuild } from './gh.js'
import type { PrivacyItem } from './privacy.js'
import { SID, WINDOWS_TEAM_TASK_NAME, WINDOWS_TEAM_TASK_PATH, checkSid, checkWindowsPath, checkWindowsUser } from './windowsLayout.js'

export interface PowershellQuery { script: string; inputs: Record<string, string> }
/** What lib/windows/powershell.ts `runPowershell` answers. */
export interface QueryResult { status: number | null; stdout: string; stderr: string }

// ── The privacy check ─────────────────────────────────────────────────────────────────────────

export type WindowsPrivacyItem = PrivacyItem | 'credentials' | 'edge'

export interface WindowsProbe {
  item: WindowsPrivacyItem
  what: string
  kind: 'read' | 'list'
  paths: string[]
  /** A place that must be there to be refused: the sentinel setup writes, and the profile itself. */
  mustExist: boolean
}

/** The folders people keep projects in on Windows, Visual Studio's first. */
const PROJECT_FOLDERS = ['source\\repos', 'code', 'Code', 'Projects', 'src', 'Documents']

/**
 * What the check tries on Windows, in order. `what` names a place by %USERPROFILE%, never by the owner's absolute path
 * (which carries their account name).
 *
 * Every Windows account has "Bypass traverse checking", so it may open a path inside a folder it cannot list, and a
 * missing name answers ENOENT rather than access denied. A place that is not there is therefore skipped: its absence is
 * no leak of what is in it. The sentinel must be there (setup writes it) and refused, and the profile must refuse a
 * listing, which proves the ACL every file in the profile inherits keeps the team account out.
 */
export function windowsPrivacyProbes(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>): WindowsProbe[] {
  const home = config.ownerHome
  const at = (path: string) => `${home}\\${path}`
  return [
    { item: 'sentinel', what: 'the privacy sentinel in your profile', kind: 'read', paths: [config.sentinel], mustExist: true },
    { item: 'home-listing', what: 'the list of files in your profile', kind: 'list', paths: [home], mustExist: true },
    { item: 'gitconfig', what: '%USERPROFILE%\\.gitconfig', kind: 'read', paths: [at('.gitconfig')], mustExist: false },
    { item: 'ssh', what: '%USERPROFILE%\\.ssh', kind: 'list', paths: [at('.ssh')], mustExist: false },
    { item: 'projects', what: 'your project folders (%USERPROFILE%\\source\\repos and the like)', kind: 'list', paths: PROJECT_FOLDERS.map(at), mustExist: false },
    { item: 'credentials', what: 'your Windows Credential Manager folders', kind: 'list',
      paths: [at('AppData\\Roaming\\Microsoft\\Credentials'), at('AppData\\Local\\Microsoft\\Credentials')], mustExist: false },
    { item: 'chrome', what: 'Chrome\'s profile folder', kind: 'list', paths: [at('AppData\\Local\\Google\\Chrome\\User Data')], mustExist: false },
    { item: 'edge', what: 'Edge\'s profile folder', kind: 'list', paths: [at('AppData\\Local\\Microsoft\\Edge\\User Data')], mustExist: false },
  ]
}

export interface WindowsPrivacyDeps {
  open(path: string): void
  list(path: string): void
  /** Every group SID in this process's token, deny-only ones included (`windowsGroupSids` of `whoami /groups`). */
  groupSids(): string[]
  now(): number
}

export const realWindowsPrivacyFs = {
  open: (path: string) => closeSync(openSync(path, 'r')),
  list: (path: string) => { readdirSync(path) },
}

export type WindowsPrivacyResult =
  | { passed: true; checkedAt: number }
  | { passed: false; item: WindowsPrivacyItem; detail: string; checkedAt: number }

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** The Windows twin of ./privacy.ts `runPrivacyCheck`: each place must be refused with EPERM or EACCES. */
export function runWindowsPrivacyCheck(config: Pick<TeamConfig, 'ownerHome' | 'sentinel'>, deps: WindowsPrivacyDeps): WindowsPrivacyResult {
  const checkedAt = deps.now()
  for (const probe of windowsPrivacyProbes(config)) {
    for (const path of probe.paths) {
      try {
        if (probe.kind === 'read') deps.open(path)
        else deps.list(path)
      } catch (error) {
        const code = codeOf(error)
        if (code === 'EPERM' || code === 'EACCES') continue
        if (code === 'ENOENT' && !probe.mustExist) continue
        return { passed: false, item: probe.item, checkedAt,
          detail: `The team account was not refused ${probe.what} (it got ${code ?? 'an error'}), so your files are not private.` }
      }
      return { passed: false, item: probe.item, checkedAt, detail: `The team account could read ${probe.what}.` }
    }
  }
  if (deps.groupSids().includes(SID.administrators)) {
    return { passed: false, item: 'standard-user', checkedAt, detail: 'The team account is an administrator; it must be a standard user.' }
  }
  return { passed: true, checkedAt }
}

/** `whoami /groups /fo csv /nh`: every group of this process's token, a deny-only Administrators (UAC's filtered token)
 *  included, which .NET's WindowsIdentity.Groups leaves out. */
export const WHOAMI_GROUPS_ARGS = ['/groups', '/fo', 'csv', '/nh']

/** The fields of one CSV line, quotes taken off (`""` inside a quoted field is one quote). */
function csvFields(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i++ } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { fields.push(field); field = '' } else field += char
  }
  fields.push(field)
  return fields
}

/** The SIDs (the third column) of what `whoami /groups /fo csv /nh` printed. */
export function windowsGroupSids(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => csvFields(line)[2] ?? '').filter((sid) => sid.startsWith('S-1-'))
}

// ── The relay folder ──────────────────────────────────────────────────────────────────────────

const icacls = (env: NodeJS.ProcessEnv) => win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'icacls.exe')
const principal = (who: string) => who.startsWith('S-1-') ? `*${checkSid(who)}` : checkWindowsUser(who, 'team account')

/**
 * What the owner's daemon runs on the relay folder, as an argument array, never a shell string: inheritance off, the
 * owner and SYSTEM full, the team account read, and nobody else. Administrators keep full control: an administrator
 * can take any file anyway, and it lets the elevated `harness team remove` delete the folder. `/grant:r` replaces
 * these principals' entries rather than adding to them, so each publish sets the same ACL again.
 */
export function windowsRelayAclCommand(input: { dir: string; ownerSid: string; team: string }, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const dir = checkWindowsPath(input.dir, 'relay folder')
  const owner = `*${checkSid(input.ownerSid, 'owner account')}`
  return {
    command: icacls(env),
    args: [dir, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`, `${principal(input.team)}:(OI)(CI)R`, `*${SID.system}:(OI)(CI)F`,
      `*${SID.administrators}:(OI)(CI)F`, '/q'],
  }
}

/** A path's owner as a SID: the team side refuses a relay folder or file another account owns (Node's lstat has no
 *  owner on Windows). */
export function windowsOwnerSidScript(path: string): PowershellQuery {
  return {
    script: '(Get-Acl -LiteralPath $env:HARNESS_PATH).GetOwner([Security.Principal.SecurityIdentifier]).Value',
    inputs: { HARNESS_PATH: checkWindowsPath(path, 'path') },
  }
}

// ── gh ────────────────────────────────────────────────────────────────────────────────────────

/** A Windows gh zip: it holds `bin\gh.exe` at its top, with no folder around it, so it is unpacked into `archiveRoot`. */
export type WindowsGhBuild = GhBuild & { binary: string }

const GH_VERSION = '2.103.3'
const windowsRelease = (arch: string, sha256: string, size: number): WindowsGhBuild => ({
  version: GH_VERSION, sha256, size, archiveRoot: `gh_${GH_VERSION}_windows_${arch}`, binary: 'bin\\gh.exe',
  url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_windows_${arch}.zip`,
})
/** GitHub's Windows builds of gh, by `process.arch`, from the release's gh_2.103.3_checksums.txt and its asset sizes. */
export const WINDOWS_GH_BUILDS: Readonly<Record<string, WindowsGhBuild>> = {
  x64: windowsRelease('amd64', '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0', 15_197_187),
  arm64: windowsRelease('arm64', '197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484', 13_637_549),
}

/** Unpacks a zip with Windows PowerShell's own Expand-Archive (there is no ditto). */
export function windowsUnzipScript(archive: string, into: string): PowershellQuery {
  return {
    script: 'Expand-Archive -LiteralPath $env:HARNESS_ARCHIVE -DestinationPath $env:HARNESS_INTO -Force',
    inputs: { HARNESS_ARCHIVE: checkWindowsPath(archive, 'gh archive'), HARNESS_INTO: checkWindowsPath(into, 'gh folder') },
  }
}

// ── harness team status ───────────────────────────────────────────────────────────────────────

/** Whether a local account by that name exists; any account may ask. Prints `yes` or `no`. */
export function windowsAccountExistsScript(user: string): PowershellQuery {
  return {
    script: "if (Get-LocalUser -Name $env:HARNESS_TEAM_USER -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }",
    inputs: { HARNESS_TEAM_USER: checkWindowsUser(user, 'team account') },
  }
}

export const parseWindowsAccountExists = (result: QueryResult): boolean => result.status === 0 && result.stdout.trim() === 'yes'

/**
 * The team task as Task Scheduler has it, one JSON line: its state (`Ready`, `Running`, `Disabled`), its last result,
 * and the process of a running instance, which only Task Scheduler's COM interface gives. Setup's task lets every
 * signed-in account read it (./windowsScript.ts `teamTaskXml`), so a standard owner sees it too.
 */
export function windowsJobStateScript(): PowershellQuery {
  return {
    script: [
      '$task = Get-ScheduledTask -TaskPath $env:HARNESS_TASK_PATH -TaskName $env:HARNESS_TASK_NAME -ErrorAction SilentlyContinue',
      "if (-not $task) { '{\"loaded\":false}'; exit 0 }",
      '$info = Get-ScheduledTaskInfo -TaskPath $env:HARNESS_TASK_PATH -TaskName $env:HARNESS_TASK_NAME',
      '$enginePid = $null',
      'try {',
      '  $scheduler = New-Object -ComObject Schedule.Service',
      '  $scheduler.Connect()',
      "  foreach ($instance in @($scheduler.GetFolder($env:HARNESS_TASK_PATH.TrimEnd('\\')).GetTask($env:HARNESS_TASK_NAME).GetInstances(0))) { $enginePid = [int]$instance.EnginePID }",
      '} catch { }',
      '[pscustomobject]@{ loaded = $true; state = [string]$task.State; pid = $enginePid; lastResult = $info.LastTaskResult } | ConvertTo-Json -Compress',
    ].join('\n'),
    inputs: { HARNESS_TASK_PATH: WINDOWS_TEAM_TASK_PATH, HARNESS_TASK_NAME: WINDOWS_TEAM_TASK_NAME },
  }
}

export function parseWindowsJobState(result: QueryResult): JobState {
  const none: JobState = { loaded: false, pid: null, state: null }
  if (result.status !== 0) return none
  let value: unknown
  try { value = JSON.parse(result.stdout.trim()) } catch { return none }
  if (!value || typeof value !== 'object' || (value as { loaded?: unknown }).loaded !== true) return none
  const { state, pid } = value as { state?: unknown; pid?: unknown }
  return { loaded: true, pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null, state: typeof state === 'string' ? state : null }
}
