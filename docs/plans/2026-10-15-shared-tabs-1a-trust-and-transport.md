# Shared tabs, step 1a: trust and transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a shared tab needs below the person's view: a roster the owner's computer signs and members
verify, per-machine-pair sessions between accounts, the backend's mailbox, roster store and blind relay, and the
messages service's owner and member operations, reachable as `agent_messages` actions. No message delivery across
accounts yet (1b) and no desktop (1c).

**Architecture:** The owner's daemon is the authority: `messages/sharedTabs.ts` builds each roster, has the gateway sign
it through a new key port (`TabKey`, the gateway holds the identity), and publishes it to the backend. Members verify
it (`messages/roster.ts`, `messages/rosterStore.ts`) against the owner key they pinned on accept. Daemons of different
accounts talk through the backend's `/api/agent-messages-ws`, which routes by `(sharedTabId, machineId)` and reads
nothing; each machine pair runs a `TabSessionCrypto` session whose hello and welcome are signed by the keys the roster
lists. Member requests (add or remove a harness) travel sealed over that relay to the owner's machine.

**Tech Stack:** TypeScript, vitest, zod, `@noble` Ed25519/X25519 via `cli/src/lib/e2ee/core.ts`, `ws`; backend
Fastify + Prisma (Mongo) + Redis bus.

**Spec:** [docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md](../superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md)

**Before starting:** step 0 ([2026-10-15-shared-tabs-0-spikes.md](2026-10-15-shared-tabs-0-spikes.md)) is done and its
Findings did not change a task below; if one did, that task was edited first.

## Global Constraints

- No new switch: everything runs only while `agent_messages` is on and the computer is signed in; off or signed out,
  no timer, no socket (`messages/service.ts` header).
- Services hold no credential: signing and sealing happen in the gateway, reached through `core.account.tabKey`
  (`cli/AGENTS.md`, rule 2; `core/api.ts` `ObserverKey` precedent).
- Never reuse the gateway's client handshake (`E2eeManager`) or `RelaySessionCrypto` for another account: the first
  would pair a member's machine as this account's client; the second sends unlisted frame types in the clear.
- The backend never parses, alters or hides a roster: it stores the blob and its version only.
- `sharedTabId` = first 24 hex characters of `sha256(JSON.stringify(['amsg-share', ownerUserId, tabId]))`.
- Limits (spec, "Limits"): 32 harnesses and 8 members per shared tab; refusals are explicit (`TAB_FULL`).
- 100% per-file coverage for every new file: CLI under `npm run test:shared-tabs` (new), backend under
  `npm run test:agent-messages` (new); `npm run test:core` stays green for the core and services files touched.
- Comments say why, in plain sentences (`cli/AGENTS.md`, rule 7). Docs and code in English.
- No commits unless the owner asks: the "Commit" step of each task is replaced by "leave the change in the working
  tree and list it in the task's report".

## Review Focus

1. **A roster replayed or rolled back by the backend** (an older signed roster served after a newer one): members
   must keep the newer one and alert. Tested in Task 3.
2. **A member machine whose key is not in the roster** opening a session: the responder must refuse before any
   frame is opened. Tested in Task 1 and Task 9.
3. **Two accounts with the same desk tab id** (`tab-1` is common): rosters, relay channels and invitations must
   never cross. Tested in Task 5 (`sharedTabId` differs) and Task 7 (routing by `sharedTabId`).
4. **The owner's computer offline when a member adds a harness**: the request waits and is retried; nothing is
   lost or applied twice. Tested in Task 9.
5. **An invitation accepted after it expired or was revoked**, or accepted by a different email: refused. Tested in
   Task 6.

---

### Task 1: Coverage gate and `TabSessionCrypto`

**Files:**
- Create: `cli/vitest.shared-tabs.config.ts`
- Modify: `cli/package.json` (scripts)
- Create: `cli/src/lib/e2ee/tabSession.ts`
- Test: `cli/src/lib/e2ee/tabSession.spec.ts`

**Interfaces:**
- Consumes: `core.ts` `helloSig`, `helloVerify`, `welcomeSig`, `welcomeVerify`, `sessionKeys`, `newEphemeral`,
  `wrapPayload`, `unwrapPayload`, `b64e`, `b64d`; `ReplayWindow` from `replayWindow.ts`.
- Produces:
  - `tabContext(sharedTabId: string, initiator: string, responder: string): string`
  - `class TabCipher { seal(frame: Record<string, unknown>): WrappedPayload; open(value: unknown): Record<string, unknown> | null }`
  - `startTabSession(self: Identity, sharedTabId: string, selfMachine: string, peerMachine: string): { hello: TabHello; finish(welcome: TabWelcome, peerPub: string): TabCipher | null }`
  - `acceptTabSession(self: Identity, sharedTabId: string, peerMachine: string, selfMachine: string, hello: TabHello, peerPub: string): { welcome: TabWelcome; cipher: TabCipher } | null`
  - `type TabHello = { ephemeral: string; signature: string }`, `type TabWelcome = { ephemeral: string; signature: string }`

- [ ] **Step 1: Add the gate.** `cli/vitest.shared-tabs.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** Shared tabs across accounts (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md):
 *  the new files outside the core and services, which no other gate covers, held to 100% in every file. */
const FILES = [
  'src/lib/e2ee/tabSession.ts',
  'src/messages/roster.ts',
  'src/messages/rosterStore.ts',
  'src/messages/sharedTabs.ts',
  'src/gateway/tabKey.ts',
  'src/gateway/tabRelay.ts',
]
export default defineConfig({
  test: {
    ...base.test,
    include: FILES.map(f => f.replace(/\.ts$/, '.spec.ts')).concat('src/messages/sharedTabs.integration.spec.ts'),
    coverage: {
      enabled: true, provider: 'v8', include: FILES,
      reporter: ['text', 'json-summary'], reportsDirectory: 'coverage/shared-tabs',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
```

In `cli/package.json` `scripts`, after `test:core`:

```json
"test:shared-tabs": "vitest run --config vitest.shared-tabs.config.ts",
```

Files added by later tasks are already listed; vitest reports a missing spec as "no test files" for that entry
until its task lands, and the gate is first run green at the end of Task 10.

- [ ] **Step 2: Write the failing test.** `cli/src/lib/e2ee/tabSession.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { b64e, newIdentity } from './core.js'
import { acceptTabSession, startTabSession, tabContext, TabCipher } from './tabSession.js'

const alice = newIdentity(), bob = newIdentity(), mallory = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'

function pair() {
  const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
  const accepted = acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
  const mine = start.finish(accepted.welcome, b64e(bob.pub))!
  return { mine, theirs: accepted.cipher }
}

describe('a session between two machines of a shared tab', () => {
  it('binds the context to the tab and both machines, in order', () => {
    expect(tabContext(TAB, 'a', 'b')).toBe(`harness-tab-v1:${TAB}:a:b`)
    expect(tabContext(TAB, 'a', 'b')).not.toBe(tabContext(TAB, 'b', 'a'))
  })

  it('carries frames both ways once each side proved the key the roster lists', () => {
    const { mine, theirs } = pair()
    expect(theirs.open(mine.seal({ type: 'deliver', text: 'hi' }))).toEqual({ type: 'deliver', text: 'hi' })
    expect(mine.open(theirs.seal({ type: 'status', ok: true }))).toEqual({ type: 'status', ok: true })
  })

  it('refuses a hello signed by a key the roster does not list', () => {
    const start = startTabSession(mallory, TAB, 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))).toBeNull()
  })

  it('refuses a welcome signed by a key the roster does not list', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    const forged = acceptTabSession(mallory, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
    expect(start.finish(forged.welcome, b64e(bob.pub))).toBeNull()
  })

  it('refuses a hello made for another tab or another machine pair', () => {
    const start = startTabSession(alice, 'f'.repeat(24), 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))).toBeNull()
    const other = startTabSession(alice, TAB, 'alice-mac', 'carol-pc')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', other.hello, b64e(alice.pub))).toBeNull()
  })

  it('refuses malformed keys and signatures instead of throwing', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ...start.hello, ephemeral: 'AAAA' }, b64e(alice.pub))).toBeNull()
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, 'AAAA')).toBeNull()
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ephemeral: start.hello.ephemeral, signature: '!!' }, b64e(alice.pub))).toBeNull()
    expect(start.finish({ ephemeral: 'AAAA', signature: 'AAAA' }, b64e(bob.pub))).toBeNull()
  })

  it('refuses a replayed, altered or foreign frame', () => {
    const { mine, theirs } = pair()
    const sealed = mine.seal({ n: 1 })
    expect(theirs.open(sealed)).toEqual({ n: 1 })
    expect(theirs.open(sealed)).toBeNull()
    const altered = mine.seal({ n: 2 }); altered.__e2e.ct = altered.__e2e.ct.replace(/^./, c => (c === 'A' ? 'B' : 'A'))
    expect(theirs.open(altered)).toBeNull()
    expect(pair().theirs.open(mine.seal({ n: 3 }))).toBeNull()
    expect(theirs.open(null)).toBeNull()
    expect(theirs.open({ __e2e: { v: 1, k: 'g', n: 9, ct: 'AA' } })).toBeNull()
    expect(theirs.open({ __e2e: { v: 1, k: 'p', n: 9, ct: 'x'.repeat(300_000) } })).toBeNull()
  })

  it('opens frames that arrive out of order within the window', () => {
    const { mine, theirs } = pair()
    const first = mine.seal({ n: 1 }), second = mine.seal({ n: 2 })
    expect(theirs.open(second)).toEqual({ n: 2 })
    expect(theirs.open(first)).toEqual({ n: 1 })
  })

  it('refuses a frame whose plaintext is not an object', () => {
    const { mine, theirs } = pair()
    expect(theirs.open((mine as unknown as { seal(f: unknown): unknown }).seal([1, 2]))).toBeNull()
    expect(TabCipher).toBeTypeOf('function')
  })
})
```

- [ ] **Step 3: Run it to see it fail.**

Run: `cd cli && npx vitest run src/lib/e2ee/tabSession.spec.ts`
Expected: FAIL, "Cannot find module './tabSession.js'".

- [ ] **Step 4: Implement.** `cli/src/lib/e2ee/tabSession.ts`:

