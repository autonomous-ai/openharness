import { describe, expect, it } from 'vitest'
import { guestUserFor } from '../guestAccounts.js'
import {
  GuestSetupError, WINDOWS_GUEST_TASK, createGuestSetupClient, type GuestSetupFs,
} from './guestSetupClient.js'
import { guestAnswerFile, guestRequestFile } from './guestRequests.js'

const OWNER = 'C:\\Users\\owner'
const EMAIL = 'member@example.com'
const USER = guestUserFor(EMAIL)

class MemFs implements GuestSetupFs {
  files = new Map<string, string>()
  dirs = new Set<string>()
  renames: Array<[string, string]> = []
  mkdir(path: string) { this.dirs.add(path) }
  write(path: string, text: string) {
    if (this.files.has(path)) throw new Error(`already there: ${path}`)
    this.files.set(path, text)
  }
  rename(from: string, to: string) {
    const text = this.files.get(from)
    if (text === undefined) throw new Error(`no file: ${from}`)
    this.files.delete(from)
    this.files.set(to, text)
    this.renames.push([from, to])
  }
  read(path: string) {
    const text = this.files.get(path)
    if (text === undefined) throw new Error(`no file: ${path}`)
    return text
  }
  exists(path: string) { return this.files.has(path) }
  unlink(path: string) { this.files.delete(path) }
}

const answer = (request: Record<string, unknown>, over: Record<string, unknown> = {}) => {
  const user = typeof request.user === 'string' ? request.user : guestUserFor(String(request.email))
  return JSON.stringify({ id: request.id, ok: true, user, home: `C:\\Users\\${user}`, workspace: `C:\\Users\\${user}\\work`, ...over })
}

/** A setup task stand-in that answers the request it finds, as the SYSTEM script would. */
function setup(fs: MemFs, respond: (request: Record<string, unknown>) => string | null = (r) => answer(r)) {
  let runs = 0
  const startTask = async () => {
    runs++
    const request = [...fs.files.keys()].find((path) => path.startsWith('C:\\ProgramData\\HarnessGuests\\requests\\') && path.endsWith('.json'))
    if (!request) throw new Error('no request')
    const body = JSON.parse(fs.read(request)) as Record<string, unknown>
    const response = respond(body)
    if (response !== null) fs.write(guestAnswerFile(String(body.id)), response)
  }
  return { startTask, runs: () => runs }
}

const client = (fs: MemFs, startTask: () => Promise<void>, over: Record<string, unknown> = {}) => {
  let clock = 0
  return createGuestSetupClient({
    ownerHome: OWNER, fs, startTask, timeoutMs: 1_000, pollMs: 100,
    sleep: async (ms) => { clock += ms }, now: () => clock, ...over,
  })
}

describe('the guest setup client', () => {
  it('writes one atomic request, starts the task, reads and deletes the answer, and caches one ensure per email', async () => {
    const fs = new MemFs()
    const task = setup(fs)
    const setupClient = client(fs, task.startTask)
    const [a, b] = await Promise.all([setupClient.ensureGuest(' Member@Example.COM '), setupClient.ensureGuest(EMAIL)])
    expect(a).toEqual({ user: USER, home: `C:\\Users\\${USER}`, workspace: `C:\\Users\\${USER}\\work` })
    expect(b).toEqual(a)
    expect(task.runs()).toBe(1)
    expect(fs.renames).toHaveLength(1)
    expect([...fs.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
    expect([...fs.files.keys()].some((path) => path.includes('\\requests\\') || path.includes('\\answers\\'))).toBe(false)
  })

  it('sends the owner\'s whole folder set, read and edit, in one request', async () => {
    const fs = new MemFs()
    let seen: unknown
    const task = setup(fs, (request) => { seen = request.folders; return answer(request) })
    await client(fs, task.startTask).setFolders(USER, [{ path: 'C:\\Users\\owner\\work', write: true }, { path: 'D:\\docs', write: false }])
    expect(seen).toEqual([{ path: 'C:\\Users\\owner\\work', write: true }, { path: 'D:\\docs', write: false }])
  })

  it('starts again after a failed ensure: a failure is not cached', async () => {
    const fs = new MemFs()
    let first = true
    const task = setup(fs, (request) => {
      if (!first) return answer(request)
      first = false
      return JSON.stringify({ id: request.id, ok: false, detail: 'Windows would not make the profile.' })
    })
    const setupClient = client(fs, task.startTask)
    await expect(setupClient.ensureGuest(EMAIL)).rejects.toMatchObject({ code: 'REQUEST_FAILED', message: 'Windows would not make the profile.' })
    await expect(setupClient.ensureGuest(EMAIL)).resolves.toMatchObject({ user: USER })
    expect(task.runs()).toBe(2)
  })

  it('refuses an answer for another request, removes the request, and says so', async () => {
    const fs = new MemFs()
    const task = setup(fs, (request) => JSON.stringify({ id: 'b'.repeat(32), ok: false, detail: 'x' }))
    await expect(client(fs, task.startTask).ensureGuest(EMAIL)).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect([...fs.files.keys()].some((path) => path.includes('\\requests\\'))).toBe(false)
  })

  it('removes the request when the task cannot start or does not answer in time', async () => {
    const fs = new MemFs()
    const noTask = async () => { throw new GuestSetupError('TASK_FAILED', 'no task') }
    await expect(client(fs, noTask).ensureGuest(EMAIL)).rejects.toMatchObject({ code: 'TASK_FAILED' })
    expect([...fs.files.keys()].some((path) => path.includes('\\requests\\'))).toBe(false)

    const silent = async () => {}
    await expect(client(fs, silent).ensureGuest(EMAIL)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect([...fs.files.keys()].some((path) => path.includes('\\requests\\'))).toBe(false)
  })

  it('removes a guest and reports the task\'s refusal', async () => {
    const fs = new MemFs()
    const task = setup(fs, (request) => {
      if (request.op === 'remove') return JSON.stringify({ id: request.id, ok: false, detail: 'Windows still holds the profile.' })
      return answer(request)
    })
    await expect(client(fs, task.startTask).removeGuest(USER)).rejects.toMatchObject({ code: 'REQUEST_FAILED', message: 'Windows still holds the profile.' })
  })

  it('names the task the setup makes, at the Harness task folder', () => {
    expect(WINDOWS_GUEST_TASK).toBe('\\Harness\\Harness Guests Setup')
    expect(guestRequestFile('a'.repeat(32))).toContain('C:\\ProgramData\\HarnessGuests\\requests\\')
    expect(guestAnswerFile('a'.repeat(32))).toContain('C:\\ProgramData\\HarnessGuests\\answers\\')
  })
})
