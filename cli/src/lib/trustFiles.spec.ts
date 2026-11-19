import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { AUTH_SESSION_FILE } from './authSession.js'
import { hookCredentialPath, hookTokenPath } from './hookAuth.js'
import { unreadableTrustLines } from './trustFiles.js'

const E2E = join(env.ADAPTER_DATA_DIR, 'e2e')
const ACCOUNT = join(E2E, 'accounts', '65f0a1b2c3d4e5f6a7b8c9d0')
const HOOK_TOKEN = hookTokenPath(env.ADAPTER_DATA_DIR)
// What a reader saw mid-write.
const TORN = '[{"identityPub":"'

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

beforeEach(() => {
  rmSync(E2E, { recursive: true, force: true })
  for (const file of [AUTH_SESSION_FILE, HOOK_TOKEN, hookCredentialPath(env.ADAPTER_DATA_DIR)]) rmSync(file, { force: true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('unreadableTrustLines', () => {
  it('names each trust file that cannot be read, with its full path', () => {
    const files = {
      [join(E2E, 'paired.json')]: TORN,
      [join(ACCOUNT, 'group.json')]: '{"members":["a"',
      [join(E2E, 'group.json')]: JSON.stringify({ members: [], removed: [] }),
      [join(ACCOUNT, 'paired.json')]: '[]',
    }
    for (const [file, text] of Object.entries(files)) write(file, text)
    const said = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]

    expect(unreadableTrustLines()).toEqual([
      `  ! ${join(E2E, 'paired.json')} cannot be read (not valid JSON) · move it aside to start over`,
      `  ! ${join(ACCOUNT, 'group.json')} cannot be read (not valid JSON) · move it aside to start over`,
    ])
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
    for (const [file, text] of Object.entries(files)) expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('names a torn hook token', () => {
    // Half a token: what a reader saw while an older build filled the file it had just created.
    write(HOOK_TOKEN, 'A'.repeat(21))

    expect(unreadableTrustLines()).toEqual([
      `  ! ${HOOK_TOKEN} cannot be read (unexpected content) · move it aside to start over`,
    ])
    expect(readFileSync(HOOK_TOKEN, 'utf8')).toBe('A'.repeat(21))
  })
})