```ts
/**
 * A session between two machines of a shared tab that belong to different accounts
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages across accounts").
 *
 * Not the gateway's handshake for this account's own clients (`E2eeManager`): that one trusts a key it finds
 * paired or in the device log, and answering a member's machine there would pair it as a client of this account.
 * Not `RelaySessionCrypto` either, which seals only the frame types it lists and sends any other in the clear.
 * Here each side proves the identity key the roster lists for its machine, the context binds the shared tab and
 * both machines in order, and every frame is sealed, with a replay window as the account's own sessions have.
 */
import {
  b64d, b64e, helloSig, helloVerify, newEphemeral, sessionKeys, unwrapPayload, welcomeSig, welcomeVerify, wrapPayload,
  type Identity, type WrappedPayload,
} from './core.js'
import { ReplayWindow } from './replayWindow.js'

export type TabHello = { ephemeral: string; signature: string }
export type TabWelcome = { ephemeral: string; signature: string }

/** The largest sealed frame accepted: a 16,000-character message sealed and in base64 is well under it. */
const MAX_CT = 256 * 1024

export const tabContext = (sharedTabId: string, initiator: string, responder: string): string =>
  `harness-tab-v1:${sharedTabId}:${initiator}:${responder}`

export class TabCipher {
  private tx = 0
  private readonly window = new ReplayWindow()
  constructor(private readonly sendKey: Uint8Array, private readonly receiveKey: Uint8Array,
    private readonly context: string) {}
  seal(frame: Record<string, unknown>): WrappedPayload {
    return wrapPayload(this.sendKey, 'p', this.tx++, 'tab_frame', this.context, frame)
  }
  open(value: unknown): Record<string, unknown> | null {
    const e = (value as WrappedPayload | null)?.__e2e
    if (!e || e.v !== 1 || e.k !== 'p' || typeof e.ct !== 'string' || e.ct.length > MAX_CT
      || !this.window.allows(e.n)) return null
    const frame = unwrapPayload(this.receiveKey, e, 'tab_frame', this.context)
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
    this.window.commit(e.n)
    return frame as Record<string, unknown>
  }
}

const key = (value: string): Uint8Array | null => {
  try { const bytes = b64d(value); return bytes.length === 32 ? bytes : null } catch { return null }
}
const sig = (value: string): Uint8Array | null => {
  try { const bytes = b64d(value); return bytes.length === 64 ? bytes : null } catch { return null }
}

export function startTabSession(self: Identity, sharedTabId: string, selfMachine: string, peerMachine: string) {
  const context = tabContext(sharedTabId, selfMachine, peerMachine)
  const eph = newEphemeral()
  const hello: TabHello = { ephemeral: b64e(eph.pub), signature: b64e(helloSig(self.priv, context, eph.pub)) }
  return {
    hello,
    finish(welcome: TabWelcome, peerPub: string): TabCipher | null {
      const theirs = key(welcome.ephemeral), pub = key(peerPub), signature = sig(welcome.signature)
      if (!theirs || !pub || !signature || !welcomeVerify(pub, context, eph.pub, theirs, signature)) return null
      const keys = sessionKeys(eph.priv, theirs, context, eph.pub, theirs)
      return new TabCipher(keys.c2s, keys.s2c, context)
    },
  }
}

export function acceptTabSession(self: Identity, sharedTabId: string, peerMachine: string, selfMachine: string,
  hello: TabHello, peerPub: string): { welcome: TabWelcome; cipher: TabCipher } | null {
  const context = tabContext(sharedTabId, peerMachine, selfMachine)
  const theirs = key(hello.ephemeral), pub = key(peerPub), signature = sig(hello.signature)
  if (!theirs || !pub || !signature || !helloVerify(pub, context, theirs, signature)) return null
  const eph = newEphemeral()
  const keys = sessionKeys(eph.priv, theirs, context, theirs, eph.pub)
  return {
    welcome: { ephemeral: b64e(eph.pub), signature: b64e(welcomeSig(self.priv, context, theirs, eph.pub)) },
    cipher: new TabCipher(keys.s2c, keys.c2s, context),
  }
}
```

- [ ] **Step 5: Run it to see it pass.**

Run: `cd cli && npx vitest run src/lib/e2ee/tabSession.spec.ts --coverage --coverage.include=src/lib/e2ee/tabSession.ts`
Expected: PASS, 100% lines/branches/functions for `tabSession.ts`. If `b64d` does not throw on `'!!'` and a branch
stays uncovered, keep the `try` only where the coverage report shows it is reached and add the input that reaches
the other.

- [ ] **Step 6: Leave it in the working tree** (no commit) and note the files in the task report.

---

### Task 2: The roster: shape, bytes, signature, key change

**Files:**
- Create: `cli/src/messages/roster.ts`
- Test: `cli/src/messages/roster.spec.ts`

**Interfaces:**
- Consumes: `sign`, `verify`, `lvCat`, `b64e`, `b64d` from `lib/e2ee/core.ts`; `zod`.
- Produces:
  - `type Roster` (fields below), `type RosterHarness`, `type SignedRoster = { body: string; signature: string; keyChange?: KeyChange }`,
    `type KeyChange = { previousPub: string; signature: string }`
  - `ROSTER_LIMITS = { harnesses: 32, members: 8 }`
  - `rosterBytes(sharedTabId: string, version: number, body: string): Uint8Array`
  - `keyChangeBytes(sharedTabId: string, nextPub: string): Uint8Array`
  - `encodeRoster(roster: Roster): string` (canonical JSON: keys sorted)
  - `parseRoster(body: string): Roster | null`
  - `verifyRoster(signed: SignedRoster, pinnedOwnerPub: string): { roster: Roster; ownerPub: string } | { error: RosterError }`
  - `type RosterError = 'malformed' | 'bad_signature' | 'unpinned_key' | 'too_large'`

- [ ] **Step 1: Write the failing test.** `cli/src/messages/roster.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { b64e, newIdentity, sign } from '../lib/e2ee/core.js'
import { encodeRoster, keyChangeBytes, parseRoster, ROSTER_LIMITS, rosterBytes, verifyRoster, type Roster } from './roster.js'

const owner = newIdentity(), next = newIdentity(), stranger = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const base = (pub = owner.pub): Roster => ({
  sharedTabId: TAB, version: 3, name: 'app',
  owner: { accountId: 'u-alice', email: 'alice@example.com', machineId: 'alice-mac', machinePublicKey: b64e(pub) },
  leader: { machineId: 'alice-mac', agentId: 'lead' },
  members: [{ accountId: 'u-bob', email: 'bob@example.com', name: 'Bob', acceptedAt: '2026-10-15T00:00:00.000Z' }],
  harnesses: [
    { accountId: 'u-alice', machineId: 'alice-mac', machinePublicKey: b64e(pub), agentId: 'lead', name: 'lead', engine: 'codex' },
    { accountId: 'u-bob', machineId: 'bob-mini', machinePublicKey: b64e(stranger.pub), agentId: 'api', name: 'api', engine: 'claude' },
  ],
  invites: [{ email: 'carol@example.com', expiresAt: '2026-11-14T00:00:00.000Z' }],
})
const signed = (r: Roster, by = owner) => {
  const body = encodeRoster(r)
  return { body, signature: b64e(sign(by.priv, rosterBytes(r.sharedTabId, r.version, body))) }
}

describe('the roster', () => {
  it('encodes the same roster to the same bytes whatever the key order', () => {
    const r = base()
    const shuffled = JSON.parse(JSON.stringify({ version: r.version, ...r }))
    expect(encodeRoster(shuffled)).toBe(encodeRoster(r))
    expect(parseRoster(encodeRoster(r))).toEqual(r)
  })

  it('verifies a roster signed by the pinned owner key', () => {
    const result = verifyRoster(signed(base()), b64e(owner.pub))
    expect(result).toEqual({ roster: base(), ownerPub: b64e(owner.pub) })
  })

  it('refuses a roster signed by another key, or altered after signing', () => {
    expect(verifyRoster(signed(base(), stranger), b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    const s = signed(base())
    expect(verifyRoster({ ...s, body: s.body.replace('"app"', '"ppa"') }, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
  })

  it('refuses a roster whose owner key is not the pinned one, unless the pinned key signed the change', () => {
    const r = base(next.pub)
    const s = signed(r, next)
    expect(verifyRoster(s, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
    const keyChange = { previousPub: b64e(owner.pub), signature: b64e(sign(owner.priv, keyChangeBytes(TAB, b64e(next.pub)))) }
    expect(verifyRoster({ ...s, keyChange }, b64e(owner.pub))).toEqual({ roster: r, ownerPub: b64e(next.pub) })
    const forged = { previousPub: b64e(owner.pub), signature: b64e(sign(stranger.priv, keyChangeBytes(TAB, b64e(next.pub)))) }
    expect(verifyRoster({ ...s, keyChange: forged }, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
    expect(verifyRoster({ ...s, keyChange: { ...keyChange, previousPub: b64e(stranger.pub) } }, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
  })

  it('refuses malformed and oversized rosters', () => {
    expect(verifyRoster({ body: '{', signature: 'AA' }, b64e(owner.pub))).toEqual({ error: 'malformed' })
    expect(verifyRoster({ body: encodeRoster(base()), signature: 'AA' }, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    expect(parseRoster(JSON.stringify({ ...base(), version: 0 }))).toBeNull()
    expect(parseRoster(JSON.stringify({ ...base(), sharedTabId: 'tab-1' }))).toBeNull()
    const many = { ...base(), harnesses: Array.from({ length: ROSTER_LIMITS.harnesses + 1 }, (_, i) => ({ ...base().harnesses[1], agentId: `a${i}` })) }
    expect(verifyRoster(signed(many), b64e(owner.pub))).toEqual({ error: 'too_large' })
    const crowd = { ...base(), members: Array.from({ length: ROSTER_LIMITS.members + 1 }, (_, i) => ({ ...base().members[0], accountId: `u${i}` })) }
    expect(verifyRoster(signed(crowd), b64e(owner.pub))).toEqual({ error: 'too_large' })
  })

  it('binds the signature to the tab and version', () => {
    const r = base(), body = encodeRoster(r)
    const wrongTab = { body, signature: b64e(sign(owner.priv, rosterBytes('f'.repeat(24), r.version, body))) }
    const wrongVersion = { body, signature: b64e(sign(owner.priv, rosterBytes(TAB, r.version + 1, body))) }
    expect(verifyRoster(wrongTab, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    expect(verifyRoster(wrongVersion, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
  })
})
```

- [ ] **Step 2: Run it to see it fail.**

Run: `cd cli && npx vitest run src/messages/roster.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** `cli/src/messages/roster.ts`:

```ts
/**
 * A shared tab's roster (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Trust: the
 * signed roster"): who is in the tab, signed by the owner's computer. The backend stores it and reads nothing in it,
 * so what a member believes about the tab is only what the owner's key signed: a backend that served an altered
 * roster, or a stranger's, is caught here.
 *
 * The signature covers the body as the owner sent it, a string, never a re-encoding of it: two encoders that
 * disagree on a key's order or a number's form could otherwise disagree on whether it verifies.
 */
import { z } from 'zod'
import { b64d, lvCat, verify } from '../lib/e2ee/core.js'

export const ROSTER_LIMITS = { harnesses: 32, members: 8 } as const

const id = z.string().min(1).max(160)
const pub = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
const harness = z.object({ accountId: id, machineId: id, machinePublicKey: pub, agentId: id,
  name: z.string().max(200), engine: z.string().max(64) }).strict()
const schema = z.object({
  sharedTabId: z.string().regex(/^[a-f0-9]{24}$/),
  version: z.number().int().min(1),
  name: z.string().max(200),
  owner: z.object({ accountId: id, email: z.string().max(254), machineId: id, machinePublicKey: pub }).strict(),
  leader: z.object({ machineId: id, agentId: id }).strict().nullable(),
  members: z.array(z.object({ accountId: id, email: z.string().max(254), name: z.string().max(200),
    acceptedAt: z.string().datetime() }).strict()),
  harnesses: z.array(harness),
  invites: z.array(z.object({ email: z.string().max(254), expiresAt: z.string().datetime() }).strict()),
}).strict()

export type Roster = z.infer<typeof schema>
export type RosterHarness = z.infer<typeof harness>
export type KeyChange = { previousPub: string; signature: string }
export type SignedRoster = { body: string; signature: string; keyChange?: KeyChange }
export type RosterError = 'malformed' | 'bad_signature' | 'unpinned_key' | 'too_large'

export const rosterBytes = (sharedTabId: string, version: number, body: string): Uint8Array =>
  lvCat('harness-tab-roster-v1', sharedTabId, String(version), body)
export const keyChangeBytes = (sharedTabId: string, nextPub: string): Uint8Array =>
  lvCat('harness-tab-keychange-v1', sharedTabId, nextPub)

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
    : value

export const encodeRoster = (roster: Roster): string => JSON.stringify(sorted(roster))

export function parseRoster(body: string): Roster | null {
  try { const parsed = schema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null } catch { return null }
}

const verifies = (pubKey: string, bytes: Uint8Array, signature: string): boolean => {
  try { return verify(b64d(pubKey), bytes, b64d(signature)) } catch { return false }
}

