import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CLAUDE_CLIENT_ID,
  CODEX_CLIENT_ID,
  createOwnerSubscriptions,
  type KeychainWriter,
  type OwnerSubscriptionDeps,
} from './ownerSubscriptions.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'owner-subscriptions-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function write(relative: string, value: unknown, mode = 0o600): string {
  const path = join(home, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  return path
}

const NOW = 1_800_000_000_000
const jwt = (claims: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

interface TokenCall { url: string; body: Record<string, string> }

/** The vendor's token endpoint: answers [answer] (or [status]) and remembers each request. */
function tokenEndpoint(answer: Record<string, unknown>, status = 200) {
  const calls: TokenCall[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, string> })
    await new Promise((resolve) => setTimeout(resolve, 5))
    return new Response(JSON.stringify(answer), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function keychain(stored: string | null) {
  const writes: Array<{ account: string; secret: string }> = []
  let current = stored
  const writer: KeychainWriter = {
    account: async () => 'owner',
    write: async (account, secret) => { writes.push({ account, secret }); current = secret },
  }
  return { writes, writer, read: async () => current }
}

function deps(extra: OwnerSubscriptionDeps): OwnerSubscriptionDeps {
  return { home, now: () => NOW, lockDir: join(home, 'locks'), readKeychain: async () => null, ...extra }
}

const claudeFile = (oauth: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ claudeAiOauth: { scopes: ['user:inference'], subscriptionType: 'max', ...oauth }, ...extra })

describe('reading the owner\'s sign-ins', () => {
  it('reads Claude from the Keychain before the file, and Codex with its account and JWT expiry', async () => {
    const k = keychain(JSON.stringify(claudeFile({ accessToken: 'from-keychain', expiresAt: NOW + 3_600_000 })))
    write('.claude/.credentials.json', claudeFile({ accessToken: 'from-file' }))
    write('.codex/auth.json', { tokens: { access_token: jwt({ exp: 1_900_000_000 }), refresh_token: 'r', account_id: 'acct-1' } })
    const owner = createOwnerSubscriptions(deps({ readKeychain: k.read }))
    expect(await owner.read('claude')).toMatchObject({ accessToken: 'from-keychain', expiresAt: NOW + 3_600_000 })
    expect(await owner.read('codex')).toMatchObject({ accountId: 'acct-1', expiresAt: 1_900_000_000_000 })
  })

  it('is null when the owner is not signed in', async () => {
    const owner = createOwnerSubscriptions(deps({}))
    expect(await owner.read('claude')).toBeNull()
    expect(await owner.read('codex')).toBeNull()
  })
})

describe('refreshing Claude', () => {
  it('posts the refresh token with Claude Code\'s client id and writes the answer back to the file, keeping its mode and fields', async () => {
    const path = write('.claude/.credentials.json', claudeFile({ accessToken: 'old', refreshToken: 'r-old', expiresAt: NOW - 1 }, { other: 'kept' }))
    const vendor = tokenEndpoint({ access_token: 'new', refresh_token: 'r-new', expires_in: 3600 })
    const owner = createOwnerSubscriptions(deps({ fetchImpl: vendor.fetchImpl, tokenUrls: { claude: 'https://token.test/claude' } }))
    const stale = await owner.read('claude')
    const fresh = await owner.refresh('claude', stale)
    expect(fresh).toMatchObject({ accessToken: 'new', expiresAt: NOW + 3_600_000 })
    expect(vendor.calls).toEqual([{ url: 'https://token.test/claude', body: { grant_type: 'refresh_token', refresh_token: 'r-old', client_id: CLAUDE_CLIENT_ID } }])
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toEqual(claudeFile({ accessToken: 'new', refreshToken: 'r-new', expiresAt: NOW + 3_600_000 }, { other: 'kept' }))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('writes a Keychain sign-in back to the Keychain item it came from', async () => {
    const k = keychain(JSON.stringify(claudeFile({ accessToken: 'old', refreshToken: 'r-old', expiresAt: NOW - 1 })))
    const vendor = tokenEndpoint({ access_token: 'new', expires_in: 60 })
    const owner = createOwnerSubscriptions(deps({ readKeychain: k.read, keychain: k.writer, fetchImpl: vendor.fetchImpl }))
    expect(await owner.refresh('claude', await owner.read('claude'))).toMatchObject({ accessToken: 'new' })
    expect(k.writes).toHaveLength(1)
    expect(k.writes[0]!.account).toBe('owner')
    // The refresh token is kept when the vendor does not rotate it.
    expect(JSON.parse(k.writes[0]!.secret).claudeAiOauth).toMatchObject({ accessToken: 'new', refreshToken: 'r-old', subscriptionType: 'max' })
  })

  it('refreshes once when several requests find the token expired at the same time', async () => {
    write('.claude/.credentials.json', claudeFile({ accessToken: 'old', refreshToken: 'r-old', expiresAt: NOW - 1 }))
    const vendor = tokenEndpoint({ access_token: 'new', refresh_token: 'r-new', expires_in: 3600 })
    const owner = createOwnerSubscriptions(deps({ fetchImpl: vendor.fetchImpl }))
    const stale = await owner.read('claude')
    const results = await Promise.all([owner.refresh('claude', stale), owner.refresh('claude', stale), owner.refresh('claude', stale)])
    expect(results.map((r) => r?.accessToken)).toEqual(['new', 'new', 'new'])
    expect(vendor.calls).toHaveLength(1)
  })

  it('uses a token someone else already refreshed instead of spending the refresh token again', async () => {
    write('.claude/.credentials.json', claudeFile({ accessToken: 'theirs', refreshToken: 'r-theirs', expiresAt: NOW + 3_600_000 }))
    const vendor = tokenEndpoint({ access_token: 'never' })
    const owner = createOwnerSubscriptions(deps({ fetchImpl: vendor.fetchImpl }))
    const fresh = await owner.refresh('claude', { provider: 'claude', accessToken: 'mine', expiresAt: NOW - 1, accountId: null })
    expect(fresh?.accessToken).toBe('theirs')
    expect(vendor.calls).toHaveLength(0)
  })

  it('leaves the store alone and answers null when the vendor refuses', async () => {
    const before = claudeFile({ accessToken: 'old', refreshToken: 'r-old', expiresAt: NOW - 1 })
    const path = write('.claude/.credentials.json', before)
    const vendor = tokenEndpoint({ error: 'invalid_grant' }, 400)
    const owner = createOwnerSubscriptions(deps({ fetchImpl: vendor.fetchImpl }))
    expect(await owner.refresh('claude', await owner.read('claude'))).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before)
  })
})

describe('refreshing Codex', () => {
  it('posts with the Codex client id and writes the tokens back with last_refresh, keeping other fields and the mode', async () => {
    const path = write('.codex/auth.json', {
      OPENAI_API_KEY: null,
      tokens: { access_token: jwt({ exp: 1 }), refresh_token: 'r-old', account_id: 'acct-1', id_token: 'id-old' },
      last_refresh: 'then',
    }, 0o640)
    const newAccess = jwt({ exp: 1_900_000_000 })
    const vendor = tokenEndpoint({ access_token: newAccess, refresh_token: 'r-new', id_token: 'id-new' })
    const owner = createOwnerSubscriptions(deps({ fetchImpl: vendor.fetchImpl, tokenUrls: { codex: 'https://token.test/codex' } }))
    const fresh = await owner.refresh('codex', await owner.read('codex'))
    expect(fresh).toMatchObject({ accessToken: newAccess, accountId: 'acct-1', expiresAt: 1_900_000_000_000 })
    expect(vendor.calls[0]!.body).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'r-old', scope: 'openid profile email' })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toEqual({
      OPENAI_API_KEY: null,
      tokens: { access_token: newAccess, refresh_token: 'r-new', account_id: 'acct-1', id_token: 'id-new' },
      last_refresh: new Date(NOW).toISOString(),
    })
    expect(statSync(path).mode & 0o777).toBe(0o640)
  })
})
