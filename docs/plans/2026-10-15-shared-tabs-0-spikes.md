# Shared tabs, step 0: spikes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the two open questions that shape steps 1a to 1c before any product code is written: how a member's
desktop holds another account's harness in one of its tabs, and how the end-to-end suite signs in two accounts.

**Architecture:** Two throwaway probes. Spike A patches the desktop locally to place a Share-backed pane into a tab from
a hand-written roster and watches what the desk sync does to it. Spike B adds a vitest end-to-end file that starts the
real backend with two accounts and two isolated daemons and proves a cross-account Share. Spike A's code is reverted;
Spike B's file is kept only if it becomes the base of the step 1b end-to-end test (decided in Task 3).

**Tech Stack:** Flutter (desktop/), TypeScript + vitest (cli/e2e), Fastify + Prisma backend run from source,
mongodb-memory-server and redis-memory-server from an outside folder.

**Spec:** [docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md](../superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md)
("Size and risks", risks 1 and 3; "Verification").

## Global Constraints

- Nothing here ships. Spike A's desktop changes are reverted at the end of Task 1 (`git checkout -- desktop/`).
- No commits unless the owner asks (repository owner's standing rule); leave findings in the working tree.
- Never test against the developer's own daemon (port 18473) or real `~/.claude`/`~/.codex` from the e2e suite
  (`cli/AGENTS.md`, rule 6). Spike A is the one exception: it runs the real desktop app against real daemons on two
  computers, by hand.
- Findings are written into this file's "Findings" section in English, with numbers (times, pass rates).

## Review Focus

1. A foreign pane removed by the member's other computer: the desk's reconcile (`app_state.dart` ≈16417–16430) drops
   panes the desk tab does not list; with Variant B that must not remove the roster's panes.
2. Layout slot counts diverging (`sizes["N:manual"]` counts local panes, the desk counts its own): the order sync at
   ≈16455 silently skips when `slots.length != inOrder.length`.
3. A pane that types into another account's harness: the read-only panel must refuse input, Close pane must never send
   a stop to the owner, take-control must be absent.
4. Two daemons bound to one backend machine because `IsolatedDaemon` defaults to one `ADAPTER_COMPUTER_ID`.
5. Readiness racing: `/api/status` says `connected` before the backend lists the machine as `running`.

---

### Task 1: Spike A — another account's harness as a pane in a member's tab

**Files (throwaway, reverted at the end):**
- Modify: `desktop/lib/api/api_client.dart` (`machines()`, ≈583–617)
- Modify: `desktop/lib/state/app_state.dart` (`_deskJoin` ≈16109, `_deskProjection` ≈16003–16020, `_deskLayoutOf`,
  `_deskReconcile` ≈16361/16417–16430)
- Create: a roster JSON in the session scratchpad (not in the repo)

**Interfaces:**
- Consumes: Share as it is today — `GET /api/harness-shares`, `Machine.isShared`/`sharedHarnesses`
  (`core/models.dart:70–190`), `TerminalPane.sharedHarness` (`state/terminal_pane.dart:86–87`),
  `SharedHarnessPanel` (`sharing/shared_harness_panel.dart:89–160`).
- Produces: the decision A (desk carries foreign panes) or B (roster owns them), recorded in Findings.

Needs two real accounts signed in on two computers (the Mac and remote-1 with a desktop), or staging accounts.

- [ ] **Step 1: Make a real grant.** On the owner's computer, share one Claude Code harness with the member's email
  (pane menu ▸ Share). On the member's computer read it:

```bash
curl -s -H 'x-adapter-local: 1' http://127.0.0.1:18473/api/harness-shares | jq '.data.machines[0]'
```

Expected: one machine with `shared: true`, `ownerName`, and `shares[0]` holding `id`, `agentId`, `ownerPublicKey`.

- [ ] **Step 2: Write the roster.** In the scratchpad, `roster.json`:

```json
{
  "sharedTabId": "spike0000000000000000000",
  "tabId": "<id of one of the member's own tabs, from the desk>",
  "owner": { "name": "<ownerName>", "publicKey": "<ownerPublicKey>" },
  "harnesses": [
    { "machineId": "<owner machineId>", "agentId": "<agentId>", "name": "<name>", "engine": "claude",
      "grant": { "id": "<share id>", "expiresAt": "<expiresAt>" } }
  ]
}
```

Read the member's tab id with `curl -s -H 'x-adapter-local: 1' http://127.0.0.1:18473/api/desk | jq '.data.tabs[].id'`
(if that route is not proxied, take it from the debug log line `_deskApply` prints).

- [ ] **Step 3: Inject the roster's machine.** In `ApiClient.machines()`, after the shares merge:

```dart
const spikeRoster = String.fromEnvironment('HARNESS_SPIKE_ROSTER');
if (spikeRoster.isNotEmpty) {
  final r = jsonDecode(File(spikeRoster).readAsStringSync()) as Map<String, dynamic>;
  // Reuse the Share machine the merge built: the roster's harness must be in sharedHarnesses
  // or pane_grid.dart:1574 `hasAccess` refuses it.
  debugPrint('[spike] roster ${r['sharedTabId']} harnesses=${(r['harnesses'] as List).length}');
}
```

The Share merge already yields the machine; the spike only proves the roster file is read. If the owner revokes the
share during the spike, note that the pane must say so.

- [ ] **Step 4: Place the pane (Variant A).** Add to `AppNotifier`, called at the end of `_deskJoin` after the
  inventory refresh:

```dart
void spikePlaceRoster() {
  const path = String.fromEnvironment('HARNESS_SPIKE_ROSTER');
  if (path.isEmpty) return;
  final r = jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
  final h = (r['harnesses'] as List).first as Map<String, dynamic>;
  final swarm = swarms.firstWhere((s) => s.id == r['tabId'], orElse: () => activeSwarm);
  if (swarm.panes.any((p) => p.agentId == h['agentId'])) return;
  addPaneToSwarm(swarm, machineId: h['machineId'] as String, agentId: h['agentId'] as String);
  _persistLayout();
}
```

Use the method the Machines picker calls today to add a pane (app_state.dart:15221–15226); if it is not named
`addPaneToSwarm`, call that method instead and note its name in Findings.

- [ ] **Step 5: Run and observe Variant A.**

```bash
cd desktop && flutter pub get && flutter run -d macos --dart-define=HARNESS_SPIKE_ROSTER=/abs/path/roster.json
```

Check and record each in Findings:
1. The pane streams the owner's harness read-only; typing is refused; the composer is hidden.
2. The member's other computer shows the same pane after `desk_changed` (the desk carried it).
3. Close pane on the member's side sends no stop to the owner (owner's harness keeps running).
4. The tab's status slot: does the spinner follow the owner's harness working? (Expected no: the panel's own
   `WsConn` bypasses `_handleEvent`.)