export function verifyRoster(signed: SignedRoster, pinnedOwnerPub: string): { roster: Roster; ownerPub: string } | { error: RosterError } {
  const roster = parseRoster(signed.body)
  if (!roster) return { error: 'malformed' }
  const ownerPub = roster.owner.machinePublicKey
  if (!verifies(ownerPub, rosterBytes(roster.sharedTabId, roster.version, signed.body), signed.signature)) return { error: 'bad_signature' }
  if (ownerPub !== pinnedOwnerPub) {
    // The owner moved to a new computer or a new key: accepted only when the key the member pinned signed the move.
    const change = signed.keyChange
    if (!change || change.previousPub !== pinnedOwnerPub
      || !verifies(pinnedOwnerPub, keyChangeBytes(roster.sharedTabId, ownerPub), change.signature)) return { error: 'unpinned_key' }
  }
  if (roster.harnesses.length > ROSTER_LIMITS.harnesses || roster.members.length > ROSTER_LIMITS.members) return { error: 'too_large' }
  return { roster, ownerPub }
}
```

- [ ] **Step 4: Run it to see it pass.**

Run: `cd cli && npx vitest run src/messages/roster.spec.ts --coverage --coverage.include=src/messages/roster.ts`
Expected: PASS, 100% for `roster.ts`.

- [ ] **Step 5: Leave it in the working tree** and list the files in the task report.

---

### Task 3: The roster store: pins, the newest roster, persistence

**Files:**
- Create: `cli/src/messages/rosterStore.ts`
- Test: `cli/src/messages/rosterStore.spec.ts`

**Interfaces:**
- Consumes: `verifyRoster`, `SignedRoster`, `Roster`, `RosterError` from Task 2.
- Produces:
  - `class RosterStore { constructor(path: string); pin(sharedTabId: string, ownerPub: string): void; offer(signed: SignedRoster): { roster: Roster } | { stale: true } | { error: RosterError | 'not_pinned' }; current(sharedTabId: string): { roster: Roster; signed: SignedRoster } | null; all(): Roster[]; forget(sharedTabId: string): void; alerts(): RosterAlert[] }`
  - `type RosterAlert = { sharedTabId: string; at: string; error: RosterError }`

- [ ] **Step 1: Write the failing test.** `cli/src/messages/rosterStore.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { b64e, newIdentity, sign } from '../lib/e2ee/core.js'
import { encodeRoster, rosterBytes, type Roster } from './roster.js'
import { RosterStore } from './rosterStore.js'

const owner = newIdentity(), stranger = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const roster = (version: number): Roster => ({
  sharedTabId: TAB, version, name: 'app',
  owner: { accountId: 'u-alice', email: 'a@x.io', machineId: 'alice-mac', machinePublicKey: b64e(owner.pub) },
  leader: null, members: [], invites: [],
  harnesses: [{ accountId: 'u-alice', machineId: 'alice-mac', machinePublicKey: b64e(owner.pub), agentId: 'lead', name: 'lead', engine: 'codex' }],
})
const signed = (version: number, by = owner) => {
  const r = roster(version), body = encodeRoster(r)
  return { body, signature: b64e(sign(by.priv, rosterBytes(TAB, version, body))) }
}

describe('the roster store', () => {
  let dir: string, path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rosters-')); path = join(dir, 'rosters.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('takes nothing for a tab it never pinned', () => {
    expect(new RosterStore(path).offer(signed(1))).toEqual({ error: 'not_pinned' })
  })

  it('keeps the newest valid roster, and says an older or equal one is stale', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub))
    expect(store.offer(signed(2))).toEqual({ roster: roster(2) })
    expect(store.offer(signed(1))).toEqual({ stale: true })
    expect(store.offer(signed(2))).toEqual({ stale: true })
    expect(store.current(TAB)?.roster.version).toBe(2)
    expect(store.alerts()).toEqual([])
  })

  it('keeps the last valid roster and records an alert when a forged one arrives', () => {
    const store = new RosterStore(path, () => Date.parse('2026-10-15T10:00:00Z'))
    store.pin(TAB, b64e(owner.pub))
    store.offer(signed(2))
    expect(store.offer(signed(5, stranger))).toEqual({ error: 'bad_signature' })
    expect(store.current(TAB)?.roster.version).toBe(2)
    expect(store.alerts()).toEqual([{ sharedTabId: TAB, at: '2026-10-15T10:00:00.000Z', error: 'bad_signature' }])
  })

  it('survives a restart, and keeps its file private', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(3))
    const again = new RosterStore(path)
    expect(again.current(TAB)?.roster.version).toBe(3)
    expect(again.all().map(r => r.version)).toEqual([3])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('persists the pin it was given', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub))
    expect(JSON.parse(readFileSync(path, 'utf8')).tabs[TAB].pinned).toBe(b64e(owner.pub))
  })

  it('forgets a tab entirely', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(1)); store.forget(TAB)
    expect(store.current(TAB)).toBeNull()
    expect(store.offer(signed(2))).toEqual({ error: 'not_pinned' })
  })

  it('refuses to start from an unreadable file rather than trusting nothing silently', () => {
    writeFileSync(path, '{bad')
    expect(() => new RosterStore(path)).toThrow('could not be read')
  })
})
```

- [ ] **Step 2: Run it to see it fail.** `cd cli && npx vitest run src/messages/rosterStore.spec.ts` → FAIL, module not found.

- [ ] **Step 3: Implement.** `cli/src/messages/rosterStore.ts`:

```ts
/**
 * The shared tabs this computer takes part in, as their owners signed them: the owner key pinned when the
 * person accepted (trust on first use), and the newest roster that verified against it. A roster older than the
 * one held is stale, never an error: the backend may serve an older one during a race. One that does not verify
 * is kept out and remembered as an alert (devlog principle: detect, not block), and the last valid one stays.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { verifyRoster, type Roster, type RosterError, type SignedRoster } from './roster.js'

export type RosterAlert = { sharedTabId: string; at: string; error: RosterError }
const signedSchema = z.object({ body: z.string(), signature: z.string(),
  keyChange: z.object({ previousPub: z.string(), signature: z.string() }).optional() })
const schema = z.object({
  tabs: z.record(z.object({ pinned: z.string(), signed: signedSchema.nullable() })),
  alerts: z.array(z.object({ sharedTabId: z.string(), at: z.string(), error: z.string() })),
})
type State = z.infer<typeof schema>
const MAX_ALERTS = 50

export class RosterStore {
  private state: State
  constructor(private readonly path: string, private readonly now = () => Date.now()) {
    try { this.state = schema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The shared tabs file could not be read.')
      this.state = { tabs: {}, alerts: [] }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
  }
  pin(sharedTabId: string, ownerPub: string): void {
    this.state.tabs[sharedTabId] = { pinned: ownerPub, signed: this.state.tabs[sharedTabId]?.signed ?? null }
    this.save()
  }
  offer(signed: SignedRoster): { roster: Roster } | { stale: true } | { error: RosterError | 'not_pinned' } {
    const sharedTabId = /"sharedTabId":"([a-f0-9]{24})"/.exec(signed.body)?.[1] ?? ''
    const tab = this.state.tabs[sharedTabId]
    if (!tab) return { error: 'not_pinned' }
    const result = verifyRoster(signed, tab.pinned)
    if ('error' in result) {
      this.state.alerts = [...this.state.alerts, { sharedTabId, at: new Date(this.now()).toISOString(), error: result.error }].slice(-MAX_ALERTS)
      this.save()
      return { error: result.error }
    }
    const held = this.current(sharedTabId)
    if (held && held.roster.version >= result.roster.version) return { stale: true }
    this.state.tabs[sharedTabId] = { pinned: result.ownerPub, signed }
    this.save()
    return { roster: result.roster }
  }
  current(sharedTabId: string): { roster: Roster; signed: SignedRoster } | null {
    const tab = this.state.tabs[sharedTabId]
    if (!tab?.signed) return null
    const result = verifyRoster(tab.signed, tab.pinned)
    return 'error' in result ? null : { roster: result.roster, signed: tab.signed }
  }
  all(): Roster[] {
    return Object.keys(this.state.tabs).flatMap(id => { const c = this.current(id); return c ? [c.roster] : [] })
  }
  forget(sharedTabId: string): void {
    delete this.state.tabs[sharedTabId]
    this.save()
  }
  alerts(): RosterAlert[] { return this.state.alerts.map(a => ({ ...a, error: a.error as RosterError })) }
}
```

`offer` reads `sharedTabId` from the canonical body by pattern only to find the pin; the roster is then fully parsed
and verified, and a body that lies about its tab fails verification against the wrong pin.

- [ ] **Step 4: Run it to see it pass.**

Run: `cd cli && npx vitest run src/messages/rosterStore.spec.ts --coverage --coverage.include=src/messages/rosterStore.ts`
Expected: PASS, 100%. If the `current()` error branch is uncovered, add a test that edits the file's `signed.body`
by hand and reloads.

- [ ] **Step 5: Leave it in the working tree** and list the files in the task report.

---

### Task 4: The `TabKey` port: the gateway signs rosters and holds the sessions

**Files:**
- Create: `cli/src/gateway/tabKey.ts`, Test: `cli/src/gateway/tabKey.spec.ts`
- Modify: `cli/src/core/api.ts` (interface, `TAB_KEY_OFF`, `account.tabKey`, `ACCOUNT_BACKEND_OFF`,
  `GatewayOps.tabKey`, `CoreApiDeps`, `createCoreApi`, `MESSAGES_QUERIES` gains `'tab_key'`)
- Modify: `cli/src/lib/gatewayWire.ts` (`GATEWAY_CALLS.tabKey = 'gateway_tab_key'`, beside lines 66–67)
- Modify: `cli/src/gateway/start.ts` (construct beside `observerKey` at 162–164, add to ops ≈512)
- Modify: `cli/src/gateway/gatewayProcess.ts` (a call handler beside 233–257)
- Modify: `cli/src/core/gatewayLink.ts` (`tabKeyOps` beside `ownerKey` 240–245, on the ops 320–324)
- Modify: `cli/src/core/main.ts` (≈864, beside the observerKey forwarding)
- Modify: `cli/src/core/messagesLink.ts` (`answer()` gains `case 'tab_key'`)
- Modify: `cli/src/services/messagesProcess.ts` (≈100: `account: { ...base.account, tabKey: askTabKey }`)
- Modify: `cli/src/testing/fakeCore.ts` (52–63: `tabKey: TAB_KEY_OFF`)
- Tests: `core/gatewayLink.spec.ts`, `core/messagesLink.spec.ts`, `services/messagesProcess.spec.ts`,
  `gateway/gatewayProcess.spec.ts` (one case each, mirroring the observerKey cases)

**Interfaces:**
- Consumes: Task 1's `startTabSession`, `acceptTabSession`, `TabCipher`; Task 2's `rosterBytes`, `keyChangeBytes`.
- Produces (in `core/api.ts`):

```ts
/** A peer in a shared tab: its machine, and the identity key the roster lists for it, vouched for by the caller. */
export interface TabLink { sharedTabId: string; machineId: string; peerPub: string }
/**
 * Shared tabs' keys, held by the gateway with this machine's E2EE identity
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md): the owner's signature on a roster
 * and on a move to a new key, and a session per peer machine, keyed by tab and machine. Agent Messages, in the edge
 * host, holds no key and asks for each.
 */
export interface TabKey {
  publicKey(): Promise<string>
  signRoster(sharedTabId: string, version: number, body: string): Promise<string>
  signKeyChange(sharedTabId: string, nextPub: string): Promise<string>
  hello(link: TabLink): Promise<Record<string, unknown>>
  welcome(link: TabLink, payload: Record<string, unknown>): Promise<boolean>
  accept(link: TabLink, hello: Record<string, unknown>): Promise<{ welcome: Record<string, unknown> } | { refused: true }>
  seal(link: TabLink, frame: Record<string, unknown>): Promise<LaneSealed>
  open(link: TabLink, frame: Record<string, unknown>): Promise<LaneOpened>
  drop(link: TabLink): void
}
export const TAB_KEY_OFF: TabKey = {
  publicKey: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  signRoster: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  signKeyChange: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  hello: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  welcome: async () => false,
  accept: async () => ({ refused: true }),
  seal: async () => ({ lost: true }),
  open: async () => ({ lost: true }),
  drop: () => {},
}
```

- [ ] **Step 1: Write the failing test.** `cli/src/gateway/tabKey.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { b64d, b64e, newIdentity, verify } from '../lib/e2ee/core.js'
import { keyChangeBytes, rosterBytes } from '../messages/roster.js'
import { TabSessions } from './tabKey.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const alice = newIdentity(), bob = newIdentity()
const A = new TabSessions(() => alice, () => 'alice-mac'), B = new TabSessions(() => bob, () => 'bob-mini')
const toBob = { sharedTabId: TAB, machineId: 'bob-mini', peerPub: b64e(bob.pub) }
const toAlice = { sharedTabId: TAB, machineId: 'alice-mac', peerPub: b64e(alice.pub) }

