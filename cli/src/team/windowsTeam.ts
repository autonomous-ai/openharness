/**
 * The Windows pieces of the team daemon (docs/superpowers/plans/2026-10-28-harness-team-account-windows.md, Task 4), as
 * pure functions and PowerShell queries the platform code runs: the privacy
 * probes, the pinned gh zips, and the account's SID from `whoami` (guest sharing reads it too).
 *
 * A query is a short script and its inputs, for lib/windows/powershell.ts `runPowershell`: the inputs travel in
 * environment variables, never in the script's text.
 */
import { closeSync, openSync, readdirSync } from 'node:fs'
import type { TeamConfig } from './config.js'
import type { GhBuild } from './gh.js'
import type { PrivacyItem } from './privacy.js'
import {
  SID, checkSid, checkWindowsPath,
} from './windowsLayout.js'

export interface PowershellQuery { script: string; inputs: Record<string, string> }

// ── The privacy check ─────────────────────────────────────────────────────────────────────────

/** The items a Windows check reports: ./privacy.ts lists credentials and edge with the others. */
export type WindowsPrivacyItem = PrivacyItem

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

/** `whoami /user /fo csv /nh`: one line, `"<DOMAIN\name>","<SID>"`, this process's own account. */
export const WHOAMI_USER_ARGS = ['/user', '/fo', 'csv', '/nh']

/** The account's SID in what `whoami /user /fo csv /nh` printed (its last column: a name may hold a comma), or null. */
export function windowsUserSid(stdout: string): string | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean)
  const sid = line ? csvFields(line).at(-1) ?? '' : ''
  try { return checkSid(sid) } catch { return null }
}

/** The SIDs (the third column) of what `whoami /groups /fo csv /nh` printed. */
export function windowsGroupSids(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => csvFields(line)[2] ?? '').filter((sid) => sid.startsWith('S-1-'))
}

// ── gh ────────────────────────────────────────────────────────────────────────────────────────

/** A Windows gh zip: it holds `bin\gh.exe` at its top, with no folder around it, so it is unpacked into `archiveRoot`. */
export type WindowsGhBuild = GhBuild & { binary: string }

const GH_VERSION = '2.103.3'
const windowsRelease = (arch: string, sha256: string, size: number): WindowsGhBuild => ({
  version: GH_VERSION, sha256, size, archiveRoot: `gh_${GH_VERSION}_windows_${arch}`, binary: 'bin\\gh.exe', format: 'zip',
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