5. Relaunch with the roster file removed: what does the pane show?

- [ ] **Step 6: Variant B.** Mark roster panes (`pane.fromRoster = true` in the spike) and skip them in
  `_deskProjection` and `_deskLayoutOf`; in the `_deskReconcile` removal loop keep a pane whose `fromRoster` is true.
  Repeat Step 5's checks, plus from the member's other computer: rename the tab, move a pane, close a pane, drag a
  divider. Record whether the roster pane survives and whether the order sync still applies (≈16455).

- [ ] **Step 7: Decide and revert.** Write in Findings: A or B, why, and the list of desktop seams step 1c needs
  (status slot feed for remote panes, layout slot handling, restore without inventory). Then:

```bash
git checkout -- desktop/
git status --short desktop/
```

Expected: no changes under `desktop/`.

---

### Task 2: Spike B — two accounts end to end in vitest

**Files:**
- Create: `cli/e2e/harness/realBackend.ts` (kept if Task 3 says so)
- Create: `cli/e2e/twoAccounts.spike.e2e.ts`
- Modify: `cli/e2e/harness/client.ts:46` (`LocalClient.connect` gains `shareId?: string`)

**Interfaces:**
- Consumes: `IsolatedDaemon.create` (`e2e/harness/daemon.ts:224–300`), `LocalClient.connect`, the SSO stand-in and
  backend start from `cli/scripts/remote-viewers-stack.ts:99–136` and `cli/scripts/share-harness-e2e.ts:30,132–191`.