describe('the gateway\'s shared-tab keys', () => {
  it('signs a roster and a key change with this machine\'s identity, and nothing malformed', async () => {
    expect(await A.publicKey()).toBe(b64e(alice.pub))
    const s = await A.signRoster(TAB, 2, '{"x":1}')
    expect(verify(alice.pub, rosterBytes(TAB, 2, '{"x":1}'), b64d(s))).toBe(true)
    const k = await A.signKeyChange(TAB, b64e(bob.pub))
    expect(verify(alice.pub, keyChangeBytes(TAB, b64e(bob.pub)), b64d(k))).toBe(true)
    await expect(A.signRoster('tab-1', 2, '{}')).rejects.toThrow('not a roster')
    await expect(A.signRoster(TAB, 0, '{}')).rejects.toThrow('not a roster')
    await expect(A.signKeyChange(TAB, 'AAAA')).rejects.toThrow('not a key')
  })

  it('runs a session from hello to sealed frames, and refuses a stranger', async () => {
    const hello = await A.hello(toBob)
    const answer = await B.accept(toAlice, hello)
    expect('welcome' in answer).toBe(true)
    expect(await A.welcome(toBob, (answer as { welcome: Record<string, unknown> }).welcome)).toBe(true)
    const sealed = await A.seal(toBob, { type: 'ping' })
    expect(await B.open(toAlice, (sealed as { frame: Record<string, unknown> }).frame)).toEqual({ frame: { type: 'ping' } })
    expect(await B.open(toAlice, { __e2e: { v: 1, k: 'p', n: 99, ct: 'AA' } })).toEqual({ unreadable: true })
    expect(await B.accept({ ...toAlice, peerPub: b64e(newIdentity().pub) }, hello)).toEqual({ refused: true })
    expect(await B.accept(toAlice, { nonsense: 1 })).toEqual({ refused: true })
  })

  it('seals and opens nothing without a session, and forgets one dropped', async () => {
    const other = { ...toBob, machineId: 'carol-pc' }
    expect(await A.seal(other, {})).toEqual({ lost: true })
    expect(await A.open(other, {})).toEqual({ lost: true })
    expect(await A.welcome(other, {})).toBe(false)
    expect(await A.welcome(toBob, { ephemeral: 1 })).toBe(false)
    A.drop(toBob)
    expect(await A.seal(toBob, {})).toEqual({ lost: true })
    A.clear()
  })
})
```

- [ ] **Step 2: Run it to see it fail.** `cd cli && npx vitest run src/gateway/tabKey.spec.ts` → FAIL.

- [ ] **Step 3: Implement `gateway/tabKey.ts`.**

```ts
/**
 * Shared tabs' keys, held here with this machine's E2EE identity, as Share's welcome (observerKey.ts) and the
 * fleet's lane (lane.ts) are: Agent Messages runs in the edge host and holds no credential. One session per peer
 * machine of a shared tab, keyed by tab and machine; a new hello or accept replaces it. No session seals nothing:
 * `lost`, never the frame as it came.
 */
import type { LaneOpened, LaneSealed, TabKey, TabLink } from '../core/api.js'
import { b64d, b64e, sign, type Identity } from '../lib/e2ee/core.js'
import { acceptTabSession, startTabSession, type TabCipher, type TabHello, type TabWelcome } from '../lib/e2ee/tabSession.js'
import { keyChangeBytes, rosterBytes } from '../messages/roster.js'

type Frame = Record<string, unknown>
type Pending = { finish(welcome: TabWelcome, peerPub: string): TabCipher | null }
const TAB = /^[a-f0-9]{24}$/
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export class TabSessions implements TabKey {
  private readonly pending = new Map<string, Pending>()
  private readonly ciphers = new Map<string, TabCipher>()
  constructor(private readonly identity: () => Identity, private readonly machineId: () => string) {}
  private id = (link: TabLink) => `${link.sharedTabId}:${link.machineId}`

  async publicKey(): Promise<string> { return b64e(this.identity().pub) }

  async signRoster(sharedTabId: string, version: number, body: string): Promise<string> {
    if (!TAB.test(sharedTabId) || !Number.isSafeInteger(version) || version < 1) throw new Error('not a roster')
    return b64e(sign(this.identity().priv, rosterBytes(sharedTabId, version, body)))
  }

  async signKeyChange(sharedTabId: string, nextPub: string): Promise<string> {
    if (!TAB.test(sharedTabId) || b64d(nextPub).length !== 32) throw new Error('not a key')
    return b64e(sign(this.identity().priv, keyChangeBytes(sharedTabId, nextPub)))
  }

  async hello(link: TabLink): Promise<Frame> {
    const start = startTabSession(this.identity(), link.sharedTabId, this.machineId(), link.machineId)
    this.ciphers.delete(this.id(link))
    this.pending.set(this.id(link), start)
    return { ...start.hello }
  }

  async welcome(link: TabLink, payload: Frame): Promise<boolean> {
    const cipher = this.pending.get(this.id(link))?.finish({ ephemeral: str(payload.ephemeral), signature: str(payload.signature) }, link.peerPub)
    if (!cipher) return false
    this.pending.delete(this.id(link))
    this.ciphers.set(this.id(link), cipher)
    return true
  }

  async accept(link: TabLink, hello: Frame): Promise<{ welcome: Frame } | { refused: true }> {
    const accepted = acceptTabSession(this.identity(), link.sharedTabId, link.machineId, this.machineId(),
      { ephemeral: str(hello.ephemeral), signature: str(hello.signature) } satisfies TabHello, link.peerPub)
    if (!accepted) return { refused: true }
    this.pending.delete(this.id(link))
    this.ciphers.set(this.id(link), accepted.cipher)
    return { welcome: { ...accepted.welcome } }
  }

  async seal(link: TabLink, frame: Frame): Promise<LaneSealed> {
    const cipher = this.ciphers.get(this.id(link))
    return cipher ? { frame: cipher.seal(frame) as unknown as Frame } : { lost: true }
  }

  async open(link: TabLink, frame: Frame): Promise<LaneOpened> {
    const cipher = this.ciphers.get(this.id(link))
    if (!cipher) return { lost: true }
    const plain = cipher.open(frame)
    return plain ? { frame: plain } : { unreadable: true }
  }

  drop(link: TabLink): void { this.pending.delete(this.id(link)); this.ciphers.delete(this.id(link)) }

  /** The gateway is stopping: every session goes with it. */
  clear(): void { this.pending.clear(); this.ciphers.clear() }
}
```

`signKeyChange('AAAA')` must reject: `b64d('AAAA')` is 3 bytes, so the length check throws `not a key`.

- [ ] **Step 4: Run it to see it pass.** `cd cli && npx vitest run src/gateway/tabKey.spec.ts --coverage --coverage.include=src/gateway/tabKey.ts` → PASS, 100%.

- [ ] **Step 5: Wire the port, following `observerKey` file by file.** For each file below, find the `observerKey`
  (or `OBSERVER_KEY_OFF`, `GATEWAY_CALLS.observerKey`) occurrence and add `tabKey` beside it with the same shape:
  1. `core/api.ts`: paste the Interfaces block above after `LANE_OFF`; add `tabKey: TabKey` to `account` (beside
     `observerKey`, line ≈245) and to `GatewayOps` (≈1387); `tabKey: TAB_KEY_OFF` in `ACCOUNT_BACKEND_OFF`; thread it
     through `CoreApiDeps` and `createCoreApi`'s `account`; add `'tab_key'` to `MESSAGES_QUERIES`.
  2. `lib/gatewayWire.ts`: `tabKey: 'gateway_tab_key'` in `GATEWAY_CALLS`.
  3. `gateway/start.ts`: `const tabKey = new TabSessions(() => relayIdentityStore.getIdentity(), () => host.machineId())`
     beside `observerKey`; put it on the ops; call `tabKey.clear()` where `lane.clear()` runs at stop.
  4. `gateway/gatewayProcess.ts`: a handler for `GATEWAY_CALLS.tabKey` that takes `{ method, args }` and calls
     `ops.tabKey[method](...args)` for the nine method names only, refusing any other name.
  5. `core/gatewayLink.ts`: `tabKeyOps(): TabKey`, each method `deps.call(GATEWAY_CALLS.tabKey, { method, args }, LANE_WAIT_MS)`,
     with `drop` fire-and-forget; put it on the ops.
  6. `core/main.ts`: forward `tabKey` to the core API exactly as `observerKey` is forwarded (≈864).
  7. `core/messagesLink.ts`: in `answer()`, `case 'tab_key'`: call `core.account.tabKey[method](...args)` for the
     nine names, else answer `{ error: 'UNKNOWN_METHOD' }`.
  8. `services/messagesProcess.ts`: build `askTabKey: TabKey` whose methods `ask('tab_key', { method, args })`, and
     pass `account: { ...base.account, tabKey: askTabKey }` (only the messages process gets it; experiments keep
     `TAB_KEY_OFF`).
  9. `testing/fakeCore.ts`: `tabKey: TAB_KEY_OFF`.

- [ ] **Step 6: Test the wiring.** Add one case each, copying the neighbouring observerKey case and renaming:
  `gatewayLink.spec.ts` ("tabKey calls the gateway with its method and arguments"), `messagesLink.spec.ts`
  ("answers tab_key for the nine methods and refuses others"), `messagesProcess.spec.ts` ("asks the core for
  tab_key"), `gatewayProcess.spec.ts` ("dispatches gateway_tab_key to TabSessions"). Run:

```bash
cd cli && npm run test:core && npx vitest run src/gateway src/lib/gatewayWire.spec.ts src/architecture.spec.ts && npm run typecheck
```

Expected: all pass, core at 100%, `architecture.spec.ts` green (no new import from an edge folder into the core).

- [ ] **Step 7: Leave it in the working tree** and list the files in the task report.

---

### Task 5: Backend records: shares, invitations, members

**Files:**
- Modify: `backend/prisma/schema.prisma` (three models after `AgentMessageTab`, ≈825)
- Create: `backend/src/lib/agentMessageShares.ts`
- Test: `backend/src/lib/agentMessageShares.test.ts`
- Modify: `backend/package.json` (script `test:agent-messages`)

**Interfaces:**
- Consumes: `prisma`, `machineAlive` (`lib/prisma.ts:16`), `Prisma.PrismaClientKnownRequestError`.
- Produces:
  - `sharedTabId(ownerUserId: string, tabId: string): string`
  - `putRoster(input: { ownerUserId; tabId; machineId; version; roster; autonomousEnv }): Promise<{ sharedTabId: string; version: number } | { error: 'FORBIDDEN' | 'STALE_ROSTER' | 'ROSTER_TOO_LARGE' }>`
  - `listShares(userId: string, autonomousEnv: string): Promise<ShareView[]>`
  - `invite(input: { ownerUserId; ownerEmail; sharedTabId; email; expiresAt: Date; autonomousEnv }): Promise<{ id: string } | { error: 'FORBIDDEN' | 'SELF_INVITE' | 'TAB_FULL' }>`
  - `revokeInvite(ownerUserId, inviteId): Promise<boolean>`
  - `pendingInvites(email, autonomousEnv): Promise<InviteView[]>`
  - `accept(user: { sub; email }, inviteId, now: Date): Promise<{ sharedTabId: string } | { error: 'NOT_FOUND' | 'EXPIRED' }>`
  - `removeMember(actorUserId, sharedTabId, userId): Promise<boolean>`
  - `stopSharing(ownerUserId, sharedTabId): Promise<boolean>`
  - `admits(userId, machineId, sharedTabId, autonomousEnv): Promise<boolean>` (for the relay, Task 7)
  - `type ShareView = { sharedTabId; tabId?: string; owner: boolean; ownerEmail; ownerMachineId; version; roster: unknown; members?: { userId; email; acceptedAt }[]; invites?: { id; email; expiresAt }[] }`
  - `type InviteView = { id; sharedTabId; ownerEmail; ownerMachineId; expiresAt }`

- [ ] **Step 1: Add the models.**

```prisma
/// A tab its owner shared with other accounts (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md).
/// `roster` is the owner's signed blob, stored and never read: members verify it against the owner's key.
model AgentMessageShare {
  id             String    @id @map("_id") // sharedTabId: sha256(['amsg-share', ownerUserId, tabId])[:24]
  ownerUserId    String
  ownerMachineId String
  tabId          String
  autonomousEnv  String
  rosterVersion  Int       @default(0)
  roster         Json?
  stoppedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  @@unique([ownerUserId, tabId])
  @@map("agent_message_shares")
}

