/**
 * The owner's side of the Windows guest setup task (docs/superpowers/specs/2026-11-05-windows-guests-design.md). One
 * request file with an unguessable id, the SYSTEM task started without elevation, one answer file, and the request
 * deleted. Requests are serialized: the task's `MultipleInstances=IgnoreNew` would otherwise leave the second request
 * unanswered while the first is still running.
 *
 * Nothing here trusts an answer by itself: the same [parseGuestSetupRequest] the task uses checks the request, and
 * [parseGuestSetupAnswer] checks the id, the guest's SID-derived name and the exact profile Windows was asked for.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { canonicalGuestEmail, guestAnswerFile, guestRequestFile, newGuestRequestId, parseGuestSetupAnswer,
  parseGuestSetupRequest, WINDOWS_GUEST_ANSWERS, WINDOWS_GUEST_REQUESTS, type GuestSetupRequest } from './guestRequests.js'
import type { GuestSharedFolder } from './guestShare.js'

export const WINDOWS_GUEST_TASK_PATH = '\\Harness\\'
export const WINDOWS_GUEST_TASK_NAME = 'Harness Guests Setup'
export const WINDOWS_GUEST_TASK = `${WINDOWS_GUEST_TASK_PATH}${WINDOWS_GUEST_TASK_NAME}`

export interface WindowsGuestAccount { user: string; home: string; workspace: string }

export interface GuestSetupFs {
  mkdir(path: string): void
  write(path: string, text: string): void
  rename(from: string, to: string): void
  read(path: string): string
  exists(path: string): boolean
  unlink(path: string): void
}

export interface GuestSetupClientOptions {
  ownerHome: string
  fs?: GuestSetupFs
  /** Starts `\Harness\Harness Guests Setup` as the owner; no elevation (its task SD grants the owner). */
  startTask?: () => Promise<void>
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  fixedDrives?: ReadonlySet<string>
  isReparse?: (path: string) => boolean
}

export type GuestSetupErrorCode = 'REQUEST_FAILED' | 'TASK_FAILED' | 'TIMEOUT' | 'INVALID_ANSWER'

export class GuestSetupError extends Error {
  constructor(readonly code: GuestSetupErrorCode, message: string) {
    super(message)
    this.name = 'GuestSetupError'
  }
}

const realFs: GuestSetupFs = {
  mkdir: (path) => { mkdirSync(path, { recursive: true }) },
  write: (path, text) => { writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' }) },
  rename: (from, to) => { renameSync(from, to) },
  read: (path) => readFileSync(path, 'utf8'),
  exists: (path) => existsSync(path),
  unlink: (path) => { try { unlinkSync(path) } catch { /* already gone */ } },
}

/** Starts the task through `schtasks.exe`; the caller's task security descriptor allows it unelevated. */
export function startGuestSetupTask(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('schtasks.exe', ['/run', '/tn', WINDOWS_GUEST_TASK], { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => reject(new GuestSetupError('TASK_FAILED', `Could not start the guest setup task: ${error.message}`)))
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new GuestSetupError('TASK_FAILED', `The guest setup task could not be started (schtasks exit ${code}).`)))
  })
}

export interface GuestSetupClient {
  ensureGuest(email: string): Promise<WindowsGuestAccount>
  /** The owner's whole folder set for this guest; an empty list removes every shared folder. */
  setFolders(user: string, folders: readonly GuestSharedFolder[]): Promise<void>
  removeGuest(user: string): Promise<void>
}

export function createGuestSetupClient(options: GuestSetupClientOptions): GuestSetupClient {
  const fs = options.fs ?? realFs
  const startTask = options.startTask ?? startGuestSetupTask
  const timeoutMs = options.timeoutMs ?? 180_000
  const pollMs = options.pollMs ?? 500
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const parseOptions = {
    ownerHome: options.ownerHome,
    ...(options.fixedDrives ? { fixedDrives: options.fixedDrives } : {}),
    ...(options.isReparse ? { isReparse: options.isReparse } : {}),
  }
  const emails = new Map<string, Promise<WindowsGuestAccount>>()
  // One request at a time: a second start while the task runs is ignored by its `IgnoreNew` policy and never answered.
  let queue: Promise<unknown> = Promise.resolve()

  const send = (request: GuestSetupRequest, timeout: number): Promise<ReturnType<typeof parseGuestSetupAnswer>> => {
    const run = async () => {
      const requestFile = guestRequestFile(request.id)
      const answerFile = guestAnswerFile(request.id)
      const temporary = `${requestFile}.tmp`
      fs.mkdir(WINDOWS_GUEST_REQUESTS)
      fs.mkdir(WINDOWS_GUEST_ANSWERS)
      try {
        fs.write(temporary, `${JSON.stringify(request)}\n`)
        fs.rename(temporary, requestFile)
      } catch (error) {
        fs.unlink(temporary)
        throw new GuestSetupError('REQUEST_FAILED', `Could not write the guest setup request: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        await startTask()
      } catch (error) {
        fs.unlink(requestFile)
        throw error instanceof GuestSetupError ? error
          : new GuestSetupError('TASK_FAILED', error instanceof Error ? error.message : 'The guest setup task failed to start.')
      }
      const deadline = now() + timeout
      while (now() < deadline) {
        if (fs.exists(answerFile)) {
          let source: string
          try {
            source = fs.read(answerFile)
          } catch (error) {
            fs.unlink(requestFile)
            throw new GuestSetupError('INVALID_ANSWER', `Could not read the guest setup answer: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            fs.unlink(answerFile)
          }
          fs.unlink(requestFile)
          try {
            return parseGuestSetupAnswer(source, request)
          } catch (error) {
            throw new GuestSetupError('INVALID_ANSWER', error instanceof Error ? error.message : 'The guest setup answer is not usable.')
          }
        }
        await sleep(pollMs)
      }
      fs.unlink(requestFile)
      throw new GuestSetupError('TIMEOUT', 'The guest setup task did not answer in time. Check the task and try again.')
    }
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
  }

  const expectOk = (answer: ReturnType<typeof parseGuestSetupAnswer>): void => {
    if (!answer.ok) throw new GuestSetupError('REQUEST_FAILED', answer.detail)
  }

  return {
    ensureGuest(email) {
      const address = canonicalGuestEmail(email)
      const known = emails.get(address)
      if (known) return known
      const pending = (async () => {
        const request = parseGuestSetupRequest(JSON.stringify({ id: newGuestRequestId(), op: 'ensure', email: address }), parseOptions)
        const answer = await send(request, timeoutMs)
        expectOk(answer)
        if (!answer.ok) throw new GuestSetupError('REQUEST_FAILED', answer.detail)
        return { user: answer.user, home: answer.home, workspace: answer.workspace }
      })()
      emails.set(address, pending)
      pending.catch(() => { if (emails.get(address) === pending) emails.delete(address) })
      return pending
    },
    async setFolders(user, folders) {
      const request = parseGuestSetupRequest(JSON.stringify({
        id: newGuestRequestId(), op: 'share', user,
        folders: folders.map((folder) => ({ path: folder.path, write: folder.write })),
      }), parseOptions)
      expectOk(await send(request, Math.max(timeoutMs, 10 * 60_000)))
    },
    async removeGuest(user) {
      const request = parseGuestSetupRequest(JSON.stringify({ id: newGuestRequestId(), op: 'remove', user }), parseOptions)
      expectOk(await send(request, timeoutMs))
    },
  }
}