- Produces: `startRealBackend(accounts): Promise<RealBackend>` with
  `{ url: string; wsUrl: string; api(account, path, method?, body?): Promise<{status:number; body:any}>; stop(): Promise<void> }`
  and `signIn(daemonEnv, account): Promise<{ daemon: IsolatedDaemon; machineId: string }>`, for step 1b's test.

- [ ] **Step 1: Install the outside services once.**

```bash
mkdir -p ~/test-services && cd ~/test-services && npm i mongodb-memory-server@11.2.0 redis-memory-server@0.17.1
```

- [ ] **Step 2: Write `realBackend.ts`.** The services loader and backend start from `remote-viewers-stack.ts:99–136`,
  as a helper that knows several accounts (the SSO stand-in maps each token to its account, as
  `share-harness-e2e.ts:132–137` does):

```ts
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer as netServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface Account { name: string; token: string; id: string; email: string }
export const account = (name: string): Account => ({ name, token: `spike-${randomUUID()}`,
  id: randomUUID().replaceAll('-', ''), email: `${name}@spike.invalid` })

export interface RealBackend {
  url: string
  wsUrl: string
  api(a: Account, path: string, method?: string, body?: unknown): Promise<{ status: number; body: any }>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const s = netServer().listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = (s.address() as { port: number }).port
  await new Promise(r => s.close(r))
  return port
}

async function until(label: string, check: () => Promise<boolean>, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check().catch(() => false)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(r => setTimeout(r, 200))
  }
}

export async function startRealBackend(accounts: Account[], log: (line: string) => void): Promise<RealBackend> {
  const services = createRequire(join(resolve(process.env.HARNESS_E2E_SERVICES_DIR!), 'package.json'))
  const { MongoMemoryReplSet } = services('mongodb-memory-server')
  const { RedisMemoryServer } = services('redis-memory-server')
  const stops: Array<() => unknown> = []
  let t = Date.now()
  const mongo = await MongoMemoryReplSet.create({
    binary: { ...(process.env.HARNESS_E2E_MONGOD ? { systemBinary: process.env.HARNESS_E2E_MONGOD } : {}) },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  })
  stops.push(() => mongo.stop())
  const redis = new RedisMemoryServer({ binary: {
    ...(process.env.HARNESS_E2E_REDIS_SERVER ? { systemBinary: process.env.HARNESS_E2E_REDIS_SERVER } : {}) } })
  stops.push(() => redis.stop())
  const redisPort = await redis.getPort()
  const byToken = new Map(accounts.map(a => [`Bearer ${a.token}`, a]))
  const sso = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const a = byToken.get(String(req.headers.authorization))
    if (!a) { res.writeHead(401).end('{}'); return }
    res.end(JSON.stringify({ status: 1, data: { id: a.id, email: a.email } }))
  }).listen(0, '127.0.0.1')
  await once(sso, 'listening')
  stops.push(() => { sso.closeAllConnections(); sso.close() })
  log(`services ${Date.now() - t}ms`)
  const port = await freePort(), proxyPort = await freePort()
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: mongo.getUri('spike'),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, HARNESS_BILLING_ENABLED: 'false', MESH_ENABLED: 'false',
    SSO_PROFILE_URL: `http://127.0.0.1:${(sso.address() as { port: number }).port}/profile`,
    SSO_IDENTITY_URL: '', TERMINAL_P2P_ROLLOUT_PERCENT: '0',
    HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
  t = Date.now()
  await exec(join(repo, 'backend/node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'],
    { cwd: join(repo, 'backend'), env, timeout: 60_000 })
  log(`db push ${Date.now() - t}ms`)
  t = Date.now()
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: join(repo, 'backend'), stdio: 'ignore',
    env: { ...env, PORT: String(port), PORT_APP_PROXY: String(proxyPort), BACKEND_INSTANCE_ID: 'spike-0' } })
  stops.push(() => child.kill('SIGTERM'))
  const url = `http://127.0.0.1:${port}`
  await until('backend health', async () => (await fetch(`${url}/api/health`)).ok)
  log(`backend ${Date.now() - t}ms`)
  return {
    url, wsUrl: `ws://127.0.0.1:${port}`,
    async api(a, path, method = 'GET', body) {
      const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${a.token}`,
        'x-autonomous-env': 'prod', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    async stop() { for (const s of stops.reverse()) await s() },
  }
}
```

- [ ] **Step 3: Give `LocalClient.connect` a share id.** In `cli/e2e/harness/client.ts`, add `shareId?: string` to
  the options and spread it into the `machine_select` payload:

```ts
ws.send(JSON.stringify({ type: 'machine_select', payload: {
  machineId: options.machineId, localProtocolVersion: 1, ...(options.shareId ? { shareId: options.shareId } : {}) } }))
```

- [ ] **Step 4: Write the spike test.** `cli/e2e/twoAccounts.spike.e2e.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IsolatedDaemon } from './harness/daemon.js'
import { LocalClient } from './harness/client.js'
import { account, startRealBackend, type RealBackend, type Account } from './harness/realBackend.js'

const alice = account('alice'), bob = account('bob')
const times: string[] = []
let backend: RealBackend

async function signIn(a: Account) {
  const computerId = randomUUID()
  const r = await backend.api(a, '/api/machines/resolve-computer', 'POST', { computerId, label: a.name })
  const machineId = r.body.data.machine.machineId as string
  const t = Date.now()
  const d = await IsolatedDaemon.create({ env: {
    ADAPTER_COMPUTER_ID: computerId, BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.url,
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200' } })
  writeFileSync(join(d.root, 'auth/session.json'), JSON.stringify({ version: 1, accessToken: a.token,
    refreshToken: 'x', autonomousEnv: 'prod', computerId, machineId,
    expiresAt: Date.now() + 3_600_000, updatedAt: Date.now() }), { mode: 0o600 })
  await d.start()
  await d.until('connected', async () => (await (await fetch(`http://127.0.0.1:${d.port}/api/status`,
    { headers: { 'x-adapter-local': '1' } })).json()).connected === true)
  times.push(`daemon ${a.name} ${Date.now() - t}ms`)
  return { d, machineId, client: await LocalClient.connect(d, { machineId }) }
}

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('two accounts (spike)', () => {
  beforeAll(async () => { backend = await startRealBackend([alice, bob], l => times.push(l)) }, 180_000)
  afterAll(async () => { console.log('timings', times.join(' | ')); await backend?.stop() })

  it('signs in two accounts and shares a harness read-only from one to the other', async () => {
    const A = await signIn(alice), B = await signIn(bob)
    for (const [who, me] of [[alice, A], [bob, B]] as const) {
      await A.d.until(`${who.name} machine running`, async () => {
        const ms = (await backend.api(who, '/api/machines')).body.data.machines
        return ms.length === 1 && ms[0].machineId === me.machineId && ms[0].status === 'running'
      })
    }
    const a1 = await A.client.request('agent_create', { engine: 'claude', folder: A.d.home })
    const t = Date.now()
    const inv = await A.client.request('harness_share_invite', { agentId: a1.agentId, emails: [bob.email], days: 7 })
    expect(inv.shares[0].pending).toBeFalsy()
    const watch = await LocalClient.connect(B.d, { tcp: true, machineId: A.machineId, shareId: inv.shares[0].id })
    const open = await watch.request('terminal_open', { protocolVersion: 3, agentId: a1.agentId, cols: 120, rows: 40 })
    expect(open.readOnly).toBe(true)
    expect((await watch.request('agent_delete', { agentId: a1.agentId })).error).toBe('VIEW_ONLY')
    times.push(`share ${Date.now() - t}ms`)
  }, 300_000)
})
```

Match `agent_create`'s payload and result names to `agentMessages.e2e.ts:30`, and `d.until`/`d.root`/`d.home` to
`IsolatedDaemon`'s real members; adjust the spike, not the harness, if they differ.

- [ ] **Step 5: Run once.**

```bash
cd cli && HARNESS_E2E_SERVICES_DIR=~/test-services npx vitest run --config vitest.e2e.config.ts e2e/twoAccounts.spike.e2e.ts
```

Expected: 1 passed, and a `timings` line with services, db push, backend, two daemons and share.

- [ ] **Step 6: Run ten times and measure.**

```bash
cd cli && for i in $(seq 10); do HARNESS_E2E_SERVICES_DIR=~/test-services npx vitest run --config vitest.e2e.config.ts e2e/twoAccounts.spike.e2e.ts 2>&1 | grep -E 'passed|failed|timings'; done
pgrep -fl mongod; pgrep -fl redis-server
```

Record pass rate, p50/p95 per phase, `EADDRINUSE` count, and leftover processes in Findings.

---

### Task 3: Record findings and adjust the plans

**Files:**
- Modify: this file, "Findings"
- Modify: `docs/plans/2026-10-15-shared-tabs-1a-trust-and-transport.md` if a finding changes a task
- Modify: the spec's "Size and risks" if a risk is retired or grows

- [ ] **Step 1:** Fill Findings below (A or B with reasons; desktop seams for 1c; two-account timings and pass rate).
- [ ] **Step 2:** Decide whether `realBackend.ts` and `client.ts`'s `shareId` stay as the base of step 1b's end-to-end
  test. If not, `git checkout -- cli/e2e && rm cli/e2e/harness/realBackend.ts cli/e2e/twoAccounts.spike.e2e.ts`.
- [ ] **Step 3:** Update the spec's risks 1 and 3 with the measured answers.

## Findings

Recorded 2026-10-15. Reports: `.superpowers/sdd/2026-10-15-shared-tabs-0-spikes/task-1-report.md`, `task-2-report.md`.

### Spike A: Variant A, the desk carries the foreign pane

Run with two fake accounts on a local backend (owner's choice), Bob's desktop built as a separate app
(`ai.autonomous.harness.spike`) against Bob's isolated daemon; "Bob's other computer" simulated through the desk API.

- **A works with what the desk already does:** every computer of the member gets the pane, order and layout sync
  agree (slots and counts match the desk), Close is one `pane.remove` and stops nothing on the owner's side, and
  restore needs no roster (the desk and the Share grant hold it).
- **B breaks the desk's invariants** in any tab holding a roster pane (local count differs from the desk's): moves
  from other computers are skipped then reverted, count-keyed layouts wipe each other, a closed roster pane comes
  back. Making B correct means teaching reconcile, order sync, layouts, freezing and Close about a second kind of
  pane.
- **So:** roster membership (who is in the shared tab) and desk presence (where the member put the pane) are
  separate facts. The roster places a pane once, as a desk `pane.add` per member (not per launch); after that the
  desk owns where it sits and whether it is closed.

Seams step 1c needs:
1. **Status slot for remote panes:** a shared machine's activity is never fed, so the tab spinner and attention
   marks ignore foreign panes (confirmed in both variants). Either the panel forwards turn events into the shared
   machine's `MachineState`, or the owner's observer channel sends an activity frame (`observer_activity`).
2. **A desk-carried foreign pane must render as shared at once:** `_deskReconcile`/`_attachPendingPanes` must set
   `sharedHarness`/`sharedOwnerName` when the machine is shared; today it shows "Open here" (a takeover offer) for
   up to 5 minutes until the machine list is re-read. Re-read `/api/harness-shares` when the desk names an unknown
   machine.
3. **Restore without inventory:** an "other account · waiting" state from the desk entry; "Sharing ended" with
   Remove after a revoke.
4. **Close never routes a stop** to a shared machine, including the tab-close review (`requestCloseSwarm`).
5. **Status bar** for a focused foreign pane shows the owner's name, not the machine id.

### Spike B: two accounts in vitest work

- 10/10 runs passed, about 25 s each: services p50 12.2 s (p95 20.2 s), `prisma db push` 2.9 s, backend 0.8 s,
  each daemon about 2.3 s, share 0.8 s; 0 `EADDRINUSE`; no leftover processes. First use downloads MongoDB and
  Redis into `~/test-services` (about 75 s, once).
- Kept for step 1b: `cli/e2e/harness/realBackend.ts` (`startRealBackend`, `account`, `signIn`) and
  `LocalClient.connect`'s `shareId`; `cli/e2e/twoAccounts.spike.e2e.ts` stays as the smoke test for that harness.
  Kept for step 1c: `cli/scripts/spike-a-stack.ts`, a two-account local stack a desktop can run against.

### Effect on the plans

- 1a: unchanged.
- 1b: roster harnesses must reach the member's inventory the way Share grants do (`/api/harness-shares` or its
  successor), because the desk-carried pane finds its grant there; the derived observer grants task covers it.
- 1c: built on Variant A with the five seams above.
