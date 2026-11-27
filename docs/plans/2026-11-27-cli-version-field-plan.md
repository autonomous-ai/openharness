# The CLI's version gets its own field on a device: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A new CLI says hello with `cliVersion`, the backend stores it in `device_bindings.cliVersion` and never again
writes a CLI's version to `firmwareVersion`, and `/api/mobile/v1` adds `cliVersion` while its `firmwareVersion` shows
what it shows today.

**Architecture:** One payload key in the CLI's device lane (`cli/src/device/`, not the core). In the backend: one shared
version check (moved out of `adapterWs.ts`), an optional `cliVersion` on `DeviceBinding`, `handleHello` choosing which
field a hello's version goes to, and the read side (`toDeviceDetail`, `toMobileDevice`) mapping a `harness-cli` row's
old `firmwareVersion` to its CLI version. A shared fixture, `tests/fixtures/cli-device-hello.json`, is the CLI's real
hello: the CLI's spec pins its frame to it, and the backend's tests (new code and a copy of the released code) read it.

**Tech Stack:** TypeScript, Vitest, Fastify, Prisma 5 on MongoDB (`mongodb-memory-server` for integration), `ws`.

**Spec:** `docs/plans/2026-11-27-cli-version-field-design.md` (read it with this plan). Decisions (harness-pm,
2026-11-27) are in its Decisions section; the one added in the brief: a test shows the released backend (main at
`ac285a931a`) meeting a hello with `cliVersion` alone keeps the row's old `firmwareVersion` and does not fail (Task 6).

## Global Constraints

- No file under `cli/src/core/`. The CLI change is `cli/src/device/deviceLink.ts` and its spec only.
- One version rule for `Machine.clientVersion` (`?v=`) and both hello values: trimmed, then `^[A-Za-z0-9._+-]{1,64}$`;
  a value that fails is dropped, never stored.
