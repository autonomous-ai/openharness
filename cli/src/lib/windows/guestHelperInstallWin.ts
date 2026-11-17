/**
 * The Windows side of guest sharing's one-time install (lib/guestHelperInstall.ts): the guest tree, the SYSTEM
 * setup task and the version file, all behind one UAC prompt (./elevated.ts). Loading this module is what pulls the
 * PowerShell script builders in, so lib/guestHelperInstall.ts
 * imports it only when the platform is Windows: the edge host's other services must not carry that code (and
 * its zod) in the process they share (src/leanEntry.spec.ts).
 */
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { ptyHostBinary } from '../ptyHost/launch.js'
import { managedNodePath } from '../nodeRuntime.js'
import { runGuestCommand, type GuestRunner } from '../guestRunner.js'
import { WHOAMI_USER_ARGS, windowsUserSid } from './whoami.js'
import { WINDOWS_GUEST_SETUP_VERSION, WINDOWS_GUEST_VERSION_FILE, buildWindowsGuestInstallScript,
  buildWindowsGuestProcessorScript } from './guestScript.js'
import { WINDOWS_GUEST_TASK } from './guestSetupClient.js'
import type { RunAdmin } from './elevated.js'
import type { GuestHelperInstallOptions, GuestHelperInstallResult, GuestHelperStatus, GuestHelperStatusDeps } from '../guestHelperInstall.js'

/** The Windows one-time install: the proven UAC runner, the guest tree/task, one prompt. */
export async function installWindowsGuestHelper(options: GuestHelperInstallOptions): Promise<GuestHelperInstallResult> {
  if (process.env.HARNESS_WINDOWS_GUESTS === '0') {
    return { ok: false, code: 'UNSUPPORTED', message: 'Sharing this computer is turned off on this build.' }
  }
  const runner = options.runner ?? runGuestCommand
  const owner = options.owner ?? userInfo().username
  const ownerHome = options.ownerHome ?? process.env.USERPROFILE ?? ''
  if (!/^[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+$/.test(ownerHome)) {
    return { ok: false, code: 'FAILED', message: 'Could not find the owner\'s Windows profile (%USERPROFILE%).' }
  }
  const who = await runner('whoami', WHOAMI_USER_ARGS, { timeoutMs: 30_000 })
  const ownerSid = who.code === 0 ? windowsUserSid(who.stdout) : null
  if (!ownerSid) return { ok: false, code: 'FAILED', message: 'Could not read this account\'s SID (whoami /user).' }
  const processor = buildWindowsGuestProcessorScript({ owner, ownerHome, ownerSid, version: String(WINDOWS_GUEST_SETUP_VERSION) })
  const script = buildWindowsGuestInstallScript({ owner, ownerHome, ownerSid, processor, version: String(WINDOWS_GUEST_SETUP_VERSION),
    ptySrc: ptyHostBinary(), nodeSrc: dirname(managedNodePath()) })
  const admin: RunAdmin = options.admin ?? (await import('./elevated.js')).windowsAdminRunner({ runner })
  const result = await admin(script, ownerSid)
  if (result.ok) return { ok: true }
  return { ok: false, code: result.code, message: result.message }
}

/** Whether sharing is on here: the version file this CLI writes, and the setup task registered to run it. */
export async function windowsGuestHelperStatus(deps: GuestHelperStatusDeps,
  read: (path: string) => string | null): Promise<GuestHelperStatus> {
  const installed = read(WINDOWS_GUEST_VERSION_FILE)
  if (installed === null) return { state: 'missing', version: null }
  const version = Number(installed.trim())
  if (!Number.isInteger(version) || version < WINDOWS_GUEST_SETUP_VERSION) {
    return { state: 'outdated', version: Number.isFinite(version) ? version : null }
  }
  const task = await (deps.runner ?? runGuestCommand)('schtasks.exe', ['/query', '/tn', WINDOWS_GUEST_TASK], { timeoutMs: 10_000 })
  return { state: task.code === 0 ? 'ready' : 'missing', version }
}
