import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { windowsDialWatch } from './windowsSerial.js'

/** A daemon left running by Fast User Switching must release the physical USB
 * device. macOS hides other users' descriptors from unprivileged lsof, so its
 * empty result cannot establish that the current desktop owns the port. Windows
 * has the same switch: harness-serial's watch says whether this daemon's session
 * is the console session (WTSGetActiveConsoleSessionId). Linux asks logind which
 * user holds seat0's active session through `loginctl`, its public reader: the
 * seat file under /run/systemd/seats says not to parse it. The fleet asks every
 * 2 s, so the answer is the last reading, taken at most every 8 s and only
 * while a dial is on USB (`dialHere`): an empty desk starts no process. */
export function isUsbConsoleUser({
  dialHere = true,
  platform = process.platform,
  uid = process.getuid?.(),
  consoleUid = () => statSync('/dev/console').uid,
  windowsConsole = () => windowsDialWatch().console(),
  linuxSeat = realLinuxSeat,
}: {
  dialHere?: boolean
  platform?: NodeJS.Platform
  uid?: number
  consoleUid?: () => number
  windowsConsole?: () => boolean
  linuxSeat?: (dialHere: boolean) => boolean
} = {}): boolean {
  if (platform === 'win32') return windowsConsole()
  if (platform === 'linux') return linuxSeat(dialHere)
  if (platform !== 'darwin') return true
  try { return uid !== undefined && uid !== 0 && uid === consoleUid() }
  catch { return false }
}

export interface SeatDeps {
  /** Rejects when the program cannot be started. */
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }>
  now(): number
  uid: number | undefined
}

const SEAT_EVERY_MS = 8_000
// RUN_TIMEOUT_MS's value: importing hosts/orca.ts would pull Orca's modules into the fleet.
const SEAT_TIMEOUT_MS = 10_000
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Answers the last reading of seat0's owner, true before the first, and, while
 * a dial is on USB, starts a reading without waiting for it so the fleet's
 * synchronous check stays so. */
export function linuxSeatOwner(deps: SeatDeps): (dialHere: boolean) => boolean {
  let owner = true
  let reading = false
  let began = -Infinity
  return (dialHere) => {
    if (dialHere && !reading && deps.now() - began >= SEAT_EVERY_MS) {
      reading = true
      began = deps.now()
      void readSeatOwner(deps).then((answer) => {
        owner = answer
        reading = false
      })
    }
    return owner
  }
}

// No logind, no seat or no active session keeps the dial: a computer with no seat has no screen to switch away from.
async function readSeatOwner({ run, uid }: SeatDeps): Promise<boolean> {
  try {
    const seat = await run('loginctl', ['show-seat', 'seat0', '--property=ActiveSession', '--value'], SEAT_TIMEOUT_MS)
    const id = seat.stdout.trim()
    if (seat.code !== 0 || !SESSION_ID.test(id)) return true
    const session = await run('loginctl', ['show-session', id, '--property=User', '--value'], SEAT_TIMEOUT_MS)
    const user = session.stdout.trim()
    if (session.code !== 0 || !/^\d+$/.test(user) || uid === undefined) return true
    return uid === Number(user)
  } catch {
    return true
  }
}

function runFile(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => {
      if (!error) resolve({ code: 0, stdout })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout })
      else reject(error)
    })
  })
}

let linuxSeat: ((dialHere: boolean) => boolean) | undefined

function realLinuxSeat(dialHere: boolean): boolean {
  linuxSeat ??= linuxSeatOwner({ run: runFile, now: Date.now, uid: process.getuid?.() })
  return linuxSeat(dialHere)
}