- `cliVersion String?` on `DeviceBinding`: optional, no index, no migration, no backfill, no rewrite of stored rows.
- `/api/mobile/v1` keeps every field it had and adds `cliVersion`.
- The `commander device_hello` log line carries versions only (no content, no identifiers beyond today's).
- Comments say why, in plain sentences; names follow [the Naming System](../naming-system.md).
- Platforms: the CLI change runs alike on macOS, Linux and Windows (a payload key); the backend runs on Linux.
- Before the first task, install once (tasks do not install): `(cd backend && npm ci)` (its `postinstall` runs
  `prisma generate`) and `(cd cli && npm ci)`.
- Commands: backend unit `cd backend && npm test -- <file>`; backend integration
  `cd backend && npx vitest run --config vitest.integration.config.ts <file>` (first run downloads MongoDB 7.0.24 to the
  temp folder); CLI `cd cli && npx vitest run <file>`; typecheck `npm run typecheck` in the component. Targeted tests
  per task; the full suites run on PR CI.

## What this plan decides from the spec's words

- **The shared check** lives in a new `backend/src/lib/clientVersion.ts`: `sanitizeClientVersion(raw: unknown): string
  | undefined`, the same name and trim as today, taking `unknown` so a hello's values go straight in. The module also
  exports `HARNESS_CLI_CHIP = 'harness-cli'`, the one spelling the hello (Task 4) and the read (Task 5) compare with.
  It imports nothing, so no test has to mock it.
- **`handleHello` is tested through the real socket handler** (`handleDeviceUpgrade`), with the fakes
  `src/lib/devicePing.test.ts` already uses, not through an extracted function: the rule is a few lines inside
  `handleHello`, and this way the test also covers what reaches `recordHello` and the log line.
- **`deviceFirmwareVersion`** (the closure variable, `deviceWs.ts:580`) goes: `handleHello` was its only reader.
- **`recordHello`'s `data` takes Prisma's type** (`Prisma.DeviceBindingUpdateManyMutationInput`, not
  `Record<string, unknown>`), so a key the schema lacks fails typecheck instead of every hello's write failing at run
  time, logged and swallowed.
- **One payload for both components:** `tests/fixtures/cli-device-hello.json`, as `desktop-product-usage-report.json`
  is shared today. `tests/fixtures/` is already in the backend's `DEPENDS` and `PR_READS` (`scripts/ci-plan.py`), and
  `tests/` selects the CLI suite, so no CI change.
- **The released-backend test is an integration test** (real MongoDB, `backend/integration/`), beside
  `oldUsageServer.test-support.ts`, the repo's pattern for released server code: the claim is about the stored row, so
  the row is read back from MongoDB rather than inferred from a mock's arguments. `backend-integration` runs on every
  backend PR anyway; the file adds one replica-set start.
- **`toMobileDevice`** sends `firmwareVersion: d.firmwareVersion ?? d.cliVersion` for every device: on a dial
  `DeviceDetail.cliVersion` is null, so a dial's value is its firmware; on a `harness-cli` device it is the CLI's
  version, as today. The `PATCH` rename route returns through the same mapper.
- **No explain-plan test** (`backend/AGENTS.md` rule 3 is for new or changed queries): `recordHello` keeps
  `updateMany({ where: { deviceId } })` on the unique `deviceId` index, only its `$set` gains a key; the reads
  (`listDetailedForUser`, `detailForUser`) are unchanged. No new model, index or TTL (rules 1 and 2).

## Review Focus

1. A new CLI's hello whose `cliVersion` fails the check but which also carries a valid `firmwareVersion`: nothing is
   stored for either (no fallback), and the device stays connected. Task 4, the rejected-version test.
2. A `harness-cli` row holding a fresh `cliVersion` and its old `firmwareVersion`: reads show the fresh one, with
   `firmwareVersion` null inside the backend and the fresh one on `/api/mobile/v1`. Task 5.
3. A dial's hello that carries a `cliVersion` key: ignored; its `firmwareVersion` is stored, now through the check.
   Task 4, the dial test.
4. A version with spaces around it, exactly 64 or 65 characters, or not a string: trimmed, kept, dropped, dropped, for
   `?v=` and the hello alike. Task 1.
5. The released backend meeting a new CLI (the CLI out first, or a backend rollback): the row keeps its last old-style
   version and the hello does not fail. Task 6.

## Task graph

| Task | Effort | Depends on | Files (all of them) |
| --- | --- | --- | --- |
| 1. One version check | medium | none | `backend/src/lib/clientVersion.ts` (new), `backend/src/lib/clientVersion.test.ts` (new), `backend/src/lib/adapterWs.ts` |
| 2. The CLI's hello | medium | none | `tests/fixtures/cli-device-hello.json` (new), `cli/src/device/deviceLink.ts`, `cli/src/device/deviceLink.spec.ts` |
| 3. The stored field | xhigh | none | `backend/prisma/schema.prisma`, `backend/src/services/DeviceService.ts`, `backend/src/services/DeviceService.test.ts` |
| 4. The backend's hello | xhigh | 1, 2, 3 | `backend/src/lib/deviceWs.ts`, `backend/src/lib/deviceHello.test.ts` (new) |
| 5. The read side | high | 1, 3 | `backend/src/services/DeviceService.ts`, `backend/src/services/DeviceService.test.ts`, `backend/src/routes/mobile.ts`, `backend/src/routes/mobile.test.ts` |
| 6. The released backend meets the new hello | high | 2 | `backend/integration/oldDeviceHello.test-support.ts` (new), `backend/integration/oldDeviceHello.test.ts` (new), `backend/vitest.integration.config.ts` |

Tasks 1, 2 and 3 start at once; 6 starts when 2 is done; 4 and 5 start when their dependencies are done and run side by
side (no shared file). Longest chain: 2 tasks (3 → 4, or 3 → 5).

---

### Task 1: One version check

**Effort:** medium. **Depends on:** none.

**Files:**
- Create: `backend/src/lib/clientVersion.ts`
- Modify: `backend/src/lib/adapterWs.ts` (delete `CLIENT_VERSION_RE` and its comment, lines 88-90, and
  `sanitizeClientVersion`, lines 126-129; import the shared one)
- Test: `backend/src/lib/clientVersion.test.ts`

**Interfaces:**
- Produces: `sanitizeClientVersion(raw: unknown): string | undefined` (non-string → `undefined`; trims; returns the
  trimmed value when it matches `^[A-Za-z0-9._+-]{1,64}$`, else `undefined`) and
  `export const HARNESS_CLI_CHIP = 'harness-cli'`, both from `backend/src/lib/clientVersion.ts`.

- [ ] **Step 1: Write the failing test** `backend/src/lib/clientVersion.test.ts`:

```ts
import { expect, it } from 'vitest'
import { sanitizeClientVersion } from './clientVersion.js'

it('keeps a version a client really sends, trimmed', () => {
  expect(sanitizeClientVersion('0.6.97')).toBe('0.6.97')
  expect(sanitizeClientVersion('0.6.97-dev.3+g1a2b3c')).toBe('0.6.97-dev.3+g1a2b3c')
  expect(sanitizeClientVersion(' 0.6.97 ')).toBe('0.6.97')
  expect(sanitizeClientVersion('1'.repeat(64))).toBe('1'.repeat(64))
})

it('drops anything else, never stored raw', () => {
  for (const raw of ['', '   ', '1'.repeat(65), '0.6.97 beta', '0.6.97;rm', '<b>0.6</b>', null, undefined, 42, {}, ['0.6.97']]) {
    expect(sanitizeClientVersion(raw)).toBeUndefined()
  }
})
```

- [ ] **Step 2: Run it to see it fail.** `cd backend && npm test -- src/lib/clientVersion.test.ts`. Expected: FAIL,
  the import `./clientVersion.js` does not resolve.
- [ ] **Step 3: Commit the red test:** `git add backend/src/lib/clientVersion.test.ts && git commit -m "Backend: one
  check for a client's version (red)"`.
- [ ] **Step 4: Create `backend/src/lib/clientVersion.ts`** with both exports. Move adapterWs's comment, widened: a
  client's version is self-declared (`?v=` on the adapter socket, `cliVersion`/`firmwareVersion` in a device hello), so
  it is never stored raw. `HARNESS_CLI_CHIP`'s comment: the chip a Harness CLI says hello with; on such a row the
  version is a CLI's, never firmware (spec, 2026-11-27). In `adapterWs.ts` import `sanitizeClientVersion` from
  `./clientVersion.js` and delete the private regex and function; line 178 stays as it is.
- [ ] **Step 5: Run it to see it pass, and typecheck.** `npm test -- src/lib/clientVersion.test.ts src/lib/adapterMachineWrites.test.ts`
  and `npm run typecheck` in `backend/`. Expected: PASS, no type error.
- [ ] **Step 6: Commit:** `git add backend/src/lib/clientVersion.ts backend/src/lib/adapterWs.ts && git commit -m
  "Backend: one check for a client's version, shared by the adapter socket and the device hello"`.

---

### Task 2: The CLI's hello

**Effort:** medium. **Depends on:** none.

**Files:**
- Create: `tests/fixtures/cli-device-hello.json`
- Modify: `cli/src/device/deviceLink.ts:739`
- Test: `cli/src/device/deviceLink.spec.ts`

**Interfaces:**
- Produces: `tests/fixtures/cli-device-hello.json`, exactly:

```json
{
  "type": "device_hello",
  "payload": { "chip": "harness-cli", "cliVersion": "0.6.97", "caps": ["e2ee_data", "multi_machine"] }
}
```

  The CLI sends this frame with `cliVersion: VERSION`. Tasks 4 and 6 read the file as the new CLI's hello.

- [ ] **Step 1: Create the fixture** above, then **write the failing test** in `deviceLink.spec.ts`, inside
  `describe('the fleet\'s lane, sealed by the gateway')` (add `readFileSync` from `node:fs` and `VERSION` from
  `../version.js` to the imports):

```ts
// The backend's tests read this file as the new CLI's hello (backend/src/lib/deviceHello.test.ts,
// backend/integration/oldDeviceHello.test.ts): a hello that changes here must change there too.
const CLI_HELLO = JSON.parse(readFileSync(new URL('../../../tests/fixtures/cli-device-hello.json', import.meta.url), 'utf8')) as Frame

it('says hello with its version as cliVersion, never as firmware', async () => {
  const { server, link } = await lane()
  await link.online()
  await until('the hello', () => server.received.some((frame) => frame.type === 'device_hello'))
  const hello = server.received.find((frame) => frame.type === 'device_hello')!
  expect(hello).toEqual({ ...CLI_HELLO, payload: { ...(CLI_HELLO.payload as Frame), cliVersion: VERSION } })
  expect(hello.payload).not.toHaveProperty('firmwareVersion')
})
```

- [ ] **Step 2: Run it to see it fail.** `cd cli && npx vitest run src/device/deviceLink.spec.ts -t "cliVersion"`.
  Expected: FAIL, the payload has `firmwareVersion` and no `cliVersion`.
- [ ] **Step 3: Commit the red test:** `git add tests/fixtures/cli-device-hello.json cli/src/device/deviceLink.spec.ts
  && git commit -m "CLI: the device hello names the CLI's version (red)"`.
- [ ] **Step 4: Change the payload** at `deviceLink.ts:739` to `{ chip: 'harness-cli', cliVersion: VERSION, caps:
  ['e2ee_data', 'multi_machine'] }`, with one comment line: the CLI's version is not firmware; the backend stores it as
  `cliVersion` (`docs/plans/2026-11-27-cli-version-field-design.md`).
- [ ] **Step 5: Run it to see it pass, and typecheck.** `npx vitest run src/device/deviceLink.spec.ts` and
  `npm run typecheck` in `cli/`. Expected: PASS, no type error.
- [ ] **Step 6: Commit:** `git add cli/src/device/deviceLink.ts && git commit -m "CLI: the device hello sends the
  CLI's version as cliVersion, not firmwareVersion"`.

---

### Task 3: The stored field

**Effort:** xhigh (stored data). **Depends on:** none.

**Files:**
- Modify: `backend/prisma/schema.prisma` (`DeviceBinding`, line 479), `backend/src/services/DeviceService.ts`
  (`recordHello`, lines 202-218)
- Test: `backend/src/services/DeviceService.test.ts`

**Interfaces:**
- Produces: Prisma `DeviceBinding.cliVersion: string | null`;
  `deviceService.recordHello(input: { deviceId: string; cliVersion?: string | null; firmwareVersion?: string | null;
  chip?: string | null; ssid?: string | null; rssi?: number | null }): Promise<void>`, writing `cliVersion` only when
  it is a non-empty string, like the other facts.

- [ ] **Step 1: Write the failing test** in `describe('recordHello')`:

```ts
it('stores the CLI\'s version as cliVersion', async () => {
  await deviceService.recordHello({ deviceId: 'dev-1', cliVersion: '0.6.97', chip: 'harness-cli' })
  expect(updateMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' }, data: { cliVersion: '0.6.97', chip: 'harness-cli' } })
})
```

  and add `cliVersion: null` to the call in `'does not touch the DB when the device reported nothing usable'` (a
  missing version leaves the stored one alone).
- [ ] **Step 2: Run it to see it fail.** `cd backend && npm test -- src/services/DeviceService.test.ts`. Expected:
  FAIL, `data` is `{ chip: 'harness-cli' }`.
- [ ] **Step 3: Commit the red test:** `git add backend/src/services/DeviceService.test.ts && git commit -m "Backend: a
  device row stores the CLI's version (red)"`.
- [ ] **Step 4: Add the field and the write.** In `schema.prisma`, `cliVersion String?` beside `firmwareVersion`, with
  the spec's comments: `cliVersion` is the Harness CLI's version as of its last hello, null on a dial and on a row whose
  CLI has not said hello since this release; `firmwareVersion` is a dial's firmware, and on a `harness-cli` row an old
  CLI version that backend readers take as that row's last CLI version, never as firmware. In `recordHello`, add the
  `cliVersion` input and `if (input.cliVersion) data.cliVersion = input.cliVersion`, and type `data` as
  `Prisma.DeviceBindingUpdateManyMutationInput`. Run `npx prisma generate` in `backend/`.
- [ ] **Step 5: Run it to see it pass, and typecheck.** `npm test -- src/services/DeviceService.test.ts` and
  `npm run typecheck`. Expected: PASS, no type error.
- [ ] **Step 6: Commit:** `git add backend/prisma/schema.prisma backend/src/services/DeviceService.ts && git commit -m
  "Backend: a device row keeps the CLI's version in its own field"`.

---

### Task 4: The backend's hello

**Effort:** xhigh (decides which stored field a version goes to). **Depends on:** 1, 2, 3.

**Files:**
- Modify: `backend/src/lib/deviceWs.ts` (`handleHello`, lines 1078-1114; delete `deviceFirmwareVersion`, line 580)
- Test: `backend/src/lib/deviceHello.test.ts` (new)

**Interfaces:**
- Consumes: `sanitizeClientVersion`, `HARNESS_CLI_CHIP` (Task 1); `tests/fixtures/cli-device-hello.json` (Task 2);
  `recordHello`'s `cliVersion` input (Task 3).

- [ ] **Step 1: Write the failing test** `backend/src/lib/deviceHello.test.ts`. Copy `devicePing.test.ts`'s fakes
  as they are (the hoisted `vi.useFakeTimers()` and mocks, lines 7-43, the `Socket` class, `flush`, `raw`), with
  `recordHello: m.recordHello` (a hoisted `vi.fn(async () => {})`) in the `deviceService` mock. Then:

```ts
const NEW_CLI_HELLO = JSON.parse(readFileSync(new URL('../../../tests/fixtures/cli-device-hello.json', import.meta.url), 'utf8'))
const info = vi.spyOn(logger, 'info') // logger from '../utils/logger.js'

/** One device socket that says [payload] as its hello; what reached recordHello. */
async function hello(payload: Record<string, unknown>) {
  const device = new Socket()
  m.upgrade.mockImplementationOnce((_r, _s, _h, done) => done(device))
  handleDeviceUpgrade({ url: `/api/device-ws?computer=${'a'.repeat(32)}`, headers: { 'sec-websocket-protocol': 'access-token' } } as never,
    raw() as never, Buffer.alloc(0))
  await flush()
  device.frame({ type: 'device_hello', payload })
  await flush()
  device.close()
  return m.recordHello.mock.lastCall?.[0]
}
const facts = (over: Record<string, unknown>) => ({ deviceId: 'dial-1', chip: 'harness-cli', ssid: null, rssi: null, ...over })
const CAPS = ['e2ee_data', 'multi_machine']

it('a new CLI\'s hello stores its cliVersion and no firmwareVersion', async () => {
  expect(await hello(NEW_CLI_HELLO.payload)).toEqual(facts({ cliVersion: '0.6.97', firmwareVersion: null }))
  expect(info).toHaveBeenCalledWith('commander device_hello', expect.objectContaining({ cliVersion: '0.6.97', firmwareVersion: null }))
})

it('an older CLI\'s firmwareVersion is stored as its cliVersion, never as firmware', async () => {
  expect(await hello({ chip: 'harness-cli', firmwareVersion: '0.6.96', caps: CAPS }))
    .toEqual(facts({ cliVersion: '0.6.96', firmwareVersion: null }))
})

it('a dial keeps its firmwareVersion, and a cliVersion it sends is ignored', async () => {
  expect(await hello({ chip: 'esp32s3', firmwareVersion: '0.2.9', cliVersion: '0.6.97' }))
    .toEqual(facts({ chip: 'esp32s3', cliVersion: null, firmwareVersion: '0.2.9' }))
})

it('a version that fails the check is dropped, and a failing cliVersion does not fall back to firmwareVersion', async () => {
  expect(await hello({ chip: 'harness-cli', cliVersion: 'x'.repeat(65), firmwareVersion: '0.6.96', caps: CAPS }))
    .toEqual(facts({ cliVersion: null, firmwareVersion: null }))
  expect(await hello({ chip: 'esp32s3', firmwareVersion: '0.2.9 beta' }))
    .toEqual(facts({ chip: 'esp32s3', cliVersion: null, firmwareVersion: null }))
})
```

- [ ] **Step 2: Run it to see it fail.** `cd backend && npm test -- src/lib/deviceHello.test.ts`. Expected: 4 FAIL
  (no `cliVersion` reaches `recordHello`; the older CLI's and the rejected hello's `firmwareVersion` is stored).
- [ ] **Step 3: Commit the red test:** `git add backend/src/lib/deviceHello.test.ts && git commit -m "Backend: the
  device hello stores a CLI's version as cliVersion (red)"`.
- [ ] **Step 4: Change `handleHello`.** Read `chip` once (`typeof payload.chip === 'string' ? payload.chip : null`).
  On `chip === HARNESS_CLI_CHIP`: `cliVersion = sanitizeClientVersion(payload.cliVersion ?? payload.firmwareVersion)
  ?? null` (`??`, so a `cliVersion` that is present but fails does not fall back), `firmwareVersion = null`. Any other
  chip: `firmwareVersion = sanitizeClientVersion(payload.firmwareVersion) ?? null`, `cliVersion = null`. Pass both and
  `chip` to `recordHello`; the log line becomes `{ userId, cliVersion, firmwareVersion, deviceId, multiMachine }`.
  Delete `deviceFirmwareVersion` (line 580). One comment says why: an older CLI still sends its version as
  `firmwareVersion`, and a CLI's version is never firmware (spec, 2026-11-27).
- [ ] **Step 5: Run it to see it pass, and typecheck.** `npm test -- src/lib/deviceHello.test.ts src/lib/devicePing.test.ts`
  and `npm run typecheck`. Expected: PASS, no type error.
- [ ] **Step 6: Commit:** `git add backend/src/lib/deviceWs.ts && git commit -m "Backend: a CLI's hello stores its
  version as cliVersion, a dial's as firmwareVersion, both checked"`.

---

### Task 5: The read side

**Effort:** high. **Depends on:** 1, 3.

**Files:**
- Modify: `backend/src/services/DeviceService.ts` (`DeviceDetail`, lines 28-41; `toDeviceDetail`, lines 56-71),
  `backend/src/routes/mobile.ts` (`toMobileDevice`, lines 93-111)
- Test: `backend/src/services/DeviceService.test.ts`, `backend/src/routes/mobile.test.ts`

**Interfaces:**
- Consumes: `HARNESS_CLI_CHIP` (Task 1); `DeviceBinding.cliVersion` (Task 3).
- Produces: `DeviceDetail.cliVersion: string | null` = stored `cliVersion` ?? (stored `chip === HARNESS_CLI_CHIP` ?
  stored `firmwareVersion` : null); `DeviceDetail.firmwareVersion` = null on a `harness-cli` row, else stored.

- [ ] **Step 1: Write the failing tests.** In `DeviceService.test.ts`, add `cliVersion: null` to the `device()`
  fixture, `cliVersion: null` to `'carries the reported hardware fields through'`'s expected object, and:

```ts
describe('the CLI\'s version on a device', () => {
  const read = async (over: Record<string, unknown>) => {
    findMany.mockResolvedValue([device(over)])
    const [row] = await deviceService.listDetailedForUser('u1')
    return { cliVersion: row.cliVersion, firmwareVersion: row.firmwareVersion }
  }
  it('a harness-cli row reads its stored cliVersion, and no firmware', async () => {
    expect(await read({ chip: 'harness-cli', cliVersion: '0.6.97', firmwareVersion: '0.6.95' })).toEqual({ cliVersion: '0.6.97', firmwareVersion: null })
  })
  it('a harness-cli row with no hello since the release reads its old firmwareVersion as its CLI version', async () => {
    expect(await read({ chip: 'harness-cli', cliVersion: null, firmwareVersion: '0.6.95' })).toEqual({ cliVersion: '0.6.95', firmwareVersion: null })
  })
  it('a dial reads its firmware, and no CLI version', async () => {
    expect(await read({ chip: 'esp32s3', cliVersion: null, firmwareVersion: '0.2.8' })).toEqual({ cliVersion: null, firmwareVersion: '0.2.8' })
  })
  it('a row with no chip and no version reads neither', async () => {
    expect(await read({ chip: null, cliVersion: null, firmwareVersion: null })).toEqual({ cliVersion: null, firmwareVersion: null })
  })
})
```

  In `mobile.test.ts`, add `cliVersion: null` to the `device()` fixture and:

```ts
describe('the CLI\'s version', () => {
  const both = async () => {
    const app = await buildApp()
    const listed = JSON.parse((await overview(app)).payload).data.devices[0]
    const one = JSON.parse((await call(app, { method: 'GET', url: '/api/mobile/v1/devices/6a70088ae13f6277cdf9015a' })).payload).data.device
    return [listed, one]
  }
  it('a harness-cli device carries cliVersion, and firmwareVersion stays the CLI\'s version for the Autonomous app', async () => {
    const cli = device({ chip: 'harness-cli', firmwareVersion: null, cliVersion: '0.6.97' })
    listDetailedForUser.mockResolvedValue([cli]); detailForUser.mockResolvedValue(cli)
    for (const d of await both()) expect(d).toMatchObject({ cliVersion: '0.6.97', firmwareVersion: '0.6.97' })
  })
  it('a dial carries its firmware and a null cliVersion', async () => {
    listDetailedForUser.mockResolvedValue([device()]); detailForUser.mockResolvedValue(device())
    for (const d of await both()) expect(d).toMatchObject({ cliVersion: null, firmwareVersion: '0.2.8' })
  })
})
```

- [ ] **Step 2: Run them to see them fail.** `cd backend && npm test -- src/services/DeviceService.test.ts
  src/routes/mobile.test.ts`. Expected: FAIL, no `cliVersion` in either shape; a `harness-cli` row's
  `firmwareVersion` is the stored one.
- [ ] **Step 3: Commit the red tests:** `git add backend/src/services/DeviceService.test.ts
  backend/src/routes/mobile.test.ts && git commit -m "Backend: a device reads the CLI's version apart from firmware (red)"`.
- [ ] **Step 4: Map the fields.** `DeviceDetail` gains `cliVersion: string | null` next to `firmwareVersion`, its doc
  comment saying the fallback; `toDeviceDetail` computes both as in Interfaces, comparing with `HARNESS_CLI_CHIP`.
  `toMobileDevice` adds `cliVersion: d.cliVersion` and sends `firmwareVersion: d.firmwareVersion ?? d.cliVersion`, with
  a comment: the Autonomous app reads `firmwareVersion` today; this is the only place a CLI version still reaches it,
  and it goes with the spec's Follow-up once the app reads `cliVersion`.
- [ ] **Step 5: Run them to see them pass, and typecheck.** Same command, then `npm run typecheck`. Expected: PASS,
  no type error.
- [ ] **Step 6: Commit:** `git add backend/src/services/DeviceService.ts backend/src/routes/mobile.ts && git commit -m
  "Backend: a device's CLI version reads as cliVersion; the mobile API keeps firmwareVersion as today"`.

---

### Task 6: The released backend meets the new hello

**Effort:** high. **Depends on:** 2.

A guard on code that does not change (the released backend): no test fails first, and the task is one commit. The
second test proves the copy is live: it is the released code that does write `firmwareVersion` when a hello carries
one, so the first test's "kept" cannot pass by a copy that ignores the field.

**Files:**
- Create: `backend/integration/oldDeviceHello.test-support.ts`, `backend/integration/oldDeviceHello.test.ts`
- Modify: `backend/vitest.integration.config.ts` (one `include` line: `'integration/oldDeviceHello.test.ts',`)

**Interfaces:**
- Consumes: `tests/fixtures/cli-device-hello.json` (Task 2).
- Produces: `oldBackendHello(db: PrismaClient, deviceId: string, msg: { type?: string; payload?: unknown }):
  Promise<void>` (test support only).

- [ ] **Step 1: Write the released path's copy** `oldDeviceHello.test-support.ts`, word for word from
  `git show ac285a931a:backend/src/lib/deviceWs.ts` (`payloadOf`, lines 112-114; `handleHello`'s firmware line,
  1079-1080; its `recordHello` call, 1100-1111) and `git show ac285a931a:backend/src/services/DeviceService.ts`
  (`recordHello`, 202-218), but for `prisma` → `db`, `deviceService.recordHello` → the copy in this file, and the call
  awaited (released: `void`) so the test reads the row after it. Its doc comment names main at `ac285a931a`, the files
  and these three changes, as `oldUsageServer.test-support.ts` does.
- [ ] **Step 2: Write the test** `oldDeviceHello.test.ts`, on `planDatabase('old_device_hello')` from
  `./plans.test-support.js` (a fresh loopback replica set, never `DATABASE_URL`; `afterAll` disconnects and stops it):

```ts
const NEW_CLI_HELLO = JSON.parse(readFileSync(new URL('../../tests/fixtures/cli-device-hello.json', import.meta.url), 'utf8'))
// A row as the released backend left it after an older CLI's hello.
const row = (deviceId: string) => db.deviceBinding.create({ data: { userId: 'owner', deviceId, computerId: deviceId, chip: 'harness-cli', firmwareVersion: '0.6.95' } })
const read = (deviceId: string) => db.deviceBinding.findUnique({ where: { deviceId } })

it('the released backend meets a new CLI\'s hello: the row keeps its last version and nothing fails', async () => {
  await row('cmp-new-cli')
  const warn = vi.spyOn(logger, 'warn') // logger from '../src/utils/logger.js'
  await expect(oldBackendHello(db, 'cmp-new-cli', NEW_CLI_HELLO)).resolves.toBeUndefined()
  expect(await read('cmp-new-cli')).toMatchObject({ chip: 'harness-cli', firmwareVersion: '0.6.95' })
  expect(warn).not.toHaveBeenCalled()
})

it('the copy is the released code: an older CLI\'s hello still writes its firmwareVersion', async () => {
  await row('cmp-old-cli')
  await oldBackendHello(db, 'cmp-old-cli', { type: 'device_hello', payload: { chip: 'harness-cli', firmwareVersion: '0.6.96', caps: ['e2ee_data', 'multi_machine'] } })
  expect((await read('cmp-old-cli'))?.firmwareVersion).toBe('0.6.96')
})
```

- [ ] **Step 3: Add the include line and run it.** `cd backend && npx vitest run --config vitest.integration.config.ts
  integration/oldDeviceHello.test.ts`, then `npm run typecheck`. Expected: 2 PASS, no type error.
- [ ] **Step 4: Commit:** `git add backend/integration/oldDeviceHello.test-support.ts
  backend/integration/oldDeviceHello.test.ts backend/vitest.integration.config.ts && git commit -m "Backend: the
  released backend keeps a device row's version when a new CLI says hello"`.

---

## Verification

**End-to-end check: none.** Every hop runs real code against the one shared hello: the CLI's lane sends exactly the
fixture over a real WebSocket (Task 2); the backend's real socket handler maps it (Task 4); the released backend's copy
meets it on a real MongoDB (Task 6); the read mapping and the `/api/mobile/v1` routes run through Fastify (Task 5). A
live check would need the CLI's device lane open, which happens only while a dial is plugged in, and a call to
`/api/mobile/v1`, which accepts only production SSO tokens (`authenticateAccessToken(token, 'prod', …)`). The repo's
isolated stack (`desktop/scripts/test-terminal-local-e2e.sh`, [Isolated end-to-end testing](../development.md#isolated-end-to-end-testing))
brings up disposable MongoDB, Redis, a backend and a daemon with fixture identities, but no dial and no mobile call: it
would need new rig work for what the tests above already show. No workflow proposal.

What runs instead:

1. **Targeted tests per task** (each task's commands above), on the implementer's machine.
2. **PR CI**, selected by `scripts/ci-plan.py` from the paths (confirm in the `plan` job): `cli-typecheck` and
   `cli-tests` (`cli/`, `tests/`), `pty-checks` and `companions` (a `cli/` change), `backend-desk` and
   `backend-integration` (runs Task 6's file; `tests/fixtures/` is in the backend's `PR_READS`), `cross-read-scan`
   (the new relative reads of `tests/fixtures/` are already declared), `process-checks`, `ci/required`. No end-to-end
   suite is selected: no path is in `WINDOWS_SPECS`, `DIAL_HOST_PATHS` or `DEVICE_APP_PATHS`.
3. **Local gates PR CI does not run: none apply.** `python3 scripts/local-checks.py --list` prints `{}` for this
   plan's paths. `deviceLink.ts` is under `cli/src/device/`, outside `test:core` (`src/core/`, `src/services/`) and
   every other CLI coverage gate; the backend's gates (`test:agent-messages`, `test:sharing`) cover none of these
   files. Run `python3 scripts/local-checks.py --run` from a clean tree at the final commit and paste its output in the
   pull request.
4. **Production numbers** (`backend/AGENTS.md` rule 5): the pull request carries the spec's read-only counts of
   2026-11-27 (280 rows, 89 KB, 317 B a row, 205 KB of indexes, 279 `harness-cli` rows, 26 created and 97 seen in 7
   days). The after numbers: Open question 1.
5. **Platforms:** the CLI change is one payload key with no platform code; `cli-tests` (Linux) runs it, and it behaves
   the same on macOS and Windows. The backend runs on Linux.
6. **Not tested, by reason:** a rolled-back backend reading rows that carry `cliVersion` (spec, Design 6: Prisma
   selects only the fields it declares). A test would need the released Prisma client, which this tree cannot build.

## Open questions

1. `backend/AGENTS.md` rule 5 asks for production numbers before and after in the pull request. Before is in the spec;
   after (rows carrying `cliVersion`) exists only once the backend and CLI releases are out, and the release is not
   this branch's. Is the before set enough for the pull request, with the after count taken read-only by harness-pm
   after the CLI release? (Proposed: yes.)