model AgentMessageInvite {
  id             String    @id @map("_id")
  shareId        String
  ownerUserId    String
  ownerMachineId String
  email          String
  autonomousEnv  String
  expiresAt      DateTime
  acceptedBy     String?
  acceptedAt     DateTime?
  revokedAt      DateTime?
  createdAt      DateTime  @default(now())
  @@unique([shareId, email])
  @@index([email, autonomousEnv, expiresAt])
  @@map("agent_message_invites")
}

model AgentMessageMember {
  id         String    @id @map("_id") // sha256(['amsg-member', shareId, userId])[:24]
  shareId    String
  userId     String
  email      String
  inviteId   String
  acceptedAt DateTime  @default(now())
  removedAt  DateTime?
  @@index([userId])
  @@index([shareId])
  @@map("agent_message_members")
}
```

Run: `cd backend && npx prisma generate` → exit 0.

- [ ] **Step 2: Write the failing test.** `backend/src/lib/agentMessageShares.test.ts` mocks Prisma as
  `routes/agentMessages.test.ts:4–10` does (`vi.hoisted` + `vi.mock('./prisma.js', () => ({ prisma: mocks.prisma, machineAlive: {} }))`),
  with `agentMessageShare`, `agentMessageInvite`, `agentMessageMember`, `machine` and `user` each having `findFirst`,
  `findUnique`, `findMany`, `updateMany`, `create`, `upsert`, `update`, `count` as `vi.fn()`. One `it` per row; each
  sets the mocks in the "given" column, calls the function, and asserts the result and the Prisma `where` shown in
  Step 3:

| Case | Given | Call | Expect |
|---|---|---|---|
| ids differ per account | – | `sharedTabId('alice','tab-1')`, `sharedTabId('bob','tab-1')` | both match `/^[a-f0-9]{24}$/`, not equal |
| roster too large | – | `putRoster({ roster: { pad: 'x'.repeat(262144) } })` | `{ error: 'ROSTER_TOO_LARGE' }`, no Prisma call |
| not the owner's machine | `machine.findFirst` → null | `putRoster` | `{ error: 'FORBIDDEN' }` |
| first roster | `findUnique` → null, `create` ok | `putRoster(v1)` | `{ sharedTabId, version: 1 }` |
| first-write race | `findUnique` → null, `create` rejects P2002, `updateMany` → `{count:1}` | `putRoster(v1)` | `{ sharedTabId, version: 1 }` |
| other error on create | `create` rejects `new Error('x')` | `putRoster` | rejects `x` |
| another owner machine | `findUnique` → `{ ownerMachineId: 'other' }` | `putRoster` | `{ error: 'FORBIDDEN' }` |
| stale | `findUnique` → held v3, `updateMany` → `{count:0}` | `putRoster(v2)` | `{ error: 'STALE_ROSTER' }` |
| self invite | – | `invite({ email: ' Alice@X.io ', ownerEmail: 'alice@x.io' })` | `{ error: 'SELF_INVITE' }` |
| not the owner's share | `agentMessageShare.findFirst` → null | `invite` | `{ error: 'FORBIDDEN' }` |
| full | members 5 + pending 3 | `invite` | `{ error: 'TAB_FULL' }` |
| invite | members 1 + pending 0, `upsert` → `{ id: 'i1' }` | `invite` | `{ id: 'i1' }`, email lower-cased in `where` |
| revoke | `updateMany` → `{count:1}` then `{count:0}` | `revokeInvite` twice | `true`, then `false` |
| pending list | 1 row, `user.findMany` → owner email | `pendingInvites('BOB@x.io')` | one view, ISO `expiresAt`, `where.email` = `bob@x.io` |
| accept other email | `findFirst` → null | `accept({ email: 'eve@x.io' })` | `{ error: 'NOT_FOUND' }` |
| accept expired | row `expiresAt` in the past | `accept` | `{ error: 'EXPIRED' }`, no update |
| accept | row valid | `accept` | `{ sharedTabId }`, invite updated, member upserted with `removedAt: null` |
| remove by stranger | share owner `alice` | `removeMember('eve', s, 'bob')` | `false` |
| remove by owner / by self | – | `removeMember('alice', s, 'bob')`, `removeMember('bob', s, 'bob')` | `true` (count 1) |
| remove missing share | `findUnique` → null | `removeMember` | `false` |
| stop | `updateMany` → `{count:1}` | `stopSharing` | `true` |
| list | one owned share, one joined | `listShares('alice')` | owned view has `tabId`, `members`, `invites`; joined view has neither |
| admits | owner; active member; removed member; stopped share; machine not owned | `admits` | `true`, `true`, `false`, `false`, `false` |

- [ ] **Step 3: Implement** `backend/src/lib/agentMessageShares.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma, machineAlive } from './prisma.js'

/**
 * Shared tabs across accounts: the owner's signed roster, stored and never read; invitations by email; and who
 * accepted. A desk tab's id is unique only within its account, so a shared tab is named everywhere else by an id
 * derived from the owner and the tab, which two accounts' `tab-1` never share.
 */
const hash = (...parts: string[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const sharedTabId = (ownerUserId: string, tabId: string): string => hash('amsg-share', ownerUserId, tabId)
const memberId = (shareId: string, userId: string): string => hash('amsg-member', shareId, userId)

export const ROSTER_MAX_BYTES = 256 * 1024
export const MAX_MEMBERS = 8

const owned = (userId: string, machineId: string, autonomousEnv: string) =>
  prisma.machine.findFirst({ where: { machineId, userId, autonomousEnv, ...machineAlive }, select: { machineId: true } })

export async function putRoster(input: { ownerUserId: string; tabId: string; machineId: string; version: number;
  roster: unknown; autonomousEnv: string }) {
  if (Buffer.byteLength(JSON.stringify(input.roster)) > ROSTER_MAX_BYTES) return { error: 'ROSTER_TOO_LARGE' as const }
  if (!await owned(input.ownerUserId, input.machineId, input.autonomousEnv)) return { error: 'FORBIDDEN' as const }
  const id = sharedTabId(input.ownerUserId, input.tabId)
  const held = await prisma.agentMessageShare.findUnique({ where: { id }, select: { ownerMachineId: true, rosterVersion: true, stoppedAt: true } })
  // The roster names the machine that signs it; another machine of the owner putting one would be a second
  // authority, which members could not tell apart from a forgery.
  if (held && held.ownerMachineId !== input.machineId) return { error: 'FORBIDDEN' as const }
  const data = { roster: input.roster as Prisma.InputJsonValue, rosterVersion: input.version, stoppedAt: null }
  if (!held) {
    try {
      await prisma.agentMessageShare.create({ data: { id, ownerUserId: input.ownerUserId, ownerMachineId: input.machineId,
        tabId: input.tabId, autonomousEnv: input.autonomousEnv, ...data } })
      return { sharedTabId: id, version: input.version }
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    }
  }
  const { count } = await prisma.agentMessageShare.updateMany({ where: { id, rosterVersion: { lt: input.version } }, data })
  return count ? { sharedTabId: id, version: input.version } : { error: 'STALE_ROSTER' as const }
}

export async function invite(input: { ownerUserId: string; ownerEmail: string; sharedTabId: string; email: string;
  expiresAt: Date; autonomousEnv: string }) {
  const email = input.email.trim().toLowerCase()
  if (email === input.ownerEmail.trim().toLowerCase()) return { error: 'SELF_INVITE' as const }
  const share = await prisma.agentMessageShare.findFirst({ where: { id: input.sharedTabId, ownerUserId: input.ownerUserId, stoppedAt: null } })
  if (!share) return { error: 'FORBIDDEN' as const }
  const [members, pending] = await Promise.all([
    prisma.agentMessageMember.count({ where: { shareId: share.id, removedAt: null } }),
    prisma.agentMessageInvite.count({ where: { shareId: share.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ])
  if (members + pending >= MAX_MEMBERS) return { error: 'TAB_FULL' as const }
  const row = await prisma.agentMessageInvite.upsert({
    where: { shareId_email: { shareId: share.id, email } },
    create: { id: randomUUID(), shareId: share.id, ownerUserId: input.ownerUserId, ownerMachineId: share.ownerMachineId,
      email, autonomousEnv: input.autonomousEnv, expiresAt: input.expiresAt },
    update: { expiresAt: input.expiresAt, revokedAt: null, acceptedAt: null, acceptedBy: null },
  })
  return { id: row.id }
}

export async function revokeInvite(ownerUserId: string, inviteId: string): Promise<boolean> {
  const { count } = await prisma.agentMessageInvite.updateMany({ where: { id: inviteId, ownerUserId, revokedAt: null }, data: { revokedAt: new Date() } })
  return count > 0
}

export async function pendingInvites(email: string, autonomousEnv: string) {
  const rows = await prisma.agentMessageInvite.findMany({ where: { email: email.trim().toLowerCase(), autonomousEnv,
    acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
  const owners = await prisma.user.findMany({ where: { id: { in: rows.map(r => r.ownerUserId) } }, select: { id: true, email: true } })
  const emailOf = new Map(owners.map(o => [o.id, o.email]))
  return rows.map(r => ({ id: r.id, sharedTabId: r.shareId, ownerEmail: emailOf.get(r.ownerUserId) ?? '',
    ownerMachineId: r.ownerMachineId, expiresAt: r.expiresAt.toISOString() }))
}

export async function accept(user: { sub: string; email: string }, inviteId: string, now = new Date()) {
  const row = await prisma.agentMessageInvite.findFirst({ where: { id: inviteId, email: user.email.trim().toLowerCase(), revokedAt: null } })
  if (!row) return { error: 'NOT_FOUND' as const }
  if (row.expiresAt <= now) return { error: 'EXPIRED' as const }
  await prisma.agentMessageInvite.update({ where: { id: row.id }, data: { acceptedBy: user.sub, acceptedAt: now } })
  const id = memberId(row.shareId, user.sub)
  await prisma.agentMessageMember.upsert({ where: { id },
    create: { id, shareId: row.shareId, userId: user.sub, email: row.email, inviteId: row.id, acceptedAt: now },
    update: { removedAt: null, inviteId: row.id, acceptedAt: now } })
  return { sharedTabId: row.shareId }
}

export async function removeMember(actorUserId: string, shareId: string, userId: string): Promise<boolean> {
  const share = await prisma.agentMessageShare.findUnique({ where: { id: shareId }, select: { ownerUserId: true } })
  if (!share || (actorUserId !== share.ownerUserId && actorUserId !== userId)) return false
  const { count } = await prisma.agentMessageMember.updateMany({ where: { shareId, userId, removedAt: null }, data: { removedAt: new Date() } })
  return count > 0
}

export async function stopSharing(ownerUserId: string, shareId: string): Promise<boolean> {
  const { count } = await prisma.agentMessageShare.updateMany({ where: { id: shareId, ownerUserId, stoppedAt: null }, data: { stoppedAt: new Date() } })
  return count > 0
}

export async function listShares(userId: string, autonomousEnv: string) {
  const memberships = await prisma.agentMessageMember.findMany({ where: { userId, removedAt: null }, select: { shareId: true } })
  const shares = await prisma.agentMessageShare.findMany({ where: { autonomousEnv, stoppedAt: null,
    OR: [{ ownerUserId: userId }, { id: { in: memberships.map(m => m.shareId) } }] } })
  const owners = await prisma.user.findMany({ where: { id: { in: shares.map(s => s.ownerUserId) } }, select: { id: true, email: true } })
  const emailOf = new Map(owners.map(o => [o.id, o.email]))
  return Promise.all(shares.map(async s => {
    const view = { sharedTabId: s.id, owner: s.ownerUserId === userId, ownerEmail: emailOf.get(s.ownerUserId) ?? '',
      ownerMachineId: s.ownerMachineId, version: s.rosterVersion, roster: s.roster }
    if (!view.owner) return view
    const [members, invites] = await Promise.all([
      prisma.agentMessageMember.findMany({ where: { shareId: s.id, removedAt: null }, select: { userId: true, email: true, acceptedAt: true } }),
      prisma.agentMessageInvite.findMany({ where: { shareId: s.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, expiresAt: true } }),
    ])
    return { ...view, tabId: s.tabId,
      members: members.map(m => ({ userId: m.userId, email: m.email, acceptedAt: m.acceptedAt.toISOString() })),
      invites: invites.map(i => ({ id: i.id, email: i.email, expiresAt: i.expiresAt.toISOString() })) }
  }))
}

export async function admits(userId: string, machineId: string, shareId: string, autonomousEnv: string): Promise<boolean> {
  if (!await owned(userId, machineId, autonomousEnv)) return false
  const share = await prisma.agentMessageShare.findFirst({ where: { id: shareId, autonomousEnv, stoppedAt: null }, select: { ownerUserId: true } })
  if (!share) return false
  if (share.ownerUserId === userId) return true
  return !!await prisma.agentMessageMember.findFirst({ where: { shareId, userId, removedAt: null }, select: { id: true } })
}
```

- [ ] **Step 4: Add the gate.** In `backend/package.json` scripts, mirroring `package.json:25`:

```json
"test:agent-messages": "vitest run src/lib/agentMessageShares.test.ts src/routes/agentMessages.test.ts src/lib/agentMessagesWs.test.ts --coverage --coverage.include=src/lib/agentMessageShares.ts --coverage.include=src/routes/agentMessages.ts --coverage.include=src/lib/agentMessagesWs.ts --coverage.thresholds.lines=100 --coverage.thresholds.statements=100 --coverage.thresholds.functions=100 --coverage.thresholds.branches=100"
```

- [ ] **Step 5: Run.** `cd backend && npx vitest run src/lib/agentMessageShares.test.ts --coverage --coverage.include=src/lib/agentMessageShares.ts`
  → PASS, 100%. `npm run typecheck` (or `npx tsc --noEmit`) → exit 0.

- [ ] **Step 6: Leave it in the working tree** and list the files in the task report.

---

### Task 6: Backend routes

**Files:**
- Modify: `backend/src/routes/agentMessages.ts`
- Modify: `backend/src/routes/agentMessages.test.ts`
- Modify: `backend/src/lib/bus.ts` (`publishAgentMessageShareChanged`, `subscribeAgentMessageShareChanged` beside
  `publishShareChanged` at 214–219)

**Interfaces:**
- Consumes: Task 5's functions; `publishDeskChanged`; `sendSuccess`, `sendError`, `validateBody`.
- Produces (HTTP):

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `PUT /api/agent-messages/shares/:tabId/roster` | `{ machineId, version, roster }` | `{ sharedTabId, version }` | 403 `FORBIDDEN`, 409 `STALE_ROSTER`, 413 `ROSTER_TOO_LARGE`, 400 `INVALID_TAB` |
| `GET /api/agent-messages/shares` | – | `{ shares: ShareView[] }` | – |
| `POST /api/agent-messages/shares/:sharedTabId/invites` | `{ email, days: 7 \| 30 \| 90 }` | `{ id }` | 400 `SELF_INVITE`, 403 `FORBIDDEN`, 409 `TAB_FULL` |
| `DELETE /api/agent-messages/invites/:id` | – | `{ revoked: true }` | 404 `NOT_FOUND` |
| `GET /api/agent-messages/invites` | – | `{ invites: InviteView[] }` | – |
| `POST /api/agent-messages/invites/:id/accept` | – | `{ sharedTabId }` | 404 `NOT_FOUND`, 410 `EXPIRED` |
| `DELETE /api/agent-messages/shares/:sharedTabId/members/:userId` | – | `{ removed: true }` | 403 `FORBIDDEN` |
| `DELETE /api/agent-messages/shares/:sharedTabId` | – | `{ stopped: true }` | 403 `FORBIDDEN` |

Every change publishes `publishAgentMessageShareChanged(sharedTabId)` (the relay re-checks admission) and
`publishDeskChanged(userId, { revision: 0 })` for the owner and each affected account (the daemons re-read shares on
`desk_changed`, so 1a needs no new push frame). For an invitation, the invitee's account is looked up by email as
`harnessShares.ts:31–38` `tellRecipient` does, and told only if it exists.

- [ ] **Step 1: Write the failing tests.** Extend `routes/agentMessages.test.ts` with a `vi.mock('../lib/agentMessageShares.js')`
  and one `it` per row above: authentication required (401 without a token); each success shape; each error code
  and status; that `publishAgentMessageShareChanged` and `publishDeskChanged` are called with the right ids; that an
  invitation's `days` outside 7/30/90 is a 400; that a `:sharedTabId` not matching `/^[a-f0-9]{24}$/` is a 400
  `INVALID_TAB`; that `accept` passes `req.user` (sub and email) through unchanged.

- [ ] **Step 2: Run them to see them fail.** `cd backend && npx vitest run src/routes/agentMessages.test.ts` → the new cases FAIL (404).

- [ ] **Step 3: Implement the routes** in `agentMessagesRoutes`, each a thin call into Task 5 (no logic in the route
  beyond validation and the error mapping). The error map:

```ts
const STATUS: Record<string, number> = { FORBIDDEN: 403, STALE_ROSTER: 409, ROSTER_TOO_LARGE: 413, SELF_INVITE: 400,
  TAB_FULL: 409, NOT_FOUND: 404, EXPIRED: 410 }
const MESSAGE: Record<string, string> = {
  FORBIDDEN: 'Only the tab\'s owner, from the computer that shares it, can do that.',
  STALE_ROSTER: 'A newer roster is already shared.', ROSTER_TOO_LARGE: 'The roster is too large.',
  SELF_INVITE: 'You are already in this tab.', TAB_FULL: 'This tab has 8 people already.',
  NOT_FOUND: 'This invitation is no longer available.', EXPIRED: 'This invitation expired.',
}
const fail = (reply: FastifyReply, code: string) => sendError(reply, MESSAGE[code], code, STATUS[code])
```

and in `bus.ts`:

```ts
/** A shared tab changed (roster, member, stop): its relay sockets re-check who may stay. No content. */
export function subscribeAgentMessageShareChanged(id: string, cb: () => void): Promise<() => void> {
  return addSub(`amsg-share:${id}`, cb)
}
export function publishAgentMessageShareChanged(id: string): Promise<number> {
  return safePublish(`amsg-share:${id}`, '{}')
}
```

- [ ] **Step 4: Run.** `cd backend && npx vitest run src/routes/agentMessages.test.ts --coverage --coverage.include=src/routes/agentMessages.ts` → PASS, 100%.

- [ ] **Step 5: Leave it in the working tree** and list the files in the task report.

---

### Task 7: Backend blind relay `/api/agent-messages-ws`

**Files:**
- Create: `backend/src/lib/agentMessagesWs.ts`, Test: `backend/src/lib/agentMessagesWs.test.ts`
- Modify: `backend/src/server.ts` (upgrade dispatch beside `/api/observer-ws`, 95–98)
- Modify: `backend/src/lib/wsServer.ts` (`WS_LIMITS.agentMessages = 256 * 1024`)
- Modify: `backend/src/lib/bus.ts` (`publishTabRelay`, `subscribeTabRelay`)

**Interfaces:**
- Consumes: `admits` (Task 5); `subscribeAgentMessageShareChanged` (Task 6); `authenticateAccessToken`,
  `extractKey`, `parseAutonomousEnvironment`, `createWss`, `trackSocketLiveness`, `createOrderedInbox`,
  `guardedSendJson` as `observerWs.ts` uses them.
- Produces (wire, client → backend): `{ type: 'amsg_frame', to: string, payload: { __e2e: … } | { hello: … } | { welcome: … } }`.
  Backend → client: `{ type: 'amsg_frame', from: { machineId, userId }, payload }`,
  `{ type: 'amsg_undeliverable', to }`, `{ type: 'amsg_ready' }`. Close codes: 4403 not admitted, 1008 abuse,
  1013 unavailable, 4409 replaced by a newer socket for the same `(share, machine)`.

- [ ] **Step 1: Write the failing test** `agentMessagesWs.test.ts`, mirroring `observerWs.test.ts:1–40` (a fake
  `EventEmitter` socket, `createWss().handleUpgrade` mocked, fake timers, `bus.js` and `agentMessageShares.js`
  mocked). Cases:
  1. No token, or `share` not 24 hex, or no `machine`: the socket is destroyed before upgrade.
  2. `admits` false: upgraded then closed `4403`.
  3. Admitted: sends `amsg_ready`; subscribes `subscribeTabRelay(share, machine)` and the share-changed channel.
  4. A client frame `{type:'amsg_frame', to:'bob-mini', payload:{…}}` publishes to `(share, 'bob-mini')` with
     `from` stamped `{ machineId: <socket's machine>, userId: <token's sub> }`, overriding any `from` the client sent.
  5. Publish returning 0: replies `{ type: 'amsg_undeliverable', to: 'bob-mini' }`.
  6. A message on its channel is sent to the socket as `amsg_frame` unchanged.
  7. A binary frame, a frame over 128 KiB, more than 20 frames in a second, or an unknown `type`: closed `1008`.
  8. Share-changed with `admits` now false: closed `4403`; the 5-second re-check does the same.
  9. A second socket for the same `(share, machine)`: the first is closed `4409`.

- [ ] **Step 2: Run to see it fail.** `cd backend && npx vitest run src/lib/agentMessagesWs.test.ts` → FAIL.

- [ ] **Step 3: Implement**, following `observerWs.ts` line for line where it applies:

```ts
/**
 * The blind relay between daemons of different accounts in a shared tab
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages across accounts").
 * It routes by shared tab and machine, stamps who sent each frame itself, and reads nothing else: frames are sealed
 * between machine keys the owner's roster lists, which this server never sees. Admission is coarse on purpose
 * (the account owns the machine and is the tab's owner or an accepted member); the roster is the authority.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, type RawData } from 'ws'
import { createWss, WS_LIMITS } from './wsServer.js'
import { authenticateAccessToken } from './ssoAuth.js'
import { parseAutonomousEnvironment } from './autonomousEnvironment.js'
import { extractKey } from '../utils/crypto.js'
import { admits } from './agentMessageShares.js'
import { publishTabRelay, subscribeTabRelay, subscribeAgentMessageShareChanged } from './bus.js'
import { guardedSendJson } from './wsSend.js'
import { trackSocketLiveness } from './hub.js'
import { createOrderedInbox } from './orderedInbox.js'

const wss = createWss(WS_LIMITS.agentMessages, { echoFirstProtocol: true })
const MAX_FRAME = 128 * 1024
const PER_SECOND = 20
const live = new Map<string, WebSocket>()

export function handleAgentMessagesUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  void (async () => {
    const token = extractKey(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const share = url.searchParams.get('share') ?? '', machine = url.searchParams.get('machine') ?? ''
    if (!token || !/^[a-f0-9]{24}$/.test(share) || !machine || machine.length > 128) { socket.destroy(); return }
    const env = parseAutonomousEnvironment(url.searchParams.get('autonomousEnv'))
    const user = await authenticateAccessToken(token, env, { allowHarnessSession: 'computer' })
    const allowed = !!user && await admits(user.sub, machine, share, env)
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, ws => {
      if (!allowed || !user) { ws.close(4403, 'Not in this shared tab'); return }
      void attach(ws, user.sub, share, machine, env).catch(() => ws.close(1013, 'Shared tab temporarily unavailable'))
    })
  })().catch(() => { if (!socket.destroyed) socket.destroy() })
}

async function attach(ws: WebSocket, userId: string, share: string, machine: string, env: ReturnType<typeof parseAutonomousEnvironment>) {
  const key = `${share}:${machine}`
  live.get(key)?.close(4409, 'Replaced by a newer connection')
  live.set(key, ws)
  const send = (frame: unknown) => guardedSendJson(ws, frame, 'must')
  const disposers: Array<() => void> = [trackSocketLiveness(ws)]
  let closed = false
  ws.once('close', () => { closed = true; if (live.get(key) === ws) live.delete(key); for (const d of disposers.splice(0)) d() })
  const keep = (dispose: () => void) => { if (closed) dispose(); else disposers.push(dispose) }
  const check = async () => {
    try { if (!await admits(userId, machine, share, env)) ws.close(4403, 'Not in this shared tab') }
    catch { ws.close(1013, 'Shared tab temporarily unavailable') }
  }
  const timer = setInterval(() => { void check() }, 5000); timer.unref(); disposers.push(() => clearInterval(timer))
  keep(await subscribeAgentMessageShareChanged(share, () => { void check() }))
  keep(await subscribeTabRelay(share, machine, message => { if (!closed) send({ type: 'amsg_frame', ...(message as object) }) }))
  if (closed) return
  send({ type: 'amsg_ready' })
  let windowStart = Date.now(), count = 0
  const inbox = createOrderedInbox<{ raw: RawData; binary: boolean }>(async ({ raw, binary }) => {
    if (closed) return
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0 }
    const size = Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as Buffer).byteLength
    if (binary || size > MAX_FRAME || ++count > PER_SECOND) { ws.close(1008, 'Invalid shared tab message'); return }
    let frame: { type?: string; to?: unknown; payload?: unknown }
    try { frame = JSON.parse(raw.toString()) } catch { ws.close(1008, 'Invalid shared tab message'); return }
    if (frame.type !== 'amsg_frame' || typeof frame.to !== 'string' || !frame.to || frame.to.length > 128
      || !frame.payload || typeof frame.payload !== 'object') { ws.close(1008, 'Invalid shared tab message'); return }
    const delivered = await publishTabRelay(share, frame.to, { from: { machineId: machine, userId }, payload: frame.payload })
    if (!delivered) send({ type: 'amsg_undeliverable', to: frame.to })
  }, () => ws.close(1013, 'Shared tab temporarily unavailable'), () => ws.close(1008, 'Too many shared tab messages'))
  ws.on('message', (raw, binary) => inbox.enqueue({ raw, binary }))
}
```

In `bus.ts`:

```ts
/** Frames between daemons of a shared tab, by tab and machine: sealed, never read here. */
export function subscribeTabRelay(share: string, machineId: string, cb: (msg: unknown) => void): Promise<() => void> {
  return addSub(`amsg:${share}:${machineId}`, cb as Cb)
}
export function publishTabRelay(share: string, machineId: string, msg: unknown): Promise<number> {
  return safePublish(`amsg:${share}:${machineId}`, JSON.stringify(msg))
}
```

In `server.ts`, beside the observer branch:

```ts
if (path === '/api/agent-messages-ws') {
  handleAgentMessagesUpgrade(req, socket, head)
  return
}
```

If `authenticateAccessToken` takes no third argument in this backend, drop `{ allowHarnessSession: 'computer' }`
and note it; `adapterWs.ts:126–186` shows what daemons pass.

- [ ] **Step 4: Run.** `cd backend && npm run test:agent-messages` → PASS, 100% for all three files; `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Leave it in the working tree** and list the files in the task report.

---

### Task 8: Gateway socket to the relay

**Files:**
- Create: `cli/src/gateway/tabRelay.ts`, Test: `cli/src/gateway/tabRelay.spec.ts`
- Modify: `cli/src/core/api.ts` (`GatewayOps.tabRelay`, `GatewayEvents.tabFrame`, fallback `TAB_RELAY_OFF`)
- Modify: `cli/src/gateway/start.ts`, `cli/src/gateway/gatewayProcess.ts`, `cli/src/core/gatewayLink.ts`,
  `cli/src/core/main.ts`, `cli/src/core/messagesLink.ts` (forward `tabFrame` as `service_event` kind `tab_frame`),
  `cli/src/services/messagesProcess.ts` (hear `tab_frame`; `relay` calls through `ask('tab_relay', …)`)
- Modify: `cli/src/core/messagesLink.ts` `answer()` gains `case 'tab_relay'` for `open`, `send`, `close`

**Interfaces:**
- Consumes: `watchSocketLiveness`, `BACKEND_IDLE_DEADLINE_MS` (`lib/wsLiveness.ts`), the gateway's token source
  (`host.tokens.accessToken`), `env.BACKEND_WS_URL`, `host.autonomousEnv`; reconnect shape from
  `gateway/upstream.ts` 144–270.
- Produces:

```ts
// core/api.ts
export interface TabRelay {
  /** Keep a socket to the shared tab's relay open (idempotent). */
  open(sharedTabId: string): Promise<void>
  /** Send a frame to a machine of the shared tab; false when no socket is open for the tab. */
  send(sharedTabId: string, to: string, payload: Record<string, unknown>): Promise<boolean>
  /** Close the tab's socket and stop reconnecting. */
  close(sharedTabId: string): void
}
export const TAB_RELAY_OFF: TabRelay = { open: async () => {}, send: async () => false, close: () => {} }
// GatewayEvents gains:
tabFrame(event: { sharedTabId: string; from?: { machineId: string; userId: string }; payload?: Record<string, unknown>;
  undeliverable?: string; closed?: { code: number; reason: string } }): void
```

- [ ] **Step 1: Write the failing test** `tabRelay.spec.ts` against a real local `ws` `WebSocketServer` on port 0
  (as `sharing/relay.spec.ts` does). Cases:
  1. `open` dials `${base}/api/agent-messages-ws?share=…&machine=…&autonomousEnv=…` with the token as the first
     subprotocol; a second `open` for the same tab does not dial again.
  2. `send` writes `{ type: 'amsg_frame', to, payload }` once the server sent `amsg_ready`; before it, `send` waits
     up to 5 s for ready, then resolves false.
  3. A server `amsg_frame` emits `tabFrame({ sharedTabId, from, payload })`; `amsg_undeliverable` emits
     `tabFrame({ sharedTabId, undeliverable: to })`.
  4. A close with 4403 emits `tabFrame({ sharedTabId, closed: { code: 4403, reason } })` and does not reconnect.
  5. Any other close reconnects with backoff `1000 * 2 ** min(attempts, 5)` ms capped at 30 s (fake timers), and a
     401 on upgrade refreshes the token once (`accessToken({ force: true, failedToken })`) before the next dial.
  6. `close(tab)` stops reconnecting; `closeAll()` closes every socket.

- [ ] **Step 2: Run it to see it fail.** `cd cli && npx vitest run src/gateway/tabRelay.spec.ts` → FAIL.

- [ ] **Step 3: Implement** `gateway/tabRelay.ts` as a class `TabRelaySockets implements TabRelay` with
  `constructor(deps: { base: string; environment: string; machineId: () => string; accessToken(o?: { force?: boolean; failedToken?: string }): Promise<string>; emit: GatewayEvents['tabFrame']; now?: () => number })`,
  a `Map<string, { ws: WebSocket | null; ready: boolean; attempts: number; timer: NodeJS.Timeout | null; closed: boolean; waiters: Array<(ok: boolean) => void> }>`,
  `dial(tab)` building the URL above with `new WebSocket(url, [token], { handshakeTimeout: 10_000, maxPayload: 256 * 1024 })`,
  `watchSocketLiveness(ws, { peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS, onIdle, onWake })` on open (copy the
  logging lines from `sharing/relay.ts:46–51`, prefix `[shared-tabs]`), `unexpected-response` with status 401 →
  refresh then redial, and the backoff above. Header comment: why a long-lived socket per shared tab (one per tab
  keeps admission per tab, which the relay checks), why 4403 stops (the account left or was removed; reconnecting
  would only be refused again).

- [ ] **Step 4: Wire** `tabRelay` exactly as Task 4 wired `tabKey` (api → gatewayWire `GATEWAY_CALLS.tabRelay =
  'gateway_tab_relay'` → start.ts constructs `new TabRelaySockets({ base: env.BACKEND_WS_URL, environment:
  host.autonomousEnv, machineId: () => host.machineId(), accessToken: o => host.tokens.accessToken(o), emit: e =>
  events.tabFrame(e) })` and calls `closeAll()` at stop → gatewayProcess handler → gatewayLink ops → main.ts →
  messagesLink `case 'tab_relay'` and forwarding `tabFrame` to the messages process as `service_event`
  `{ kind: 'tab_frame', event }` → messagesProcess builds `relay: TabRelay` from `ask('tab_relay', …)` and passes the
  events to the service as `options.onTabFrame`). Add one wiring case per file as in Task 4 Step 6.

- [ ] **Step 5: Run.** `cd cli && npx vitest run src/gateway/tabRelay.spec.ts --coverage --coverage.include=src/gateway/tabRelay.ts && npm run test:core && npm run typecheck` → PASS.

- [ ] **Step 6: Leave it in the working tree** and list the files in the task report.

---

### Task 9: Owner and member operations (`messages/sharedTabs.ts`)

**Files:**
- Create: `cli/src/messages/sharedTabs.ts`, Test: `cli/src/messages/sharedTabs.spec.ts`
- Modify: `cli/src/messages/service.ts` (construct `SharedTabs` while awake; route `onTabFrame`; new actions in the
  `agent_messages` switch at 680–686)

**Interfaces:**
- Consumes: `TabKey` (Task 4), `TabRelay` (Task 8), `RosterStore` (Task 3), `encodeRoster`, `Roster`,
  `RosterHarness`, `ROSTER_LIMITS` (Task 2), `core.account.backend(method, path, body)`, the account's directory
  (`MessageDirectory.current()` tabs with panes), `core.daemon.machineId()`.
- Produces:

```ts
export interface SharedTabsDeps {
  key: TabKey
  relay: TabRelay
  store: RosterStore
  backend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  self(): { machineId: string; accountId: string; email: string }
  /** The owner's own panes in a desk tab, with each harness's name and engine, from the account's directory. */
  ownPanes(tabId: string): Array<{ machineId: string; agentId: string; name: string; engine: string }>
  /** This account's machines' identity keys, by machine id (the device key log's view, read through the core). */
  machineKey(machineId: string): string | null
  now?(): number
}
export class SharedTabs {
  constructor(deps: SharedTabsDeps)
  // owner
  share(tabId: string, name: string): Promise<{ sharedTabId: string }>
  invite(sharedTabId: string, emails: string[], days: 7 | 30 | 90): Promise<{ invited: string[]; refused: { email: string; error: string }[] }>
  revoke(inviteId: string): Promise<void>
  setLeader(sharedTabId: string, leader: { machineId: string; agentId: string } | null): Promise<void>
  removeMember(sharedTabId: string, accountId: string): Promise<void>
  removeHarness(sharedTabId: string, machineId: string, agentId: string): Promise<void>
  stop(sharedTabId: string): Promise<void>
  /** Re-read shares from the backend (on start and `desk_changed`): owner republishes when members or its panes changed. */
  refresh(): Promise<void>
  // member
  invites(): Promise<Array<{ id: string; sharedTabId: string; ownerEmail: string; ownerMachineId: string; expiresAt: string; fingerprint?: string }>>
  accept(inviteId: string, ownerPub: string): Promise<{ sharedTabId: string }>
  addHarness(sharedTabId: string, harness: { machineId: string; agentId: string; name: string; engine: string }): Promise<{ queued: true }>
  leave(sharedTabId: string): Promise<void>
  // both
  rosters(): Roster[]
  onFrame(event: Parameters<GatewayEvents['tabFrame']>[0]): Promise<void>
}
```

Owner rules (each a test): `share` derives nothing locally; it PUTs version 1 with the owner's panes and gets the
`sharedTabId` back, then re-signs with that id (the body must carry it), PUTting version 2; every later change bumps
`version` by one from the store's current roster, signs with `key.signRoster`, PUTs, offers to its own store (the
owner pins its own key at `share`), opens the relay, and sends `{ kind: 'roster', signed }` sealed to every other
machine in the roster. `refresh` adds accepted members from `GET /api/agent-messages/shares` (`members`) and drops
removed ones, re-reads the owner's panes, and republishes only when the encoded roster changed. A member's
`{ kind: 'roster_request', op: 'add' | 'remove', harness }` is applied only if the sender's machine is in the roster
or the sender's account is a member and the harness's `accountId` is the sender's; `add` beyond
`ROSTER_LIMITS.harnesses` answers `{ kind: 'roster_refused', error: 'TAB_FULL' }`.

Member rules (each a test): `accept(inviteId, ownerPub)` POSTs accept, pins `ownerPub` for the returned id, GETs
shares, offers the roster blob it got; `addHarness` opens the relay, ensures a session with the owner's machine
(`key.hello` → wait for the welcome frame), and sends the request sealed; while the owner's machine is
undeliverable it keeps the request queued and retries every 30 s and on `amsg_ready`; a request is idempotent (same
harness twice yields one entry). `leave` DELETEs the membership, forgets the roster, and closes the relay.

Frames (`onFrame`): `{hello}` → `key.accept` with the peer key from the roster (refused if the machine is not
listed); `{welcome}` → `key.welcome`; sealed → `key.open`, then dispatch `roster` (offer to store; on a newer one
re-check pending requests), `roster_request` (owner only), `roster_refused` (surface to the person's next
`shares` read); `closed` 4403 → forget the roster and record that the person was removed.

- [ ] **Step 1: Write the failing tests** in `sharedTabs.spec.ts` with fakes for `TabKey` (a real `TabSessions` pair
  from Task 4 for two fake machines), an in-memory `TabRelay` that connects two `SharedTabs` instances (owner and
  member) and can be told a machine is offline, a fake `backend` holding shares/invites in a `Map`, and real
  `RosterStore`s in temp folders. One `it` per rule above, plus the Review Focus cases 2 and 4: a hello from a
  machine not in the roster is refused and nothing is opened; a member's add while the owner is offline is
  delivered once the owner comes back, and applied exactly once.

- [ ] **Step 2: Run to see them fail.** `cd cli && npx vitest run src/messages/sharedTabs.spec.ts` → FAIL.

- [ ] **Step 3: Implement** `sharedTabs.ts` to the rules above. Header comment: the owner's computer is the only
  authority (the spec's "Authority"); the backend is a mailbox and a relay; a member's request is a request, applied
  by the owner; nothing here delivers messages yet (1b).

- [ ] **Step 4: Expose the actions.** In `service.ts`'s `agent_messages` switch, add, all owner-only (the existing
  `asker.owner` check) and never from another machine's hand-over:

```ts
case 'shares': return { rosters: shared.rosters(), invites: await shared.invites(), alerts: rosterStore.alerts() }
case 'share_tab': return shared.share(String(payload.tabId), String(payload.name ?? ''))
case 'share_invite': return shared.invite(String(payload.sharedTabId), payload.emails as string[], payload.days as 7 | 30 | 90)
case 'share_revoke': return shared.revoke(String(payload.inviteId)).then(() => ({ ok: true }))
case 'share_accept': return shared.accept(String(payload.inviteId), String(payload.ownerPub))
case 'share_add': return shared.addHarness(String(payload.sharedTabId), payload.harness as { machineId: string; agentId: string; name: string; engine: string })
case 'share_remove': return shared.removeHarness(String(payload.sharedTabId), String(payload.machineId), String(payload.agentId)).then(() => ({ ok: true }))
case 'share_leader': return shared.setLeader(String(payload.sharedTabId), (payload.leader ?? null) as { machineId: string; agentId: string } | null).then(() => ({ ok: true }))
case 'share_remove_member': return shared.removeMember(String(payload.sharedTabId), String(payload.accountId)).then(() => ({ ok: true }))
case 'share_leave': return shared.leave(String(payload.sharedTabId)).then(() => ({ ok: true }))
case 'share_stop': return shared.stop(String(payload.sharedTabId)).then(() => ({ ok: true }))
```

Construct `SharedTabs` only while `mode === 'awake'` (Agent Messages on and signed in); asleep, every `share_*`
action answers `MESSAGES_OFF`, and no relay socket is open (call `relay.close` for every roster on sleep). Call
`shared.refresh()` on wake and on the account's `desk_changed`.

- [ ] **Step 5: Run.** `cd cli && npx vitest run src/messages --coverage --coverage.include=src/messages/sharedTabs.ts && npm run test:core && npm run typecheck` → PASS, `sharedTabs.ts` 100%, existing `messages/*.spec.ts` unchanged and green.

- [ ] **Step 6: Leave it in the working tree** and list the files in the task report.

---

### Task 10: The pieces together, and the gates

**Files:**
- Create: `cli/src/messages/sharedTabs.integration.spec.ts`

**Interfaces:**
- Consumes: everything above, with an in-process stand-in for the backend relay that implements the wire of
  Task 7 (admission by a set of `(account, machine, share)` triples, `from` stamped by the stand-in).

- [ ] **Step 1: Write the test.** Three `SharedTabs` (Alice's `alice-mac` as owner, Bob's `bob-mini`, Carol's
  `carol-pc`), each with its own `TabSessions`, `RosterStore` and a `TabRelaySockets` pointed at a local
  `WebSocketServer` that implements Task 7's behaviour in a few lines. Scenario, each step asserted:
  1. Alice shares `tab-1`; Bob's account also has a desk tab `tab-1` and shares it: the two `sharedTabId`s differ,
     and frames for one never reach the other's machines (Review Focus 3).
  2. Alice invites Bob and Carol; both accept with Alice's fingerprint; Alice's `refresh` adds them; both hold
     roster v3 (v1 and v2 from `share`).
  3. Bob adds `bob/api`; Carol adds `carol/web`; both appear in every member's roster.
  4. The stand-in serves Bob an older roster: Bob keeps the newer one, no alert (stale, not forged). The stand-in
     serves Bob a roster signed by Carol's key: Bob keeps his and records `bad_signature` (Review Focus 1).
  5. Alice's machine goes offline; Bob adds `bob/db`; it waits; Alice comes back; it is applied once.
  6. Alice removes Carol: Carol's socket is closed 4403 by the stand-in after its re-check, Carol forgets the
     roster, and Bob's roster no longer lists `carol/web`.

- [ ] **Step 2: Run the whole gate set.**

```bash
cd cli && npm run test:shared-tabs && npm run test:core && npm run typecheck && npx vitest run src/messages src/gateway src/architecture.spec.ts
cd ../backend && npm run test:agent-messages && npx tsc --noEmit && npx vitest run src/routes/agentMessages.test.ts src/lib/observerWs.test.ts
```

Expected: every command exits 0; `test:shared-tabs` and `test:agent-messages` report 100% for every listed file;
`agentMessages.e2e.ts` is not run here (1b runs the end-to-end suite).

- [ ] **Step 3: Report.** List every file created or changed, the gate outputs, and anything Step 0's Findings or a
  task changed from this plan. Leave everything in the working tree.

## Not in 1a

Delivery of messages across accounts, the note, `harness send` listing, derived observer grants and the Tasks search
(1b, planned after this lands); every desktop change (1c, planned from step 0's Findings).

## Outcome (2026-10-15)

All ten tasks done with per-task reviews, a final whole-branch review and one fix wave; nothing committed. Gates at the
end: cli `test:shared-tabs` 115 passed (100%), `test:core` 2697 passed (100%), typecheck clean; backend
`test:agent-messages` 91 passed (100%), `tsc` clean. Native-helper specs under `cli/src/lib` that fail on this Mac
fail the same way on a clean `origin/main` (a163b57): environmental, not this branch.

End to end in the real process layout (`cli/e2e/sharedTabs.e2e.ts`, opt-in with `HARNESS_E2E_SERVICES_DIR`): real
backend, two accounts, one daemon each with Agent Messages in the edge host. Share, invite, accept (fingerprint matches
the owner's machine key), a member's add over the real relay (both daemons converge on one roster version in
332–524 ms), a duplicate add applied once, leave, and stop then share again (version 6 → 8). Passed 4 runs in a row.

Changes from the plan, decided during execution:
- `accept(inviteId, ownerPub?)`: the invitee cannot read the roster before accepting, so first-use trust pins the owner
  key of the first roster fetched after accept and shows its fingerprint then (the spec said before).
- Stop Sharing removes every member and revokes pending invitations; sharing the tab again starts empty, from any live
  computer of the owner, and the roster version keeps growing.
- The relay answers 401 before the upgrade for a token that does not authenticate; 4403 means only "not admitted".
- The messages process reaches the backend through an allowlist of the nine shared-tab routes
  (`MESSAGES_BACKEND_ROUTES`, core/api.ts) and asks the core for the account (`account.identity()`).
- Members' machine keys: a machine's key is self-reported (`tab_pub` over the same-account relay; a member's request
  carries its own).

## Follow-ups for 1b (from the reviews)

Blockers before message delivery:
1. **Member machine keys the owner cannot verify.** The owner signs any key the relay stamps under a member account
   for a machine not yet listed, and a member can list a harness on another member's machine id. Each member's daemon
   must detect entries under its own account that are not its machines (detect, not block), and a member's harness
   machine must be the machine sending the request.
2. **A member's other computers never hold the pin**: only the computer that accepted can add harnesses or receive.
   Propagate the pin across the member's own machines over the paired relay.
3. **Re-trust without a new invitation** for a current membership whose pin was lost (key change without a signed
   move, lost file, account switch).
4. **Persist the member's request queue** across a messages-process restart.
5. **Reopen relays** after a gateway-only restart or a 4409, not only on refresh; close the tabs the core saw opened
   when the messages link drops; in-core mode (`HARNESSD_SERVICES=none`) wires `onTabFrame` or opens no relay.
6. **The owner changes computers**: a transfer path (new machine, signed key change members verify); meanwhile allow
   Stop from any of the owner's computers.

Smaller items worth folding into 1b: a transient GET failure right after accept should not leave the tab; the relay
should count its rate on receipt; an unreadable shared-tabs file should be moved aside with an alert rather than
disable shared tabs; one size ceiling for relay, cipher and roster (strip control characters in names); recompute the
`sharedTabId` the PUT answers; a per-member cap on `roster_request`; `compose` cutting the roster at 32 should tell the
owner (`TAB_FULL`); update `cli/src/services/AGENTS.md` and `cli/src/core/AGENTS.md` for the messages process's new
asks (`account`, `tab_key`, `tab_relay`, the route allowlist); drop the unused `MESSAGES_BACKEND_PATH`.

Desktop (1c) seams from step 0 are in [2026-10-15-shared-tabs-0-spikes.md](2026-10-15-shared-tabs-0-spikes.md).
