# Shared tabs 1c: the desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person shares a tab, invites people, accepts an invitation, adds harnesses, watches the tab's messages,
people and tasks, and recovers from the trust situations 1b detects, on the desktop or the web, without a terminal.

**Architecture:** Five small daemon additions come first (a push frame for the windows, notices on disk with dismiss,
a distinct too-old code, the tab's working state across accounts, and per-harness repo and branch), then one
`SharedTabsController` on `AppNotifier` that reads `shares` from this computer's daemon, places other accounts'
panes once through the desk (step 0 Variant A), and feeds the tab row, menus, dialogs and the Show Agent Messages
panel. The macOS tab row is native (`SwarmTitlebar.swift`); everything else is shared Flutter code for desktop and web.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/` and `backend/`; Dart/Flutter (desktop + web) in `desktop/`;
Swift (AppKit) for the macOS tab row.

**Spec:** `docs/superpowers/specs/2026-10-16-shared-tabs-desktop-design.md` (the "1c spec"), built on
`docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md` (the "base spec"). Steps 1a and 1b:
`docs/plans/2026-10-15-shared-tabs-1a-trust-and-transport.md`, `docs/plans/2026-10-15-shared-tabs-1b-delivery.md`
(its Follow-ups list what 1c closes).

## Global Constraints

- Copy follows `docs/naming-system.md`: "shared tab", "member", "leader"; never "team".
- Every failure says what happened and what to do (the 1c spec's Errors table is the copy, verbatim).
- Strings from another account (names, emails, tab names, issue titles) are shown as plain text, never as markup.
- Waiting is drawn in the shape of the answer (skeletons for People and Tasks); "loading" and "nothing" never look alike.
- The web is mouse-first: everything in a native menu or a chord is also clickable.
- The controller reads `shares` again on `shared_tabs_changed`, when a panel opens, and every 60 s while the window is
  in front; nothing polls in the background.
- Limits shown to people: 32 harnesses, 8 people, 120 messages in 10 minutes.
- Agent Messages stays off by default; nothing changes for anyone who has not turned it on.
- `npm run test:shared-tabs` and `npm run test:core` stay at 100% per file (Node 24: `npx -y node@24` or nvm).
- Never test against the developer's own daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex` or the real tmux
  server. Tests never run the real `gh`. Never touch the installed `/Applications/Harness.app` or its state: a desktop
  run by hand is built under the bundle id `ai.autonomous.harness.spike`.
- **No commits.** The owner's rule: leave every change in the working tree. Where a task says "Checkpoint", the
  controller snapshots the tree as a dangling commit for review; the implementer never runs `git commit`, `stash` or
  `push`.
- Desktop checks: `cd desktop && flutter analyze` and `make -C .. desktop-test`; web: `flutter test --platform=chrome
  --dart-define=HARNESS_TEST=true test/web/...`.

## Rulings this plan makes (beyond the spec)

The 1c spec leaves these open or assumes something the code does not have. Task D2 writes them into the spec.

- **R1 A member's desk tab id is derived from the `sharedTabId`** (changed in the final fix wave): the first 32 hex
  characters of sha256('harness-member-tab' + sharedTabId) (`memberDeskTabId`). Desk `tab.create` takes the client's
  id, so every computer of the member computes the same id and nothing is stored. It is a desk id in shape (32
  lowercase hex, `isDeskId`), so a released desktop on another computer of the member leaves it alone; the raw 24-hex
  `sharedTabId` was not, and such a desktop gave the tab a fresh id at every launch and seeded a duplicate onto the
  desk. The daemon still files a member's tab under the `sharedTabId`, so the desktop maps between the two: Show Agent
  Messages reads the `sharedTabId` log (messages across accounts) and the desk tab's (the member's own harnesses), and
  `messages_changed` for a `sharedTabId` counts in the derived desk tab. The owner's desk tab is the tab it shared:
  `shares` returns `tabId` for each roster the account owns (null for a member's).
- **R2 Placed once, recorded per computer.** Each computer keeps, per shared tab, the other accounts' harnesses it has
  seen in the roster (key-value store, `shared_tabs.placed`). A harness not seen before is placed with a desk
  `pane.add`, unless the desk already holds it in any tab. On the first sight of a tab whose desk tab exists, only
  harnesses the desk holds nowhere are placed. A member's desk tab is created only on the first sight of that tab on
  this computer; one the person closed is never created again here. Cost if wrong: a pane the person closed comes back
  once when they first use a new computer.
- **R3 People shows repo and branch through `who`.** A roster carries no state, repo or branch (`roster.ts`). A new
  action `share_who` asks each machine of the tab the existing `who` (project, branch) with a 4 s deadline; a machine
  that does not answer shows its harnesses without them.
- **R4 The status slot follows other accounts' harnesses through the tab's sessions** (seam 1). The observer channel
  carries no turn state, and a `SharedHarnessPanel` exists only on screen. Each daemon reads its own listed harnesses'
  working state from the core (a new `activity` query) on its 5 s tick and sends changes, plus a renewal every 20 s
  while working, to the tab's machines of other accounts (`activity`, sealed like every tab request). The receiving
  daemon tells its windows (`shared_activity`). Only working/idle: a "?" for another account's question is not shown
  (only its owner can answer it).
- **R5 The web has no push.** Window frames reach only this computer's windows. The browser sends `agent_messages`
  to one of the account's own machines (the first online own machine, `ownedActionMachine` when it is the account's
  own) and relies on reads on open, after its own actions, and the 60 s fallback. **Move here** is not offered on the
  web (there is no "here").
- **R6 Capability marker.** `shares` answers `api: 2` from this step on. A daemon without `me` in its answer (1b,
  which never shipped) reads as unavailable, so the desktop has no local-only dismiss for it (removed in the final fix
  wave as unreachable). A dismiss the daemon could not be told about is still hidden in that window.
- **R7 Invitation notice and tab name.** The invitation notice is the desktop's: a pending invitation whose id this
  computer has not shown before (key-value store, `shared_tabs.invites_seen`). Its tab name comes from the backend
  (`tabName`, read from the roster it stores; unverified, shown only before Accept); an older backend gives none and
  the copy says "a tab".
- **R8 The Share form in tab mode.** `ShareHarnessDialog` gains `tabMode`: no Copy, Access or Comments rows, and at
  most 8 addresses.
- **R9 Seam 4 already holds** (`_requestViewClose` skips shared machines, `app_state.dart` ~2522): tests only.

## Review Focus

Five conditions the spec implies that no feature test exercises by itself, most likely first. Each has its test in
the owning task.

1. **The member closes the shared tab, then someone adds a harness:** the tab must not come back on that computer
   (R2). Test in Task B3.
2. **Two of the member's computers (or two windows) see a new roster at once:** one tab and one pane on the desk, never
   two. Test in Task B3 (desk ops are idempotent; the test asserts the desk document).
3. **The daemon restarts or the window reconnects while a tab is shared:** the window reads `shares` again on
   reconnect, not 60 s later. Test in Task B2.
4. **Sign-out or an account switch while a `shares` or `share_tasks` read is in flight:** the late answer is dropped
   and nothing of the old account shows. Test in Task B1.
5. **Hostile strings from another account** (a 200-character name with a bidi override, an email with markup, a tab
   name of control characters) in the tab row, menus, chips, People and Tasks: shown as plain text, ellipsized, never
   wider than the row. Tests in Tasks C1 and C5.

## File map

| File | Responsibility | Task |
|---|---|---|
| `cli/src/core/api.ts` | window frame names, `MESSAGES_QUERIES += activity`, `CoreApi.agents.activity` + fallback | A1, A4 |
| `cli/src/core/messagesLink.ts` (+ spec) | `windows` accepts the three frames; `activity` query | A1, A4 |
| `cli/src/core/main.ts` | wires `agents.activity` to the core's activity frames | A4 |
| `cli/src/services/processCoreApi.ts`, `messagesProcess.ts` (+ specs) | `agents.activity` asked of the core; `DAEMON_TOO_OLD` | A3, A4 |
| `cli/src/messages/noticeStore.ts` (new, + spec) | notices on disk with id and read flag | A2 |
| `cli/src/messages/tabActivity.ts` (new, + spec) | what to send and what was heard of a tab's working state | A4 |
| `cli/src/messages/rosterStore.ts` (+ spec) | alert ids, dismissed flag, `onChange(kind)` | A1, A2 |
| `cli/src/messages/sharedTabs.ts` (+ specs) | `announce`, digest of invites and untrusted, notice store, `tabName` | A1, A2, A5 |
| `cli/src/messages/service.ts` (+ `service.sharedTabs.spec.ts`) | `tellShares`, `share_notice_dismiss`, `share_who`, activity tick and answer, `shares` shape | A1, A2, A4, A5 |
| `cli/vitest.shared-tabs.config.ts` | gate the two new files | A2, A4 |
| `backend/src/lib/agentMessageShares.ts` (+ test) | `tabName` on pending invitations | A5 |
| `cli/e2e/sharedTabs.e2e.ts`, `cli/e2e/messagesSkew.e2e.ts` | push, activity and `who` end to end; too-old code | A3, A6 |
| `desktop/lib/agent_messages/shared_tabs_model.dart` (new) | parsing `shares` and the action answers | B1 |
| `desktop/lib/agent_messages/shared_tabs.dart` (new) | `SharedTabsController`, `SharedTabsWatch` | B1 |
| `desktop/lib/agent_messages/shared_tab_placement.dart` (new) | the pure placement rule (R2) | B3 |
| `desktop/lib/state/app_state.dart` | wiring, events, seams 1–5, placement, `share_add` hooks | B2, B3, C4 |
| `desktop/lib/widgets/pane_grid.dart`, `lib/sharing/shared_harness_panel.dart`, `lib/state/workspace_status.dart` | waiting / ended copy, chips, status bar | B3, C4 |
| `desktop/macos/Runner/SwarmTitlebar.swift`, `lib/screens/swarm_screen.dart`, `lib/screens/swarm_menu_bus.dart`, `lib/widgets/linux_menu_bar.dart`, `lib/widgets/desktop_workspace_tab.dart`, `lib/web/tabs/web_tab_menu.dart`, `lib/shortcuts/keymap_commands.dart` | tab mark and menus | C1 |
| `desktop/lib/agent_messages/shared_tab_dialogs.dart` (new), `lib/sharing/share_harness_dialog.dart` | Invite, Accept, Add harnesses, Stop, Leave, Move here, Trust again | C2, C3 |
| `desktop/lib/settings/...`, `lib/widgets/shared_tab_notice.dart` (new), `lib/app_shell.dart` | Tab invites section, the notice, switch copy | C3 |
| `desktop/lib/agent_messages/agent_messages_view.dart`, `shared_tab_people.dart` (new), `shared_tab_tasks.dart` (new) | the three-tab panel, alerts and bands | C5 |

---

## Phase A: daemon and backend additions

Built and tested before any desktop work. Each task keeps `test:shared-tabs` and `test:core` at 100%.

### Task A1: `shared_tabs_changed`, and what `shares` says about itself

**Files:**
- Modify: `cli/src/core/api.ts` (~736: frame names), `cli/src/core/messagesLink.ts` (~79–85: `windows`)
- Modify: `cli/src/messages/rosterStore.ts` (`save`, constructor callback), `cli/src/messages/sharedTabs.ts`
  (`SharedTabsDeps.announce`, `refresh`, `untrusted`, request queue saves), `cli/src/messages/service.ts` (`sharedUp`
  ~1134, `sharedDown`, `shares` default case ~1204)
- Test: `cli/src/core/messagesLink.spec.ts` (~106), `cli/src/messages/rosterStore.spec.ts`,
  `cli/src/messages/sharedTabs.spec.ts`, `cli/src/messages/service.sharedTabs.spec.ts`

**Interfaces:**
- Produces: `SHARED_TABS_WINDOW_FRAME = 'shared_tabs_changed'`, `SHARED_ACTIVITY_WINDOW_FRAME = 'shared_activity'`,
  `MESSAGES_WINDOW_FRAMES: readonly string[]` (api.ts). Frame payload `{ rev: number }`.
- Produces: `SHARES_COALESCE_MS = 250` (service.ts, exported). `SharedTabsDeps.announce?(): void`.
- Produces: `RosterStore` constructor callback `(kind: 'tabs' | 'alerts') => void` (was `() => void`, called only for
  tabs).
- Produces: the `shares` answer `{ api: 2, me: { accountId, email, machineId }, rosters: Array<Roster & { tabId: string |
  null }>, invites, alerts, pending, notices, untrusted }` (A4 adds `activity`).

- [ ] **Step 1: Write the failing tests**

`messagesLink.spec.ts`, replacing the body of "tells the windows its log changed, and nothing else":

```ts
it('tells the windows its log or its shared tabs changed, and nothing else', async () => {
  const windows = vi.fn()
  const { link: l } = link({ clients: { windows } })
  for (const type of ['messages_changed', 'shared_tabs_changed', 'shared_activity']) {
    expect(await l.answer('windows', { frame: { type, payload: { tabId: 'app' }, extra: 1 } })).toEqual({})
  }
  expect(windows.mock.calls).toEqual([
    [{ type: 'messages_changed', payload: { tabId: 'app' } }],
    [{ type: 'shared_tabs_changed', payload: { tabId: 'app' } }],
    [{ type: 'shared_activity', payload: { tabId: 'app' } }],
  ])
  for (const frame of [undefined, { type: 'agents' , payload: {} }, { type: 'shared_tabs_changed' }, { type: 'shared_tabs_changed', payload: 'x' }]) {
    expect(await l.answer('windows', { frame })).toEqual({ error: 'INVALID_FRAME' })
  }
  expect(windows).toHaveBeenCalledTimes(3)
})
```

`rosterStore.spec.ts`:

```ts
it('tells its owner whether tabs or only alerts changed', () => {
  const kinds: string[] = []
  const store = new RosterStore(join(dir, 'r.json'), () => 1_000, (kind) => kinds.push(kind))
  store.alert(TAB, 'bad_signature')
  store.pin(TAB, OWNER_PUB)
  expect(kinds).toEqual(['alerts', 'tabs'])
})
```

`service.sharedTabs.spec.ts` (use the file's existing world helpers; `windowFrames(t)` is the list of frames the fake
core's `clients.windows` received — add that accessor to the helper if it does not exist):

```ts
it('tells the windows once when a refresh changes shares, coalesced', async () => {
  vi.useFakeTimers()
  const t = await world()                       // the file's helper, awake, one held roster
  t.backend.invites.push(INVITE_FOR_BOB)        // a new pending invitation
  await t.notice({ type: 'desk_changed' })      // refresh: reads shares and invites
  await vi.advanceTimersByTimeAsync(SHARES_COALESCE_MS)
  expect(windowFrames(t).filter((f) => f.type === 'shared_tabs_changed')).toEqual([{ type: 'shared_tabs_changed', payload: { rev: 1 } }])
  await t.notice({ type: 'desk_changed' })      // nothing changed this time
  await vi.advanceTimersByTimeAsync(SHARES_COALESCE_MS)
  expect(windowFrames(t).filter((f) => f.type === 'shared_tabs_changed')).toHaveLength(1)
})

it('tells the windows when an alert, a notice or a waiting request changes', async () => { /* one case each:
   rosters.alert(...) → one frame; a TAB_FULL refusal (notice) → one frame; share_add that queues while the owner is
   away (pending) → one frame. Advance SHARES_COALESCE_MS after each and count frames. */ })

it('says what it is and who asks, and names the desk tab of an owned roster', async () => {
  const t = await world()
  expect(await t.ask({ action: 'shares' }, OWNER_REMOTE)).toMatchObject({
    api: 2, me: { accountId: ALICE.accountId, email: ALICE.email, machineId: t.machineId },
    rosters: [{ sharedTabId: SHARE_A, tabId: 'app' }],
  })
  const bob = await world({ as: BOB })          // a member holding SHARE_A
  expect(await bob.ask({ action: 'shares' })).toMatchObject({ rosters: [{ sharedTabId: SHARE_A, tabId: null }] })
})

it('sends no frame after it sleeps', async () => { /* sharedDown clears the pending timer: alert, sleep, advance
   SHARES_COALESCE_MS, expect no shared_tabs_changed */ })
```

The fourth test in the second block must be written out in full by the implementer in the file's style; each of its
three cases asserts exactly one `shared_tabs_changed` frame.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd cli && npx vitest run src/core/messagesLink.spec.ts src/messages/rosterStore.spec.ts src/messages/service.sharedTabs.spec.ts`
Expected: FAIL (`INVALID_FRAME` for the new frames; `kinds` is `['tabs']`; no `api` in `shares`).

- [ ] **Step 3: Implement**

`api.ts`, beside `MESSAGES_WINDOW_FRAME`:

```ts
export const MESSAGES_WINDOW_FRAME = 'messages_changed'
/** Shared tabs changed on this computer (a roster, an invitation, an alert, a notice, a waiting request or the
 *  untrusted list): the windows read `shares` again. Only a revision: what changed is read, never pushed. */
export const SHARED_TABS_WINDOW_FRAME = 'shared_tabs_changed'
/** Another account's harness in a shared tab started or stopped working (messages/tabActivity.ts). */
export const SHARED_ACTIVITY_WINDOW_FRAME = 'shared_activity'
/** What Agent Messages may tell this computer's windows (core/messagesLink.ts `windows`), and nothing else. */
export const MESSAGES_WINDOW_FRAMES: readonly string[] = [MESSAGES_WINDOW_FRAME, SHARED_TABS_WINDOW_FRAME, SHARED_ACTIVITY_WINDOW_FRAME]
```

`messagesLink.ts`:

```ts
case 'windows': {
  const frame = payload.frame as Payload | undefined
  // Its log, its shared tabs or their harnesses' work changed, and nothing else: what the windows hear from the core
  // itself is the core's to say.
  if (typeof frame?.type !== 'string' || !MESSAGES_WINDOW_FRAMES.includes(frame.type) || !frame.payload || typeof frame.payload !== 'object') return { error: 'INVALID_FRAME' }
  core.clients.windows({ type: frame.type, payload: frame.payload as Payload })
  return {}
}
```

An older core answers the new frames `INVALID_FRAME`; `processCoreApi.ts` already drops the answer
(`windows: (frame) => { void ask?.('windows', { frame }).catch(() => {}) }`), so nothing else changes there.

`rosterStore.ts`: the constructor's callback becomes `onChange?: (kind: 'tabs' | 'alerts') => void`, and `save`:

```ts
private save(tabs = true): void {
  mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
  const temp = `${this.path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 })
  renameSync(temp, this.path)
  // An alert alone changes nothing Share derives or the consent follows (final review of 1b), but the windows show it.
  this.onChange?.(tabs ? 'tabs' : 'alerts')
}
```

`service.ts`, `sharedUp`:

```ts
rosters ??= new RosterStore(join(stateDir, 'shared-tabs.json'), now, (kind) => {
  if (kind === 'tabs') {
    if (rosters) consent?.reconcile((id) => rosters?.current(id)?.roster ?? null)
    options.observers?.()
  }
  tellShares()
})
```

and pass `announce: tellShares` in the `new SharedTabs({ ... })` deps. Beside the other module state:

```ts
/** How long the windows' `shared_tabs_changed` waits for more of the same change: a refresh that takes a roster,
 *  alerts and announces sends one frame, not three. */
export const SHARES_COALESCE_MS = 250
let sharesRev = 0
let sharesTimer: ReturnType<typeof setTimeout> | null = null
function tellShares(): void {
  if (sharesTimer) return
  sharesTimer = setTimeout(() => {
    sharesTimer = null
    core.clients.windows({ type: SHARED_TABS_WINDOW_FRAME, payload: { rev: ++sharesRev } })
  }, SHARES_COALESCE_MS)
  sharesTimer.unref?.()
}
```

`sharedDown` clears it (`if (sharesTimer) clearTimeout(sharesTimer); sharesTimer = null`).

`sharedTabs.ts`:
- `SharedTabsDeps.announce?(): void` — "What the windows show changed: a notice, a waiting request, or the
  invitations or untrusted tabs a refresh read (service.ts tells them `shared_tabs_changed`)."
- Call `this.deps.announce?.()` at the end of `notice()` and wherever the request queue is saved (each
  `this.deps.requests?.save(...)` site; one call per save).
- Factor the filter out of `untrusted()` into `private untrustedOf(shares: ShareView[], me: Me)`; `untrusted()` calls it.
- In `refresh()`, keep the shares it read and, after the relays, announce when invitations or untrusted tabs changed:

```ts
refresh(): Promise<void> {
  return this.serial(async () => {
    if (this.closed) return
    if (this.unloaded) this.restore()
    const shares = await this.shares().catch((error: unknown) => {
      if (error instanceof MessageError && error.code === 'SHARED_TABS_UNSUPPORTED') return null
      throw error
    })
    await this.reread(shares)
    for (const roster of this.deps.store.all()) await this.openRelay(roster.sharedTabId)
    if (shares) await this.announceIfChanged(shares)
    this.deps.changed?.()
  })
}

/** The invitations and untrusted tabs as last told, so a refresh that changed neither tells the windows nothing. */
private told = ''
private async announceIfChanged(shares: ShareView[]): Promise<void> {
  const invites = await this.invites().catch(() => null)
  if (!invites) return
  const untrusted = this.untrustedOf(shares, await this.self())
  const digest = JSON.stringify([invites.map((i) => i.id).sort(), untrusted.map((u) => u.sharedTabId).sort()])
  if (digest === this.told) return
  this.told = digest
  this.deps.announce?.()
}
```

`service.ts`, the `shares` default case:

```ts
default: /* shares */ {
  const me = await signedInAs()
  return { api: 2, me: { accountId: me.accountId, email: me.email, machineId: me.machineId },
    rosters: shared.rosters().map((r) => ({ ...r, tabId: r.owner.accountId === me.accountId ? shared.deskTab(r.sharedTabId) : null })),
    invites: await shared.invites(), alerts: rosters.alerts(), pending: shared.pending(), notices: shared.notices(),
    untrusted: await shared.untrusted() }
}
```

(`signedInAs` is the function `sharedUp` passes as `self`; use whatever name the file gives it.)

- [ ] **Step 4: Run the tests to see them pass, then the gates**

Run: `cd cli && npx vitest run src/core/messagesLink.spec.ts src/messages/rosterStore.spec.ts src/messages/sharedTabs.spec.ts src/messages/service.sharedTabs.spec.ts && npm run test:shared-tabs && npm run test:core && npm run typecheck`
Expected: PASS, both gates at 100%. Update `service.sharedTabs.spec.ts` ~141 and ~216 (`shares` now carries `api`,
`me`, `tabId`) with `toMatchObject`, not by loosening other fields.

- [ ] **Step 5: Checkpoint** (controller snapshot; no commit).

### Task A2: notices on disk, alert ids, and `share_notice_dismiss`

**Files:**
- Create: `cli/src/messages/noticeStore.ts`, `cli/src/messages/noticeStore.spec.ts`
- Modify: `cli/src/messages/sharedTabs.ts` (~78 `NOTICES_MAX`, ~118 `SharedNotice`, ~165 `noticed`, ~669 `full`,
  ~1017 `notices`, ~1022 `notice`, ~1060 `unsent`), `cli/src/messages/rosterStore.ts` (alerts), `cli/src/messages/service.ts`
  (`SHARE_ACTIONS` ~124, `sharedUp`, `shareAction` ~1187–1205), `cli/vitest.shared-tabs.config.ts` (FILES)
- Test: `cli/src/messages/sharedTabs.spec.ts` (~408–546), `rosterStore.spec.ts`, `service.sharedTabs.spec.ts` (ACTIONS :32),
  `sharedTabs.integration.spec.ts`

**Interfaces:**
- Produces: `class NoticeStore { constructor(path: string | null, now?: () => number); add(n: Omit<SharedNotice, 'id' | 'at'>): SharedNotice; unread(): SharedNotice[]; dismiss(id: string): boolean }`, `NOTICES_KEPT = 100`.
- Produces: `SharedNotice` gains `id: string`. `RosterAlert` gains `id: string` and `dismissed?: true`.
  `RosterStore.dismiss(id: string): boolean`; `alerts()` returns the undismissed ones.
- Produces: `SharedTabs.dismissNotice(id: string): boolean`; `SharedTabsDeps.notices?: NoticeStore` (unset: memory only).
- Produces: action `share_notice_dismiss { id }` → `{ ok: true }`, or `NOT_FOUND` "That notice is already gone."

- [ ] **Step 1: Write the failing tests**

`noticeStore.spec.ts`:

```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTICES_KEPT, NoticeStore } from './noticeStore.js'

const TAB = 'a'.repeat(24)
const dir = () => mkdtempSync(join(tmpdir(), 'notices-'))

describe('NoticeStore', () => {
  it('keeps notices on disk, unread until dismissed', () => {
    const path = join(dir(), 'n.json')
    const store = new NoticeStore(path, () => Date.parse('2026-10-16T10:00:00Z'))
    const n = store.add({ sharedTabId: TAB, kind: 'removed' })
    expect(n).toEqual({ id: expect.any(String), sharedTabId: TAB, kind: 'removed', at: '2026-10-16T10:00:00.000Z' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const again = new NoticeStore(path)
    expect(again.unread()).toEqual([n])
    expect(again.dismiss(n.id)).toBe(true)
    expect(again.dismiss(n.id)).toBe(false)
    expect(new NoticeStore(path).unread()).toEqual([])
  })
  it(`keeps the newest ${NOTICES_KEPT}`, () => {
    const store = new NoticeStore(join(dir(), 'n.json'))
    for (let i = 0; i < NOTICES_KEPT + 5; i++) store.add({ sharedTabId: TAB, kind: 'unsent', machineId: `m${i}` })
    const unread = store.unread()
    expect(unread).toHaveLength(NOTICES_KEPT)
    expect(unread[0].machineId).toBe('m5')
  })
  it('moves an unreadable file aside and starts again', () => {
    const d = dir(), path = join(d, 'n.json')
    writeFileSync(path, '{not json')
    expect(new NoticeStore(path, () => 7).unread()).toEqual([])
    expect(readFileSync(join(d, 'n.json.unreadable-7'), 'utf8')).toBe('{not json')
  })
  it('lives in memory without a path', () => {
    const store = new NoticeStore(null)
    const n = store.add({ sharedTabId: TAB, kind: 'full', error: 'TAB_FULL' })
    expect(store.unread()).toEqual([n])
  })
  it('throws a read error other than a missing file, so a whole file is never written over', () => { /* path is a
     directory → EISDIR from readFileSync → the constructor throws */ })
  it('skips a removed notice when the newest unread one for that tab already says removed', () => {
    const store = new NoticeStore(null)
    store.add({ sharedTabId: TAB, kind: 'removed' })
    store.add({ sharedTabId: TAB, kind: 'removed' })
    expect(store.unread()).toHaveLength(1)
  })
})
```

The last case closes the 1b follow-up "a flapping 4403 backend repeats the `removed` notice".

`rosterStore.spec.ts`:

```ts
it('gives each alert an id, hides a dismissed one, and starts a new one when it happens again', () => {
  let t = 1_000
  const store = new RosterStore(join(dir, 'r.json'), () => t)
  store.alert(TAB, 'bad_signature')
  const [a] = store.alerts()
  expect(a).toMatchObject({ id: expect.any(String), sharedTabId: TAB, error: 'bad_signature' })
  expect(store.dismiss(a.id)).toBe(true)
  expect(store.alerts()).toEqual([])
  t += 1_000
  store.alert(TAB, 'bad_signature')                       // within ALERT_WINDOW_MS, but the last was dismissed
  expect(store.alerts()).toEqual([expect.objectContaining({ error: 'bad_signature', count: undefined })])
  expect(store.alerts()[0].id).not.toBe(a.id)
  expect(store.dismiss('nope')).toBe(false)
})
it('gives an id to an alert a file from 1b kept without one', () => { /* write { tabs: {}, alerts: [{ sharedTabId,
   at, error }] }, load, expect alerts()[0].id to be a string, and the same id after a second load */ })
```

`sharedTabs.spec.ts`: the cases at ~408–546 now expect notices with `id: expect.any(String)`, and a second
`notices()` returns the same unread list (no drain). Add:

```ts
it('keeps a notice until it is dismissed, and announces both', async () => {
  const announce = vi.fn()
  const w = await world({ announce })          // the file's helper; pass announce into SharedTabsDeps
  // ... the existing TAB_FULL refusal setup from ~456 ...
  const [n] = w.bob.shared.notices()
  expect(w.bob.shared.notices()).toEqual([n])
  expect(w.bob.shared.dismissNotice(n.id)).toBe(true)
  expect(w.bob.shared.notices()).toEqual([])
  expect(announce).toHaveBeenCalledTimes(2)
})
```

`service.sharedTabs.spec.ts`: add `'share_notice_dismiss'` to `ACTIONS` (:32) and:

```ts
it('dismisses a notice or an alert by id', async () => {
  const t = await world()
  rosterStoreOf(t).alert(SHARE_A, 'bad_signature')
  const { alerts } = await t.ask({ action: 'shares' })
  expect(await t.ask({ action: 'share_notice_dismiss', id: alerts[0].id })).toEqual({ ok: true })
  expect(await t.ask({ action: 'shares' })).toMatchObject({ alerts: [] })
  expect(await t.ask({ action: 'share_notice_dismiss', id: 'gone' })).toMatchObject({ error: 'NOT_FOUND' })
})
it('keeps notices across a restart of the service', async () => { /* a 'removed' notice, stop and start the service
   on the same stateDir, `shares` still lists it */ })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/messages/noticeStore.spec.ts src/messages/rosterStore.spec.ts src/messages/sharedTabs.spec.ts src/messages/service.sharedTabs.spec.ts`
Expected: FAIL (no module `noticeStore`; alerts have no `id`; `notices()` drains).

- [ ] **Step 3: Implement**

`noticeStore.ts` (the `RequestStore` pattern, `requestStore.ts`):

```ts
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { SharedNotice } from './sharedTabs.js'

/**
 * What happened in a shared tab that the person has not dismissed, kept on disk: in memory they vanished when the
 * computer slept or the process restarted, before any window showed them (1b follow-up). Bounded: the oldest go first.
 */
export const NOTICES_KEPT = 100
const notice = z.object({ id: z.string(), sharedTabId: z.string(), kind: z.enum(['refused', 'removed', 'relay_taken', 'full', 'unsent']),
  at: z.string(), error: z.string().optional(), machineId: z.string().optional(), agentId: z.string().optional(), read: z.literal(true).optional() }).strict()
type Kept = z.infer<typeof notice>

export class NoticeStore {
  private list: Kept[]
  constructor(private readonly path: string | null, private readonly now = () => Date.now()) {
    this.list = path ? this.load(path) : []
  }

  /** None when there is no file yet; an unreadable one is moved aside. Any other read error is thrown, so a whole file
   *  is never written over by an empty list (review of A7, 1b). */
  private load(path: string): Kept[] {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let json: unknown = null
    try { json = JSON.parse(raw) } catch { /* unreadable below */ }
    const parsed = z.array(notice).safeParse(json)
    if (parsed.success) return parsed.data
    try { renameSync(path, `${path}.unreadable-${this.now()}`) } catch { /* nothing more to do */ }
    return []
  }

  private save(): void {
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.list), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
  }

  add(n: Omit<SharedNotice, 'id' | 'at'>): SharedNotice {
    // A backend that keeps listing a membership its relay keeps refusing would add "removed" on every refresh.
    const newest = this.unread().filter((x) => x.sharedTabId === n.sharedTabId).at(-1)
    if (n.kind === 'removed' && newest?.kind === 'removed') return newest
    const kept: Kept = { id: randomUUID(), ...n, at: new Date(this.now()).toISOString() }
    this.list = [...this.list, kept].slice(-NOTICES_KEPT)
    this.save()
    return this.strip(kept)
  }

  unread(): SharedNotice[] { return this.list.filter((n) => !n.read).map((n) => this.strip(n)) }

  dismiss(id: string): boolean {
    const n = this.list.find((x) => x.id === id && !x.read)
    if (!n) return false
    n.read = true
    this.save()
    return true
  }

  private strip({ read: _read, ...n }: Kept): SharedNotice { return n }
}
```

`sharedTabs.ts`: `SharedNotice` gains `id: string`; remove `NOTICES_MAX` and the `noticed` array; the store is
`this.deps.notices ?? new NoticeStore(null, this.now)` (kept in a field). `notices()` returns `store.unread()` without
clearing; `notice()` calls `store.add(n)` then `announce`; `dismissNotice(id)` returns `store.dismiss(id)` and
announces when true. The two dedupe sites (~669 `full`, ~1060 `unsent`) read `store.unread()` instead of `noticed`.

`rosterStore.ts`: the alert schema gains `id: z.string().optional()` and `dismissed: z.literal(true).optional()`; on
load, an alert without an id gets `randomUUID()` (and the file is saved once with `save(false)` only if any was
missing). `RosterAlert` = `{ id: string; sharedTabId; at; error; count?; dismissed?: true }`. `alert()` looks for `last`
among undismissed alerts only and gives a new one an id. `alerts()` returns undismissed ones (without `dismissed`).
`dismiss(id)` sets `dismissed: true`, `save(false)`, returns whether it found an undismissed one.

`service.ts`: `SHARE_ACTIONS` gains `'share_notice_dismiss'`; `sharedUp` passes
`notices: new NoticeStore(join(stateDir, 'shared-tabs-notices.json'), now)` (inside the same `try` as the other stores);
in `shareAction`:

```ts
case 'share_notice_dismiss': {
  const id = String(payload.id ?? '')
  if (shared.dismissNotice(id) || rosters.dismiss(id)) return { ok: true }
  throw new MessageError('NOT_FOUND', 'That notice is already gone.')
}
```

Do **not** add the notices file to `EXPERIMENTS.sharing.state` (api.ts ~755): Share derives nothing from it.
Add `'src/messages/noticeStore.ts'` to `FILES` in `cli/vitest.shared-tabs.config.ts`.

- [ ] **Step 4: Run to pass, then the gates**

Run: `cd cli && npx vitest run src/messages && npm run test:shared-tabs && npm run test:core && npm run typecheck`
Expected: PASS at 100%.

- [ ] **Step 5: Checkpoint.**

### Task A3: `DAEMON_TOO_OLD`

**Files:**
- Modify: `cli/src/services/messagesProcess.ts` (~124, `identity`), the doc comment above it, and `CORE_TOO_OLD_TEXT`
  (its raw backticks become plain words)
- Test: `cli/src/services/messagesProcess.spec.ts` (~256, ~277), `cli/e2e/messagesSkew.e2e.ts` (~188, header comment 14–15)

**Interfaces:**
- Produces: a core from before the `account` query answers every share action `DAEMON_TOO_OLD` with
  `CORE_TOO_OLD_TEXT`. A null identity stays `ACCOUNT_UNAVAILABLE` (`service.sharedTabs.spec.ts:445` unchanged).

- [ ] **Step 1: Change the expectations first**

`messagesProcess.spec.ts` ~256 and ~277: the old-core case expects
`rejects.toMatchObject({ code: 'DAEMON_TOO_OLD', message: CORE_TOO_OLD_TEXT })`; add
`expect(CORE_TOO_OLD_TEXT).not.toMatch(/`/)`. Fix the vacuous assertion at ~260 (1b follow-up) so it fails when the
identity is not asked. `messagesSkew.e2e.ts` ~188 expects `error: 'DAEMON_TOO_OLD'`.

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/services/messagesProcess.spec.ts`
Expected: FAIL (`ACCOUNT_UNAVAILABLE`).

- [ ] **Step 3: Implement**

```ts
if (answer?.error === 'UNKNOWN_QUERY') throw new MessageError('DAEMON_TOO_OLD', CORE_TOO_OLD_TEXT)
```

and rewrite `CORE_TOO_OLD_TEXT` without backticks, e.g. "This computer runs an older Harness core than its Agent
Messages. Restart Harness (harness restart) to share tabs." (keep the meaning of the existing text).

- [ ] **Step 4: Run to pass; gates**

Run: `cd cli && npx vitest run src/services/messagesProcess.spec.ts && npm run test:core && npm run typecheck`, then
`npx vitest run --config vitest.e2e.config.ts e2e/messagesSkew.e2e.ts` (the e2e config the 1b D3 task used; it builds
the old release as before).
Expected: PASS; skew 2/2.

- [ ] **Step 5: Checkpoint.**

### Task A4: a shared tab's working state across accounts (seam 1, R4)

**Files:**
- Create: `cli/src/messages/tabActivity.ts`, `cli/src/messages/tabActivity.spec.ts`
- Modify: `cli/src/core/api.ts` (`CoreApi.agents` ~142: `activity`; its fallback; `MESSAGES_QUERIES` ~708),
  `cli/src/core/messagesLink.ts` (`activity` query), `cli/src/core/main.ts` (wire it),
  `cli/src/services/processCoreApi.ts` (ask the core), `cli/src/messages/service.ts` (tick, tab answer, `shares`),
  `cli/vitest.shared-tabs.config.ts`, `cli/src/core/AGENTS.md` (the `MESSAGES_QUERIES` sentence)
- Test: `messagesLink.spec.ts` (~126 query list), `processCoreApi.spec.ts`, `service.sharedTabs.spec.ts`

**Interfaces:**
- Produces: `CoreApi.agents.activity(agentIds: string[]): Promise<Record<string, 'working' | 'idle' | 'unknown'>>`;
  fallback `async () => ({})`. Query `activity { agentIds }` → `{ activity: Record<agentId, state> }`, at most 64 ids.
- Produces (tabActivity.ts): `ACTIVITY_RENEW_MS = 20_000`, `ACTIVITY_LEASE_MS = 30_000`, `ACTIVITY_REFUSED_MS = 10 * 60_000`,
  `class ActivityOut { due(sharedTabId: string, now: number, current: Record<string, ActivityState>): Array<{ agentId: string; state: ActivityState }>; refused(sharedTabId: string, machineId: string, now: number): void; refusing(sharedTabId: string, machineId: string, now: number): boolean; forget(sharedTabId: string): void }`,
  `class ActivityIn { take(sharedTabId: string, machineId: string, agents: unknown, listed: (agentId: string) => boolean, now: number): SharedActivity[]; snapshot(now: number): SharedActivity[]; forget(sharedTabId: string): void }`,
  `type SharedActivity = { sharedTabId: string; machineId: string; agentId: string; state: ActivityState; validForMs: number }`.
- Produces: tab request `activity { sharedTabId, agents: [{ agentId, state }] }` → `{ ok: true }`; window frame
  `shared_activity` with a `SharedActivity` payload; `shares` gains `activity: SharedActivity[]`.

- [ ] **Step 1: Write the failing tests**

`tabActivity.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ACTIVITY_LEASE_MS, ACTIVITY_RENEW_MS, ActivityIn, ActivityOut } from './tabActivity.js'

const TAB = 'a'.repeat(24)
describe('ActivityOut', () => {
  it('sends a change once, renews working every ACTIVITY_RENEW_MS, and sends idle once', () => {
    const out = new ActivityOut()
    expect(out.due(TAB, 0, { a1: 'idle' })).toEqual([{ agentId: 'a1', state: 'idle' }])
    expect(out.due(TAB, 5_000, { a1: 'idle' })).toEqual([])
    expect(out.due(TAB, 10_000, { a1: 'working' })).toEqual([{ agentId: 'a1', state: 'working' }])
    expect(out.due(TAB, 10_000 + ACTIVITY_RENEW_MS - 1, { a1: 'working' })).toEqual([])
    expect(out.due(TAB, 10_000 + ACTIVITY_RENEW_MS, { a1: 'working' })).toEqual([{ agentId: 'a1', state: 'working' }])
    expect(out.due(TAB, 40_000, { a1: 'idle' })).toEqual([{ agentId: 'a1', state: 'idle' }])
  })
  it('stops asking a machine that refused for ACTIVITY_REFUSED_MS', () => { /* refused(TAB,'m',0); refusing true at
     ACTIVITY_REFUSED_MS - 1, false at ACTIVITY_REFUSED_MS */ })
  it('starts again for a tab it forgot', () => { /* due → forget → the same state is due again */ })
})

describe('ActivityIn', () => {
  it('takes only listed agents of the sending machine, with a lease for working', () => {
    const into = new ActivityIn()
    const taken = into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }, { agentId: 'zz', state: 'working' }, { agentId: 'a2', state: 'bogus' }], (id) => id !== 'zz', 0)
    expect(taken).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'working', validForMs: ACTIVITY_LEASE_MS }])
    expect(into.snapshot(ACTIVITY_LEASE_MS - 1)).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'working', validForMs: 1 }])
    expect(into.snapshot(ACTIVITY_LEASE_MS)).toEqual([])
  })
  it('takes at most one frame per machine and tab a second, and at most 64 agents', () => { /* a second take within
     999 ms returns [] and changes nothing; a frame of 65 agents keeps the first 64 */ })
  it('ignores what is not a list of objects', () => { /* 'x', null, [1, 'a'] → [] */ })
})
```

`service.sharedTabs.spec.ts` (Alice's and Bob's worlds of the file, Bob's harness listed in Alice's tab):

```ts
it('tells the other accounts' machines when a listed harness works, and their windows hear it', async () => {
  vi.useFakeTimers()
  const w = await twoAccounts()                          // the file's helper with a shared tab and Bob's harness added
  w.bob.core.activity = { [BOB_AGENT]: 'working' }       // the fake core's agents.activity answer
  await vi.advanceTimersByTimeAsync(TICK_MS)
  expect(windowFrames(w.alice).filter((f) => f.type === 'shared_activity')).toEqual([{ type: 'shared_activity',
    payload: { sharedTabId: SHARE_A, machineId: w.bob.machineId, agentId: BOB_AGENT, state: 'working', validForMs: ACTIVITY_LEASE_MS } }])
  expect(await w.alice.ask({ action: 'shares' })).toMatchObject({ activity: [{ agentId: BOB_AGENT, state: 'working' }] })
  await vi.advanceTimersByTimeAsync(TICK_MS)             // unchanged and not yet due for renewal: nothing sent
  expect(windowFrames(w.alice).filter((f) => f.type === 'shared_activity')).toHaveLength(1)
})
it('sends nothing for a harness the roster does not list, nor to its own account's machines', async () => { /* … */ })
it('answers activity from a machine for an agent it does not list with ok and tells no window', async () => { /* … */ })
it('stops asking a peer that answers UNKNOWN_ACTION (a 1b daemon) for ACTIVITY_REFUSED_MS', async () => { /* … */ })
it('reads no activity while it holds no tab, and none asleep', async () => { /* agents.activity never called */ })
```

The four short cases are written out by the implementer in the file's style; each asserts on frames sent and on the
fake core's `agents.activity` calls.

`messagesLink.spec.ts`: the `MESSAGES_QUERIES` list (~126) includes `'activity'`, and:

```ts
it('answers the working state of at most 64 agents', async () => {
  const activity = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'idle'])))
  const { link: l } = link({ agents: { activity } })
  const ids = Array.from({ length: 70 }, (_, i) => `a${i}`)
  const answer = await l.answer('activity', { agentIds: [...ids, 5] })
  expect(Object.keys((answer as { activity: object }).activity)).toHaveLength(64)
  expect(await l.answer('activity', { agentIds: 'x' })).toEqual({ activity: {} })
})
```

- [ ] **Step 2: Run to fail**

Run: `cd cli && npx vitest run src/messages/tabActivity.spec.ts src/core/messagesLink.spec.ts src/messages/service.sharedTabs.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`tabActivity.ts`:

```ts
/**
 * A shared tab's working state across accounts (1c spec, seam 1): another account's harness in a tab shows its spinner
 * in the tab row, which the observer channel never fed (step 0). Each daemon sends its own listed harnesses' state to
 * the tab's machines of other accounts on a change, and renews working before the receiver's lease runs out.
 */
export type ActivityState = 'working' | 'idle' | 'unknown'
export type SharedActivity = { sharedTabId: string; machineId: string; agentId: string; state: ActivityState; validForMs: number }
export const ACTIVITY_RENEW_MS = 20_000
/** As long as the core's own working lease (lib/turnActivity.ts WORK_EVIDENCE_MS): a sender that went away is not
 *  shown working for longer than its own windows would show it. */
export const ACTIVITY_LEASE_MS = 30_000
/** A machine that answered `activity` with an unknown action (a 1b daemon) is not asked again for this long. */
export const ACTIVITY_REFUSED_MS = 10 * 60_000
const FRAME_MS = 1_000, AGENTS_MAX = 64
const STATES = new Set<ActivityState>(['working', 'idle', 'unknown'])

export class ActivityOut {
  private sent = new Map<string, Map<string, { state: ActivityState; at: number }>>()
  private refusedAt = new Map<string, number>()
  due(sharedTabId: string, now: number, current: Record<string, ActivityState>): Array<{ agentId: string; state: ActivityState }> {
    const last = this.sent.get(sharedTabId) ?? new Map()
    this.sent.set(sharedTabId, last)
    const out: Array<{ agentId: string; state: ActivityState }> = []
    for (const [agentId, state] of Object.entries(current)) {
      const was = last.get(agentId)
      if (was && was.state === state && (state !== 'working' || now - was.at < ACTIVITY_RENEW_MS)) continue
      last.set(agentId, { state, at: now })
      out.push({ agentId, state })
    }
    return out.slice(0, AGENTS_MAX)
  }
  refused(sharedTabId: string, machineId: string, now: number): void { this.refusedAt.set(`${sharedTabId} ${machineId}`, now) }
  refusing(sharedTabId: string, machineId: string, now: number): boolean {
    const at = this.refusedAt.get(`${sharedTabId} ${machineId}`)
    return at !== undefined && now - at < ACTIVITY_REFUSED_MS
  }
  forget(sharedTabId: string): void { this.sent.delete(sharedTabId) }
}

export class ActivityIn {
  private heard = new Map<string, { activity: SharedActivity; at: number }>()
  private lastFrame = new Map<string, number>()
  take(sharedTabId: string, machineId: string, agents: unknown, listed: (agentId: string) => boolean, now: number): SharedActivity[] {
    const k = `${sharedTabId} ${machineId}`
    const last = this.lastFrame.get(k)
    if (last !== undefined && now - last < FRAME_MS) return []
    this.lastFrame.set(k, now)
    if (!Array.isArray(agents)) return []
    const taken: SharedActivity[] = []
    for (const a of agents.slice(0, AGENTS_MAX)) {
      if (!a || typeof a !== 'object') continue
      const { agentId, state } = a as Record<string, unknown>
      if (typeof agentId !== 'string' || !STATES.has(state as ActivityState) || !listed(agentId)) continue
      const activity: SharedActivity = { sharedTabId, machineId, agentId, state: state as ActivityState, validForMs: state === 'working' ? ACTIVITY_LEASE_MS : 0 }
      this.heard.set(`${k} ${agentId}`, { activity, at: now })
      taken.push(activity)
    }
    return taken
  }
  /** What the windows should show now: working harnesses whose lease has not run out, with what is left of it. */
  snapshot(now: number): SharedActivity[] {
    return [...this.heard.values()].flatMap(({ activity, at }) => {
      const left = activity.state === 'working' ? ACTIVITY_LEASE_MS - (now - at) : 0
      return activity.state === 'working' && left > 0 ? [{ ...activity, validForMs: left }] : []
    })
  }
  forget(sharedTabId: string): void {
    for (const k of [...this.heard.keys()]) if (k.startsWith(`${sharedTabId} `)) this.heard.delete(k)
  }
}
```

Core side:
- `api.ts`: `agents.activity(agentIds: string[]): Promise<Record<string, 'working' | 'idle' | 'unknown'>>` with the
  doc "Whether each of these agents is working now, as this computer's windows are told (core/turns/activity.ts):
  Agent Messages tells a shared tab's other accounts." Its fallback beside the other `agents` fallbacks:
  `activity: async () => ({})`. `MESSAGES_QUERIES` gains `'activity'`.
- `messagesLink.ts`:

```ts
// Whether this computer's harnesses in a shared tab are working, for that tab's other accounts (messages/tabActivity.ts).
case 'activity': {
  const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
  return core.agents.activity(ids).then((activity) => ({ activity }))
}
```

- `main.ts`: implement `agents.activity` from the same frame the windows get per agent (`activityFrameContextRef`, set
  from `createTurnActivity(...).activityFrame` ~1099–1110): for each id, the registered session by agent id, then
  `activityFrame(session)?.state ?? 'unknown'`; an unknown agent is left out.
- `processCoreApi.ts`: `agents.activity: (agentIds) => ask('activity', { agentIds }).then((a) => record(a?.activity) ?? {}).catch(() => ({}))`
  (use the file's existing helpers for a record answer).

Service side (`service.ts`):

```ts
const activityOut = new ActivityOut(), activityIn = new ActivityIn()

/** This computer's harnesses in each held tab, as working or not, to the tab's machines of other accounts; a peer
 *  that does not know `activity` (a 1b daemon) is left alone for a while (tabActivity.ts). */
async function shareActivity(): Promise<void> {
  if (!shared || !rosters) return
  const held = rosters.all()
  if (!held.length) return
  const me = await signedInAs().catch(() => null)
  if (!me) return
  for (const roster of held) {
    const mine = roster.harnesses.filter((h) => h.machineId === self())
    if (!mine.length) continue
    const peers = [...new Set([...roster.harnesses.filter((h) => h.accountId !== me.accountId).map((h) => h.machineId),
      ...(roster.owner.accountId !== me.accountId ? [roster.owner.machineId] : [])])]
    if (!peers.length) continue
    const states = await core.agents.activity(mine.map((h) => h.agentId))
    const agents = activityOut.due(roster.sharedTabId, now(), states)
    if (!agents.length) continue
    await Promise.all(peers.filter((m) => !activityOut.refusing(roster.sharedTabId, m, now())).map(async (machineId) => {
      try { await askTab(roster.sharedTabId, machineId, { action: 'activity', sharedTabId: roster.sharedTabId, agents }, 5_000) }
      catch (error) { if (error instanceof MessageError && error.code === 'UNKNOWN_ACTION') activityOut.refused(roster.sharedTabId, machineId, now()) }
    }))
  }
}
```

Call `void shareActivity().catch(() => {})` from the tick (`startTick`, beside `notesPump()`). In `answerTab` (the
shared tab's request switch near ~962), before any rate-limited case and not counted by the message limits:

```ts
case 'activity': {
  const roster = rosters?.current(ctx.sharedTabId)?.roster
  const listed = (agentId: string) => !!roster?.harnesses.some((h) => h.machineId === ctx.machineId && h.agentId === agentId)
  for (const a of activityIn.take(ctx.sharedTabId, ctx.machineId, payload.agents, listed, now())) {
    core.clients.windows({ type: SHARED_ACTIVITY_WINDOW_FRAME, payload: { ...a } })
  }
  return { ok: true }
}
```

Read the existing `askTab` signature and the `answerTab` context names (`ctx.sharedTabId`, `ctx.machineId`) from the
file and use them; if a peer's unknown-action answer arrives as a different error shape, match that shape. The `shares`
answer gains `activity: activityIn.snapshot(now())`. When a tab is forgotten (left, removed, 4403) call
`activityOut.forget(id)` and `activityIn.forget(id)` where the service already drops a tab's other state.

Add `'src/messages/tabActivity.ts'` to `FILES` in `vitest.shared-tabs.config.ts`. In `cli/src/core/AGENTS.md`, the
`MESSAGES_QUERIES` sentence gains "whether its harnesses work (`activity`)".

- [ ] **Step 4: Run to pass; gates**

Run: `cd cli && npx vitest run src/messages src/core/messagesLink.spec.ts src/services/processCoreApi.spec.ts && npm run test:shared-tabs && npm run test:core && npm run typecheck && npx vitest run src/architecture.spec.ts`
Expected: PASS at 100%.

- [ ] **Step 5: Checkpoint.**

### Task A5: repo and branch for People (`share_who`), and the invitation's tab name

**Files:**
- Modify: `backend/src/lib/agentMessageShares.ts` (`pendingInvites` ~118, `InviteView` ~23), `cli/src/messages/sharedTabs.ts`
  (`invites()` ~719), `cli/src/messages/service.ts` (`SHARE_ACTIONS`, `shareAction`)
- Test: `backend/src/lib/agentMessageShares.test.ts`, `cli/src/messages/sharedTabs.spec.ts`, `service.sharedTabs.spec.ts`

**Interfaces:**
- Produces: `InviteView.tabName: string` (backend; '' when the stored roster cannot be read); the daemon's `invites()`
  entries gain `tabName: string` ('' from an older backend).
- Produces: action `share_who { sharedTabId }` → `{ harnesses: Array<{ machineId: string; agentId: string; project?: string; branch?: string }> }`,
  `WHO_WAIT_MS = 4_000` (service.ts, exported).

- [ ] **Step 1: Write the failing tests**

Backend (`agentMessageShares.test.ts`, the file's real-Mongo setup):

```ts
it('names the tab of a pending invitation from the roster it holds, cleaned', async () => {
  const share = await shareWithRoster({ name: 'app‮\u0007' })        // the file's helpers
  await invite({ ownerUserId: share.ownerUserId, ownerEmail: OWNER_EMAIL, sharedTabId: share.id, email: BOB_EMAIL, days: 7 })
  expect(await pendingInvites(BOB_EMAIL, ENV)).toEqual([expect.objectContaining({ sharedTabId: share.id, tabName: 'app' })])
})
it('gives an empty name when the roster is missing or not JSON', async () => { /* roster null; roster { body: '{' } */ })
```

Daemon (`sharedTabs.spec.ts`): `invites()` passes `tabName` through, and gives `''` when the backend sends none or a
non-string. `service.sharedTabs.spec.ts`:

```ts
it('asks each machine of the tab who its harnesses are, and leaves out one that does not answer in time', async () => {
  vi.useFakeTimers()
  const w = await twoAccounts()                // Alice's harness on her machine, Bob's on his
  w.bob.cwd(BOB_AGENT, '/work/api')            // the fake core's session cwd → project 'api'
  w.alice.silent = true                         // Alice's machine never answers `who`
  const asked = w.bob.ask({ action: 'share_who', sharedTabId: SHARE_A })
  await vi.advanceTimersByTimeAsync(WHO_WAIT_MS)
  expect(await asked).toEqual({ harnesses: [{ machineId: w.bob.machineId, agentId: BOB_AGENT, project: 'api' }] })
})
it('answers NOT_SHARED for a tab it does not hold', async () => { /* … */ })
```

- [ ] **Step 2: Run to fail**

Run: `cd backend && npx vitest run src/lib/agentMessageShares.test.ts`; `cd cli && npx vitest run src/messages/sharedTabs.spec.ts src/messages/service.sharedTabs.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Backend: in `pendingInvites`, read each invitation's share (`AgentMessageShare.roster`, a `{ body, signature }` JSON),
`JSON.parse(body).name` when it is a string, with control and format characters removed
(`.replace(/[\p{Cc}\p{Cf}]/gu, '')`) and cut to 200; otherwise `''`. One `findMany` for all shares of the listed
invitations, not one query each.

Daemon `invites()`: add `tabName: typeof r.tabName === 'string' ? cleanName(r.tabName).slice(0, 200) : ''` to each
entry (`cleanName` from `roster.ts`).

`service.ts`:

```ts
/** How long People waits for a machine of the tab to say its harnesses' repo and branch. */
export const WHO_WAIT_MS = 4_000

/** Each harness of a held tab with its repo and branch, asked of its machine as a tab's note does (`who`); a machine
 *  that does not answer within WHO_WAIT_MS is left out, not waited for. */
async function sharedWho(sharedTabId: string): Promise<Record<string, unknown>> {
  const roster = rosters?.current(sharedTabId)?.roster
  if (!roster) throw new MessageError('NOT_SHARED', 'This computer holds no shared tab with that id.')
  const me = await signedInAs()
  const byMachine = new Map<string, string[]>()
  for (const h of roster.harnesses) byMachine.set(h.machineId, [...(byMachine.get(h.machineId) ?? []), h.agentId])
  const answers = await Promise.all([...byMachine].map(async ([machineId, agentIds]) => {
    const payload = { action: 'who', agentIds }
    const asking = machineId === self() ? whoAre(payload)
      : roster.harnesses.some((h) => h.machineId === machineId && h.accountId === me.accountId) ? rpc(at(machineId), payload, WHO_WAIT_MS)
      : askTab(sharedTabId, machineId, payload, WHO_WAIT_MS)
    const answer = await Promise.race([asking.catch(() => null), new Promise<null>((done) => { const t = setTimeout(() => done(null), WHO_WAIT_MS); t.unref?.() })])
    const agents = Array.isArray(answer?.agents) ? answer.agents as Record<string, unknown>[] : []
    return agents.filter((a) => typeof a.agentId === 'string' && agentIds.includes(a.agentId)).map((a) => ({ machineId, agentId: a.agentId as string,
      ...(typeof a.project === 'string' ? { project: cleanText(a.project, 120) } : {}), ...(typeof a.branch === 'string' ? { branch: cleanText(a.branch, 200) } : {}) }))
  }))
  return { harnesses: answers.flat() }
}
```

`SHARE_ACTIONS` gains `'share_who'`; `case 'share_who': return sharedWho(String(payload.sharedTabId))`. Use the file's
real names for `whoAre`, `rpc`, `at`, `askTab` and `cleanText`.

- [ ] **Step 4: Run to pass; gates**

Run: `cd backend && npx vitest run src/lib/agentMessageShares.test.ts src/routes/agentMessages.test.ts && npx tsc --noEmit`;
`cd cli && npm run test:shared-tabs && npm run test:core && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task A6: end to end

**Files:**
- Modify: `cli/e2e/sharedTabs.e2e.ts`

- [ ] **Step 1: Add the steps**

In the existing two-account scenario (real backend, Alice and Bob daemons), with a `LocalClient` connected to each
daemon as a window (the harness's `client.ts`; frames from `core.clients.windows` reach every local client):

1. Before Alice invites Bob, note `bobWindow.frames.length`; after `share_invite`, `await bobWindow.waitFor((f) =>
   f.type === 'shared_tabs_changed', 15_000, 'shared_tabs_changed after an invitation', since)`; then Bob's `shares`
   lists the invitation with `tabName` equal to Alice's tab name.
2. After the existing step where a message is delivered into Alice's harness (which starts a turn in the fake engine),
   `await bobWindow.waitFor((f) => f.type === 'shared_activity' && f.payload.agentId === ALICE_AGENT && f.payload.state
   === 'working', 20_000, 'Alice's harness working, seen by Bob')`.
3. Bob's `share_who` answers Alice's harness with its `project` (the fake engine's cwd basename).
4. A notice survives Bob's messages process restart: after the existing "removed" step, `share_notice_dismiss` is not
   called; kill the edge host as the existing step at ~226 does, wait for messages to connect again, and `shares` still
   lists the `removed` notice; then dismiss it and `shares` lists none.

- [ ] **Step 2: Run**

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/sharedTabs.e2e.ts` (three times; the 1b runs did
13/13 ×3).
Expected: PASS every time. Record the timings in the task report.

- [ ] **Step 3: Checkpoint.**

---

## Phase B: desktop state

### Task B1: `SharedTabsController` and its model

**Files:**
- Create: `desktop/lib/agent_messages/shared_tabs_model.dart`, `desktop/lib/agent_messages/shared_tabs.dart`
- Test: `desktop/test/shared_tabs_controller_test.dart`

**Interfaces:**
- Consumes: the `shares` answer of Task A1/A2/A4; `share_*` actions (1b); `WsRequestFailure.code`
  (`lib/ws/ws_conn.dart` ~561).
- Produces (model): `SharedTabHarness { accountId, machineId, agentId, name, engine; String get key }`,
  `SharedTabMember { accountId, email, name }`, `SharedTab { sharedTabId, String? ownerTabId, name, version, ownerAccountId,
  ownerEmail, ownerMachineId, ({String machineId, String agentId})? leader, List<SharedTabMember> members,
  List<SharedTabHarness> harnesses, List<({String email, String expiresAt})> invites; bool ownedBy(String accountId);
  String? deskTabId(String myAccountId) }` (`ownerTabId` is the daemon's `tabId`), `SharedTabInvite { id, sharedTabId, ownerEmail, ownerMachineId, tabName, expiresAt }`,
  `SharedTabAlert { id, sharedTabId, code, at, count }`, `SharedTabNotice { id, sharedTabId, kind, error, machineId, agentId, at }`,
  `SharedTabPending { sharedTabId, op, machineId, agentId, name, since }`, `SharedActivity { sharedTabId, machineId, agentId, state, validForMs, int revision; SharedActivity withRevision(int) }`,
  `SharedTabsSnapshot { me, tabs, invites, alerts, notices, pending, untrusted, activity, bool canDismiss; static SharedTabsSnapshot? fromJson(Object?); static const empty; SharedTabsSnapshot without(Set<String> ids) }` (`without` drops alerts and notices with those ids).
- Produces (controller): `enum SharedTabsState { unknown, ready, off, tooOld, unsupported, unavailable }`,
  `class SharedTabsController extends ChangeNotifier` with `SharedTabsSnapshot get snapshot`, `SharedTabsState get state`,
  `Future<void> refresh()`, `void changed()`, `void handleActivity(Map<String, dynamic>)`, `void reset()`,
  `SharedTab? tabForDesk(String deskTabId)`, `bool isShared(String deskTabId)`,
  `Future<Map<String, dynamic>> act(String action, Map<String, dynamic> payload)` (throws `SharedTabsFailure(code, message)`),
  `Future<void> dismiss(String id)`, `SharedTasks tasksFor(String sharedTabId)`, `Future<void> loadTasks(String sharedTabId)`,
  `Future<Map<String, ({String? project, String? branch})>> who(String sharedTabId)`.
- Produces: `class SharedTabsWatch` (one-shot 60 s timer, re-armed only while `foreground.value`), like
  `AgentMessagesRemoteWatch` (`agent_messages.dart` ~558–607).

- [ ] **Step 1: Write the failing tests**

```dart
import 'dart:async';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart';
import 'package:harness/ws/ws_conn.dart';

Map<String, dynamic> shares({int api = 2, List<Map<String, dynamic>> rosters = const [], List<Map<String, dynamic>> notices = const []}) => {
  if (api >= 2) 'api': api,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'mb'},
  'rosters': rosters, 'invites': [], 'alerts': [], 'pending': [], 'notices': notices, 'untrusted': [], 'activity': [],
};
Map<String, dynamic> roster({String id = 'aaaaaaaaaaaaaaaaaaaaaaaa', String? tabId, String owner = 'alice'}) => {
  'sharedTabId': id, 'tabId': tabId, 'version': 3, 'name': 'app',
  'owner': {'accountId': owner, 'email': '$owner@example.com', 'machineId': 'ma', 'machinePublicKey': 'k'},
  'leader': null, 'members': [], 'invites': [],
  'harnesses': [{'accountId': 'alice', 'machineId': 'ma', 'machinePublicKey': 'k', 'agentId': 'a1', 'name': 'api', 'engine': 'claude'}],
};

void main() {
  test('reads shares, and a member\'s desk tab is its shared tab id', () async {
    final c = SharedTabsController(request: (p) async => shares(rosters: [roster()]), foreground: ValueNotifier(true));
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.isShared('aaaaaaaaaaaaaaaaaaaaaaaa'), isTrue);
    expect(c.tabForDesk('aaaaaaaaaaaaaaaaaaaaaaaa')!.harnesses.single.name, 'api');
  });
  test('an owned tab is found under the desk tab it was shared from', () async {
    final c = SharedTabsController(request: (p) async => shares(rosters: [roster(owner: 'bob', tabId: 'swarm-3')]), foreground: ValueNotifier(true));
    await c.refresh();
    expect(c.isShared('swarm-3'), isTrue);
    expect(c.isShared('aaaaaaaaaaaaaaaaaaaaaaaa'), isFalse);
  });
  for (final (code, state) in [
    ('UNKNOWN_ACTION', SharedTabsState.tooOld), ('DAEMON_TOO_OLD', SharedTabsState.tooOld), ('UNSUPPORTED', SharedTabsState.tooOld),
    ('MESSAGES_OFF', SharedTabsState.off), ('SHARED_TABS_UNSUPPORTED', SharedTabsState.unsupported),
  ]) {
    test('$code → $state', () async {
      final c = SharedTabsController(request: (p) async => throw WsRequestFailure(code, 'x'), foreground: ValueNotifier(true));
      await c.refresh();
      expect(c.state, state);
    });
  }
  test('a failed read keeps what was known', () async {
    var fail = false;
    final c = SharedTabsController(request: (p) async => fail ? throw WsRequestFailure('ACCOUNT_UNAVAILABLE', 'x') : shares(rosters: [roster()]), foreground: ValueNotifier(true));
    await c.refresh();
    fail = true;
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.snapshot.tabs, hasLength(1));
  });
  test('an answer to a read the account has moved past is dropped (Review Focus 4)', () async {
    final first = Completer<Map<String, dynamic>>();
    var calls = 0;
    final c = SharedTabsController(request: (p) => ++calls == 1 ? first.future : Future.value(shares()), foreground: ValueNotifier(true));
    final late = c.refresh();
    c.reset();                                        // sign-out
    first.complete(shares(rosters: [roster()]));
    await late;
    expect(c.snapshot.tabs, isEmpty);
    expect(c.state, SharedTabsState.unknown);
  });
  test('reads again on shared_tabs_changed, and every 60 s only while in front', () {
    fakeAsync((async) {
      var reads = 0;
      final front = ValueNotifier(true);
      final c = SharedTabsController(request: (p) async { reads++; return shares(); }, foreground: front);
      final watch = SharedTabsWatch(controller: c, foreground: front)..start();
      async.flushMicrotasks();
      expect(reads, 1);
      c.changed();
      async.flushMicrotasks();
      expect(reads, 2);
      async.elapse(const Duration(seconds: 60));
      expect(reads, 3);
      front.value = false;
      async.elapse(const Duration(minutes: 5));
      expect(reads, 3);
      watch.dispose();
    });
  });
  test('dismiss asks the daemon, and only hides locally without api 2', () async {
    final asked = <Map<String, dynamic>>[];
    var api = 2;
    final notice = {'id': 'n1', 'sharedTabId': 'aaaaaaaaaaaaaaaaaaaaaaaa', 'kind': 'removed', 'at': '2026-10-16T10:00:00Z'};
    final c = SharedTabsController(request: (p) async { asked.add(p); return p['action'] == 'shares' ? shares(api: api, notices: [notice]) : {'ok': true}; }, foreground: ValueNotifier(true));
    await c.refresh();
    await c.dismiss('n1');
    expect(asked.map((p) => p['action']), contains('share_notice_dismiss'));
    api = 1; asked.clear();
    await c.refresh();
    await c.dismiss('n1');
    expect(asked.map((p) => p['action']), isNot(contains('share_notice_dismiss')));
    expect(c.snapshot.notices, isEmpty);
  });
  test('a hostile name stays plain text and is never trusted as an id', () async { /* a roster harness named
     '‮evil<b>x</b>' + 200 chars parses; name is kept as given (the view ellipsizes); a roster missing sharedTabId
     or with a non-list harnesses is dropped, not thrown */ });
  test('Tasks: one read at a time per tab, its error kept with the tab, a late answer after reset dropped', () async { /* … */ });
  test('activity frames are parsed and handed on with a growing revision', () async { /* handleActivity twice →
     onActivity sees revisions 1 and 2; a payload missing machineId is ignored */ });
}
```

The last three tests are written out by the implementer against the code below; each asserts on observable state.

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tabs_controller_test.dart`
Expected: FAIL (no library).

- [ ] **Step 3: Implement**

`shared_tabs_model.dart`: plain immutable classes with `static X? fromJson(Object? value)` that return null for a
malformed entry (never throw), as `AgentMessageParty.fromJson` does. `SharedTab.deskTabId(me)` returns
`ownedBy(me) ? ownerTabId : sharedTabId` (null-safe: an owned tab without `ownerTabId` is not shown in any desk tab).
`SharedTabsSnapshot.fromJson` reads `api` (`canDismiss = api >= 2`), `me`, and each list with `whereType` + `fromJson`.

`shared_tabs.dart`:

```dart
typedef SharedTabsRequest = Future<Map<String, dynamic>> Function(Map<String, dynamic> payload);

class SharedTabsFailure implements Exception {
  const SharedTabsFailure(this.code, this.message);
  final String code, message;
}

enum SharedTabsState { unknown, ready, off, tooOld, unsupported, unavailable }

/// Shared tabs as this computer's daemon holds them (`agent_messages` `shares`), and the actions on them. Its own
/// notifier, as [AgentMessagesController] is, so its traffic never rebuilds the workspace.
class SharedTabsController extends ChangeNotifier {
  SharedTabsController({required this.request, required this.foreground, this.onActivity});

  final SharedTabsRequest request;
  final ValueListenable<bool> foreground;
  final void Function(SharedActivity activity)? onActivity;

  SharedTabsSnapshot _snapshot = SharedTabsSnapshot.empty;
  SharedTabsState _state = SharedTabsState.unknown;
  final _hidden = <String>{};                      // dismissed here, for a daemon without api 2
  final _tasks = <String, SharedTasks>{};
  int _reads = 0, _account = 0, _activityRevision = 0;
  bool _disposed = false;

  SharedTabsSnapshot get snapshot => _snapshot.without(_hidden);
  SharedTabsState get state => _state;

  void _notify() { if (!_disposed) notifyListeners(); }

  static SharedTabsState? _stateFor(String code) => switch (code) {
    'UNKNOWN_ACTION' || 'DAEMON_TOO_OLD' || 'UNSUPPORTED' => SharedTabsState.tooOld,
    'MESSAGES_OFF' => SharedTabsState.off,
    'SHARED_TABS_UNSUPPORTED' => SharedTabsState.unsupported,
    _ => null,
  };

  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_reads, account = _account;
    Map<String, dynamic> answer;
    try {
      answer = await request({'action': 'shares'});
    } on WsRequestFailure catch (e) {
      if (_disposed || account != _account || read != _reads) return;
      final next = _stateFor(e.code);
      if (next == null) return;                    // transient: keep what was known
      _state = next;
      _snapshot = SharedTabsSnapshot.empty;
      _notify();
      return;
    } catch (_) {
      return;
    }
    if (_disposed || account != _account || read != _reads) return;
    final next = SharedTabsSnapshot.fromJson(answer);
    if (next == null) return;
    _snapshot = next;
    _state = SharedTabsState.ready;
    for (final a in next.activity) _hand(a);
    _notify();
  }

  void changed() => unawaited(refresh());

  void handleActivity(Map<String, dynamic> payload) {
    final a = SharedActivity.fromJson(payload);
    if (a != null && !_disposed) _hand(a);
  }

  void _hand(SharedActivity a) => onActivity?.call(a.withRevision(++_activityRevision));

  /// Sign-out or another account: nothing of the old one stays, and its late answers are dropped.
  void reset() {
    _account++;
    _snapshot = SharedTabsSnapshot.empty;
    _state = SharedTabsState.unknown;
    _hidden.clear();
    _tasks.clear();
    _notify();
  }

  SharedTab? tabForDesk(String deskTabId) {
    final me = _snapshot.me?.accountId;
    if (me == null) return null;
    return _snapshot.tabs.where((t) => t.deskTabId(me) == deskTabId).firstOrNull;
  }

  bool isShared(String deskTabId) => tabForDesk(deskTabId) != null;

  /// One `share_*` action; the shares are read again after it, whatever it answered.
  Future<Map<String, dynamic>> act(String action, Map<String, dynamic> payload) async {
    final account = _account;
    try {
      return await request({'action': action, ...payload});
    } on WsRequestFailure catch (e) {
      final next = _stateFor(e.code);
      if (next == SharedTabsState.tooOld && account == _account) { _state = next!; _notify(); }
      throw SharedTabsFailure(e.code, e.message);
    } finally {
      if (account == _account) unawaited(refresh());
    }
  }

  Future<void> dismiss(String id) async {
    if (!_snapshot.canDismiss) { _hidden.add(id); _notify(); return; }
    try { await act('share_notice_dismiss', {'id': id}); } on SharedTabsFailure catch (e) {
      if (e.code == 'NOT_FOUND') return;
      _hidden.add(id); _notify();
    }
  }

  // Tasks and who: see below.

  @override
  void dispose() { _disposed = true; super.dispose(); }
}
```

Add `SharedTasks { bool loading; List<SharedTaskRow> rows; String? error; }` (rows parsed from the `share_tasks`
answer: repo, issue number and url, title, assignee `(accountId?, machineId, agentId)?`, pull request number/url/state,
CI state) and `loadTasks(sharedTabId)` that sets `loading`, calls `act('share_tasks', ...)`, keeps `error` as the
failure code (`GH_MISSING`, `GH_SIGNED_OUT`, `RATE_LIMITED`, `TIMEOUT`, `GH_FAILED`), drops a late answer after
`reset`, and never runs two reads of one tab at once. `who(sharedTabId)` calls `share_who` and maps
`machineId/agentId` → `(project, branch)`; a failure returns `{}`.

`SharedTabsWatch` is `AgentMessagesRemoteWatch` with `every = const Duration(seconds: 60)` and `controller.refresh()`
in `poll()`.

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tabs_controller_test.dart && flutter analyze`
Expected: PASS, no analyzer issues.

- [ ] **Step 5: Checkpoint.**

### Task B2: wiring on `AppNotifier`, the web's target, and the status slot (seam 1)

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (beside `agentMessages` ~1491; `_handleEvent` before `messages_changed`
  ~17574; desk join ~16295; `_clearAccountWorkspace` ~5855; dispose ~18430), `desktop/lib/screens/swarm_screen.dart`
  (~743–748: start the watch, listen for `_syncNative`)
- Test: `desktop/test/shared_tabs_app_test.dart`

**Interfaces:**
- Consumes: `SharedTabsController`, `SharedTabsWatch`, `SharedActivity` (B1).
- Produces: `AppNotifier.sharedTabs` (`late final SharedTabsController`), `AppNotifier.sharedTabsTarget` (the machine
  the controller asks: `localMachineState` natively; on the web the account's own online machine, R5),
  `AppNotifier.applySharedActivity(SharedActivity a)`.

- [ ] **Step 1: Write the failing tests** (fixture: `createApp({store, connectionForTest, connected})` from
  `test/swarm_state_test.dart` ~30–64, `MemoryStore`, `handleEventForTest`)

```dart
testWidgets('shared_tabs_changed reads shares again', (tester) async {
  final daemon = FakeDaemon()..answer('agent_messages', (p) => sharesAnswer());   // the fixture's fake WS
  final app = await createApp(connectionForTest: daemon.connection, connected: true);
  await app.sharedTabs.refresh();
  final before = daemon.count('agent_messages');
  app.handleEventForTest(localMachineId, {'type': 'shared_tabs_changed', 'payload': {'rev': 2}});
  await tester.pump();
  expect(daemon.count('agent_messages'), before + 1);
});
testWidgets('a reconnect reads shares again (Review Focus 3)', (tester) async { /* drop and reconnect the fake
  connection; one more `shares` read without waiting 60 s */ });
testWidgets('sign-out resets shared tabs', (tester) async { /* after refresh, sign out (the fixture's path that calls
  _clearAccountWorkspace): sharedTabs.snapshot.tabs is empty */ });
testWidgets('shared_activity marks another account\'s harness working, and the lease runs out', (tester) async {
  // a shared machine 'ma' (isShared) with agent 'a1' in machineStates, as the inventory merge builds it
  app.handleEventForTest(localMachineId, {'type': 'shared_activity', 'payload': {'sharedTabId': 'a' * 24,
    'machineId': 'ma', 'agentId': 'a1', 'state': 'working', 'validForMs': 30000}});
  expect(app.machineStates['ma']!.processingAgentIds, contains('a1'));
  await tester.pump(const Duration(seconds: 31));
  expect(app.machineStates['ma']!.processingAgentIds, isNot(contains('a1')));
});
testWidgets('shared_activity for an own machine is ignored', (tester) async { /* machine not isShared: unchanged */ });
test('on the web the target is an own online machine, never a shared one', () { /* viewer != null; focused pane on a
  shared machine; sharedTabsTarget is the own machine */ });
```

(Use the fixture's real fake-connection API; the names above stand for it.)

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tabs_app_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

Beside `agentMessages`:

```dart
/// Tabs shared with other accounts, as this computer's daemon holds them (1c). On the web, one of the account's own
/// machines answers (R5): window frames reach only a computer's own windows, so the browser reads on open, after its
/// actions and every 60 s in front.
late final sharedTabs = SharedTabsController(
  request: (payload) {
    final target = sharedTabsTarget;
    if (target == null) return Future.error(WsRequestFailure('MACHINE_AWAY', 'No computer of yours is online.'));
    return _conn(target.machine.machineId).request('agent_messages', payload: payload, timeout: const Duration(seconds: 8));
  },
  foreground: foreground,                        // the same ValueListenable the remote watch uses
  onActivity: applySharedActivity,
);

MachineState? get sharedTabsTarget {
  if (viewer == null) return localMachineState;
  final owned = ownedActionMachine;
  if (owned != null && !owned.machine.isShared && owned.online) return owned;
  return machineStates.values.where((m) => !m.machine.isShared && m.online).sortedBy((m) => m.machine.machineId).firstOrNull;
}

/// Another account's harness in a shared tab started or stopped working (seam 1): its tab's status slot follows it.
void applySharedActivity(SharedActivity a) {
  final machine = machineStates[a.machineId];
  if (machine == null || !machine.machine.isShared) return;
  final applied = _applyReportedActivity(machine, a.agentId,
      AgentActivity(a.state, 'shared:${a.sharedTabId}', a.revision, a.validForMs));
  if (applied.changed) notifyListeners();
}
```

(Use the real names for `foreground`, `online`, and the sort helper the file uses.) In `_handleEvent`, before the
`messages_changed` branch: `if (type == 'shared_tabs_changed') { sharedTabs.changed(); return; }` and
`if (type == 'shared_activity') { sharedTabs.handleActivity(payload); return; }` — only from the local machine's
connection (natively) — ignore them from any other connection. On the local connection's `connected`/reconnect path
call `sharedTabs.changed()`. At desk join beside `unawaited(agentMessages.refresh())`: `unawaited(sharedTabs.refresh())`.
In `_clearAccountWorkspace`: `sharedTabs.reset()`. In dispose: `sharedTabs.dispose()`.
`swarm_screen.dart` ~743 inside `if (!kUnderTest)`: create and start a `SharedTabsWatch(controller: app.sharedTabs,
foreground: ...)`, dispose it with the screen; ~748: `app.sharedTabs.addListener(_syncNative)` (and remove it).

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tabs_app_test.dart test/agent_messages_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task B3: other accounts' panes on the desk (R1, R2) and seams 2–5

**Files:**
- Create: `desktop/lib/agent_messages/shared_tab_placement.dart`
- Modify: `desktop/lib/state/app_state.dart` (`_deskReconcile` ~16560, `_attachPendingPanes` ~17075, `_attachSession`
  shared branch ~15343, `_rereadMachinesInBackground` ~7505, a new `openSharedDeskTab`), `desktop/lib/widgets/pane_grid.dart`
  (~1665–1672, ~1845–1868), `desktop/lib/state/workspace_status.dart` (~245), `desktop/lib/screens/swarm_screen.dart`
  (`_contextLinks` ~1677)
- Test: `desktop/test/shared_tab_placement_test.dart`, `desktop/test/shared_tabs_desk_test.dart`

**Interfaces:**
- Consumes: `SharedTabsController.snapshot` (B1), `sharedTabs` on `AppNotifier` (B2).
- Produces: `SharedPlacement planSharedPlacement({required String me, required List<SharedTab> tabs, required Set<String> deskTabIds,
  required Set<String> deskPaneKeys, required Map<String, Set<String>> seen})` returning
  `SharedPlacement { List<({String id, String name})> createTabs; List<({String deskTabId, String machineId, String agentId})> addPanes; Map<String, Set<String>> seen; }`.
- Produces: `AppNotifier.openSharedDeskTab(String id, String name)` (a desk tab with that id, not selected),
  `AppNotifier.sharedWaitingName(String machineId, String agentId) → String?` (the owner's display for seam 3).

- [ ] **Step 1: Write the failing tests**

`shared_tab_placement_test.dart` (pure):

```dart
SharedTab tab({String owner = 'alice', String? ownerTabId, List<String> foreign = const ['ma/a1']}) => /* builds a
  SharedTab with sharedTabId 's1', name 'app', harnesses from 'machine/agent' keys under account 'alice' */;

void main() {
  test('a member\'s first sight creates its tab and places every other account\'s harness', () {
    final p = planSharedPlacement(me: 'bob', tabs: [tab()], deskTabIds: {}, deskPaneKeys: {}, seen: {});
    expect(p.createTabs, [(id: 's1', name: 'app')]);
    expect(p.addPanes, [(deskTabId: 's1', machineId: 'ma', agentId: 'a1')]);
    expect(p.seen, {'s1': {'ma/a1'}});
  });
  test('a tab the member closed is never created again here (Review Focus 1)', () {
    final p = planSharedPlacement(me: 'bob', tabs: [tab(foreign: ['ma/a1', 'ma/a2'])], deskTabIds: {}, deskPaneKeys: {}, seen: {'s1': {'ma/a1'}});
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, isEmpty);
    expect(p.seen['s1'], {'ma/a1', 'ma/a2'});
  });
  test('a harness that joins later is placed once', () {
    final p = planSharedPlacement(me: 'bob', tabs: [tab(foreign: ['ma/a1', 'ma/a2'])], deskTabIds: {'s1'}, deskPaneKeys: {'ma/a1'}, seen: {'s1': {'ma/a1'}});
    expect(p.addPanes, [(deskTabId: 's1', machineId: 'ma', agentId: 'a2')]);
  });
  test('a pane the person closed is not placed again', () {
    final p = planSharedPlacement(me: 'bob', tabs: [tab()], deskTabIds: {'s1'}, deskPaneKeys: {}, seen: {'s1': {'ma/a1'}});
    expect(p.addPanes, isEmpty);
  });
  test('first sight of an existing desk tab places only what the desk holds nowhere', () {
    final p = planSharedPlacement(me: 'bob', tabs: [tab(foreign: ['ma/a1', 'ma/a2'])], deskTabIds: {'s1'}, deskPaneKeys: {'ma/a1'}, seen: {});
    expect(p.addPanes, [(deskTabId: 's1', machineId: 'ma', agentId: 'a2')]);
  });
  test('the owner places a member\'s harness into the tab it shared, never creating one', () {
    final p = planSharedPlacement(me: 'alice', tabs: [tab(owner: 'alice', ownerTabId: 'swarm-3', foreign: ['mb/b1'])], deskTabIds: {'swarm-3'}, deskPaneKeys: {}, seen: {'s1': {}});
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, [(deskTabId: 'swarm-3', machineId: 'mb', agentId: 'b1')]);
  });
  test('an owned tab whose desk tab is not known yet waits', () { /* ownerTabId null → nothing, seen unchanged */ });
  test('a tab no longer held is forgotten, so a later invitation places again', () { /* seen {'old': {...}} and no
     tab 'old' → seen has no 'old' */ });
}
```

`shared_tabs_desk_test.dart` (the desk fakes `_DeskApi` from `test/desk_sync_test.dart` ~45–78 and
`test/support/agent_messages_api.dart`):

```dart
testWidgets('the member\'s desk gets one tab and one pane, even from two windows at once (Review Focus 2)', (tester) async {
  // two AppNotifiers on the same fake desk and the same `shares` answer with one foreign harness whose shared machine is in the inventory
  // run placement on both, pump: the desk document holds one tab 's1' with one pane ma/a1
});
testWidgets('placement waits for the grant: an unknown machine re-reads the machines, and places after', (tester) async { /* … */ });
testWidgets('a desk-carried foreign pane is shared at once, never "Open here" (seam 2)', (tester) async {
  // desk names ma/a1 in a tab; machine 'ma' is shared in the inventory: after reconcile the pane has sharedHarness and
  // sharedOwnerName set, and pane_grid shows no "Open here"
});
testWidgets('restored before the inventory, a foreign pane says "Alice · waiting" (seam 3)', (tester) async {
  // machineStates has no 'ma'; sharedTabs snapshot lists ma/a1 under alice@example.com: the pane text is "alice@example.com · waiting"
  // (the owner's name when the roster's member entry has one), and no "This machine isn't available"
});
testWidgets('closing a foreign pane or its tab sends no stop (seam 4)', (tester) async {
  // requestClosePane and requestCloseSwarm on a tab holding ma/a1: no 'stop_agent' (or the close request type) reaches
  // any connection, and the review lists no foreign harness
});
testWidgets('the status bar names the owner for a focused foreign pane (seam 5)', (tester) async { /* … */ });
```

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tab_placement_test.dart test/shared_tabs_desk_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

`shared_tab_placement.dart`:

```dart
/// Where other accounts' harnesses go on this account's desk (1c spec; step 0 Variant A; R1, R2). Roster membership
/// and desk presence are separate facts: the roster places a pane once, after which the desk owns it.
SharedPlacement planSharedPlacement({
  required String me,
  required List<SharedTab> tabs,
  required Set<String> deskTabIds,
  required Set<String> deskPaneKeys,
  required Map<String, Set<String>> seen,
}) {
  final creates = <({String id, String name})>[];
  final adds = <({String deskTabId, String machineId, String agentId})>[];
  final nextSeen = <String, Set<String>>{};
  for (final tab in tabs) {
    final deskTabId = tab.deskTabId(me);
    final foreign = tab.harnesses.where((h) => h.accountId != me).toList();
    final before = seen[tab.sharedTabId];
    if (deskTabId == null) {                         // owned, desk tab not known yet: wait
      if (before != null) nextSeen[tab.sharedTabId] = before;
      continue;
    }
    nextSeen[tab.sharedTabId] = {...?before, ...foreign.map((h) => h.key)};
    if (!deskTabIds.contains(deskTabId)) {
      if (before != null || tab.ownedBy(me)) continue;   // closed by the person, or not this account's to create
      creates.add((id: deskTabId, name: tab.name));
      for (final h in foreign) adds.add((deskTabId: deskTabId, machineId: h.machineId, agentId: h.agentId));
      continue;
    }
    for (final h in foreign) {
      if (deskPaneKeys.contains(h.key)) continue;
      if (before != null && before.contains(h.key)) continue;
      adds.add((deskTabId: deskTabId, machineId: h.machineId, agentId: h.agentId));
    }
  }
  return SharedPlacement(createTabs: creates, addPanes: adds, seen: nextSeen);
}
```

`SharedTabHarness.key` is `'$machineId/$agentId'` (match `deskPaneKeys`' format, built from every pane of every desk
tab).

`AppNotifier`:
- `_placeSharedPanes()`, called when `sharedTabs` notifies and after `_deskReconcile` and after the inventory merge;
  only while the desk is joined and `sharedTabs.state == ready`. It loads `seen` from the store key
  `shared_tabs.placed` (JSON map of lists), runs `planSharedPlacement`, calls `openSharedDeskTab` for each create, and
  for each add `assignAgentToPane(null, machineId, agentId, swarmId: deskTabId, focus: false, intent: AttachIntent.automatic)`.
  An add whose machine is not in `machineStates` yet is not recorded as seen: it calls
  `unawaited(_rereadMachinesInBackground(pushed: true))` and is tried at the next inventory change. Then it saves `seen`.
- `openSharedDeskTab(id, name)`: inserts `Swarm(id: id, name: name)` at the end of `swarms` without selecting it, and
  `_persistLayout()` (the desk sends `tab.create` with that id through `deskDiff`).
- Seam 2: a helper `_bindShared(TerminalPane pane)` with the code at ~15343–15348 (`sharedHarness`/`sharedOwnerName`
  from the shared machine), called in `_deskReconcile` after creating a pane (~16560–16567) and at the top of the
  `_attachPendingPanes` loop (~17075). When `machineStates[pane.machineId]` is null and the pane is listed in a held
  roster under another account, `unawaited(_rereadMachinesInBackground(pushed: true))`.
- Seam 3: `sharedWaitingName(machineId, agentId)` returns the owner's name or email from the snapshot when a held
  roster lists that harness under another account; `pane_grid.dart` checks it before the "Waiting for this machine…"
  and "This machine isn't available" branches and draws `'$name · waiting'`.
- Seam 4: no change (R9); the tests pin it.
- Seam 5: in `WorkspacePaneContext.focused` (`workspace_status.dart` ~245), use `pane.sharedOwnerName` (or the shared
  machine's `ownerName`) before `displayName`; in `_contextLinks` (`swarm_screen.dart` ~1677) the machine link is off
  for a shared pane.

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tab_placement_test.dart test/shared_tabs_desk_test.dart test/desk_sync_test.dart test/swarm_state_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

---

## Phase C: desktop UI

### Task C1: the tab's mark and its menus

**Files:**
- Modify: `desktop/lib/screens/swarm_screen.dart` (`_syncNative` ~2041–2076; `_onNative` ~2401 and the follow-up set
  ~2556; command table ~6836; `_canExecuteCommand` ~6905), `desktop/lib/screens/swarm_menu_bus.dart`,
  `desktop/macos/Runner/SwarmTitlebar.swift` (`installWorkspaceMenus` ~352, `validateMenuItem` ~525, `SwarmTabStrip.update`
  ~2386–2406, `SwarmTabButton` init ~2932–2946, `draw()` ~3060, `updateAccessibility()` ~3099),
  `desktop/lib/widgets/linux_menu_bar.dart` (~352–360), `desktop/lib/widgets/desktop_workspace_tab.dart`,
  `desktop/lib/web/tabs/web_tab_menu.dart` (~97–139), `desktop/lib/shortcuts/keymap_commands.dart` (~511)
- Test: `desktop/test/native_toolbar_sync_test.dart`, `desktop/test/desktop_workspace_tab_test.dart`,
  `desktop/test/linux_menu_bar_test.dart`, `desktop/tool/swarm_titlebar_checks.swift` (beside `checkAgentMessages` ~651)

**Interfaces:**
- Consumes: `sharedTabs.tabForDesk`, `snapshot.me`, `state` (B1/B2).
- Produces: per-tab native field `shared: {'count': int, 'role': 'owner' | 'member', 'canMoveHere': bool}` (absent for
  an unshared tab, and absent entirely unless `state == ready`); native methods `invitePeople`, `stopSharingTab`,
  `moveTabHere`, `leaveTab` with `["id": swarmId]`; Dart handlers that open the dialogs of C2 (`showInvitePeople`,
  `confirmStopSharing`, `confirmMoveHere`, `confirmLeaveTab`, declared in C2 — C1 calls them, so implement C1 after C2's
  function names exist, or add them as thin stubs that C2 fills; the controller orders C2 before C1 if needed).
- `canMoveHere`: the account owns the tab, this is a native window, and this computer is not
  `ownerMachineId`.

- [ ] **Step 1: Write the failing tests**

`native_toolbar_sync_test.dart`:

```dart
test('a shared tab sends its count and role, an unshared tab sends nothing', () { /* fake sharedTabs ready with
  swarm-3 owned by me with 7 harnesses and ownerMachineId == local → rows['swarm-3']['shared'] ==
  {'count': 7, 'role': 'owner', 'canMoveHere': false}; swarm-1 has no 'shared' key; state tooOld → no tab has it */ });
```

`desktop_workspace_tab_test.dart`:

```dart
testWidgets('the Flutter tab shows the people mark and count', (tester) async {
  // DesktopWorkspaceTab(name: 'app', sharedCount: 7) shows Icons.people_alt (or the icon the app uses) and '7', and its
  // semantics label is 'app, shared tab, 7 harnesses'
});
testWidgets('right-click opens the tab menu by role', (tester) async {
  // owner: Invite People…, Show Agent Messages, Stop Sharing Tab; member: Show Agent Messages, Leave Tab;
  // unshared: Invite People…, Show Agent Messages. Each item calls its callback.
});
testWidgets('a hostile tab name stays one ellipsized line (Review Focus 5)', (tester) async {
  // name = '‮' + 'x' * 300 + '<b>': the tab is no wider than its max width and renders the text literally
});
```

`linux_menu_bar_test.dart`: the File menu lists Invite People… and, for a shared tab, Stop Sharing Tab or Leave Tab,
enabled by the same flags. `swarm_titlebar_checks.swift`: a `checkSharedTab()` that builds a `SwarmTabButton` with
`shared: ["count": 7, "role": "owner", "canMoveHere": true]`, asserts the width grew by the cached mark's width, the
menu holds Invite People…, Stop Sharing Tab and Move here in that order, and the select button's help is
"Shared tab, 7 harnesses"; with `role: member`, Leave Tab and no Invite.

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/native_toolbar_sync_test.dart test/desktop_workspace_tab_test.dart test/linux_menu_bar_test.dart && tool/check_swarm_titlebar.sh`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `_syncNative`: for each tab, `final shared = app.sharedTabs.state == SharedTabsState.ready ? app.sharedTabs.tabForDesk(tab.id) : null;`
  and when non-null add `'shared': {'count': shared.harnesses.length, 'role': shared.ownedBy(me) ? 'owner' : 'member',
  'canMoveHere': shared.ownedBy(me) && !kIsWeb && shared.ownerMachineId != localMachineId}`.
- Swift `SwarmTabStrip.update` reads `shared` into the button: `sharedCount: Int?`, `sharedRole: String?`,
  `canMoveHere: Bool`. The mark is an `NSImage(systemSymbolName: "person.2.fill", accessibilityDescription: nil)` plus
  the count as a cached attributed label, drawn after the name in `draw()` and counted in the button's width. The
  accessibility group label stays the name; the select button's help becomes "Shared tab, N harnesses" (the integration
  test finds tabs by "Select <tab>" help: keep "Select <tab>" as the help of an unshared tab).
- Menu: four items made with the existing `item(title, selector)` → `emit("<method>", ["id": swarmId])`:
  "Invite People…" (`invitePeople`), "Stop Sharing Tab" (`stopSharingTab`), "Move Here" (`moveTabHere`), "Leave Tab"
  (`leaveTab`), shown by `updateShareItems()` per role: no `shared` → Invite only; owner → Invite, Stop, and Move Here
  when `canMoveHere`; member → Leave only. Show Agent Messages stays as it is.
- File menu (`installWorkspaceMenus` ~352): the same four for the active tab, with flags through
  `SwarmMenuBus.apply/clear` and `validateMenuItem`; Linux (`linux_menu_bar.dart`) the same flags.
- Dart `_onNative`: `case 'invitePeople': showInvitePeople(context, app, id)`, `case 'stopSharingTab':
  confirmStopSharing(...)`, `case 'moveTabHere': confirmMoveHere(...)`, `case 'leaveTab': confirmLeaveTab(...)`.
- `DesktopWorkspaceTab`: `int? sharedCount` draws the mark and count after the name (ellipsize the name first, never
  the count); an `onSecondaryTapDown` opens a `MenuAnchor` with the items above (copy the `MenuAnchor` +
  `onSecondaryTapDown` + `CustomSemanticsAction` pattern from `lib/widgets/machines_panel.dart` ~526–570, ~1100–1130), so
  the web and Linux have the native menu's items. `webTabMenuRows` gains the same rows.
- Command table and palette (`swarm_screen.dart` ~6836, `keymap_commands.dart` ~511): "Invite People…", "Stop Sharing
  Tab", "Leave Tab", "Move Tab Here" for the active tab, enabled by role, so each is reachable without a menu.
- Every item is hidden while `state` is not `ready`, except Invite People… which, when `state` is `off`, opens Settings ▸
  Experimental at the switch, and when `tooOld` is hidden.

- [ ] **Step 4: Run to pass**

Run: the Step 2 commands, then `cd desktop && flutter analyze`.
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task C2: Invite People, Stop Sharing, Leave, Move here

**Files:**
- Create: `desktop/lib/agent_messages/shared_tab_dialogs.dart`
- Modify: `desktop/lib/sharing/share_harness_dialog.dart` (`tabMode`; Copy row ~295; address cap ~166–170)
- Test: `desktop/test/shared_tab_dialogs_test.dart`, `desktop/test/share_harness_dialog_test.dart` (or the file that
  tests it today)

**Interfaces:**
- Produces: `Future<void> showInvitePeople(BuildContext context, AppNotifier app, String deskTabId)`,
  `Future<void> confirmStopSharing(...)`, `Future<void> confirmLeaveTab(...)`, `Future<void> confirmMoveHere(...)` (same
  parameters); `ShareHarnessDialog({..., bool tabMode = false})`.
- Produces: `String sharedTabErrorText(SharedTabsFailure f, {String? owner, String? machine})` — the spec's Errors
  table, used by every dialog and the panel.

- [ ] **Step 1: Write the failing tests**

```dart
testWidgets('the first invitation shares the tab, then invites', (tester) async {
  // unshared desk tab swarm-3 named 'app'; fake request answers share_tab {sharedTabId: s1}, share_invite {invited: [...], refused: []}
  // type 'carol@example.com', choose 30 days, Invite: requests in order share_tab {tabId: 'swarm-3', name: 'app'}, share_invite {sharedTabId: 's1', emails: ['carol@example.com'], days: 30}
});
testWidgets('a shared tab invites without sharing again, lists pending invitations with Revoke', (tester) async { /* … */ });
testWidgets('tab mode has no Copy, Access or Comments, and refuses a ninth address', (tester) async { /* … */ });
testWidgets('Stop Sharing asks first, then share_stop', (tester) async {
  // dialog text: 'Stop sharing "app"?' and 'Everyone in it loses its harnesses' terminals and messages.'; Stop → share_stop
});
testWidgets('Leave asks first, then share_leave', (tester) async { /* 'Leave "app"? Your harnesses leave the tab. Alice can invite you again.' */ });
testWidgets('Move here explains and calls share_move', (tester) async {
  // text: 'Members whose computers can\'t confirm the move will be asked to trust this computer.'
});
for (final (code, text) in [
  ('MACHINE_AWAY', 'Bob\'s laptop is away. Try again when it\'s on.'),
  ('TAB_FULL', 'A shared tab holds 32 harnesses and 8 people.'),
  ('RATE_LIMITED', 'This tab sent 120 messages in 10 minutes. Try again in a few minutes.'),
  ('TOO_LARGE', 'That message is too long for a shared tab.'),
  ('SHARED_TABS_UNSUPPORTED', 'Shared tabs aren\'t available on the Harness service yet.'),
  ('DAEMON_TOO_OLD', 'Update Harness on this computer to share tabs.'),
]) {
  test('$code reads "$text"', () => expect(sharedTabErrorText(SharedTabsFailure(code, ''), owner: 'Alice', machine: 'Bob\'s laptop'), text));
}
```

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tab_dialogs_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

`showInvitePeople`: `ShareHarnessDialog(name: tabName, tabMode: true, manage: (action, payload) => _tabInviteManage(app, deskTabId, action, payload))`
where the adapter maps `list` → the shared tab's `invites` from the roster plus pending ones (`[{id?, email, expiresAt}]`
in the shape the dialog's list reads), `invite {emails, days}` → `share_tab` first when `tabForDesk(deskTabId)` is null
(`{tabId, name}`), then `share_invite {sharedTabId, emails, days}`; `remove {id}` → `share_revoke {inviteId: id}`.
Refused addresses from `share_invite` show in the dialog's existing error line with each address and its error text.
`tabMode`: hides the Access, Comments and Copy rows (and their `_ShareRow` keyboard stops) and caps addresses at 8.

The three confirmations use the app's existing confirmation dialog widget (the one Close Tab's review uses); each
calls `app.sharedTabs.act(...)` and on `SharedTabsFailure` shows `sharedTabErrorText` in the dialog, never closing on
failure. Move here is offered only where `canMoveHere` (C1) holds.

`sharedTabErrorText` covers the spec's Errors table: the six codes tested above, plus `NOT_OWNER` → "Only the computer
that shares this tab can change it.", `SHARED_ELSEWHERE` → "This tab is already shared from another of your computers.
Change it there.", `RELAY_TAKEN` → "This tab is connected from another place; messages wait here.", and any other code
→ the daemon's message (plain text) or "Something went wrong. Try again in a moment."

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tab_dialogs_test.dart test/share_harness_dialog_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task C3: receiving an invitation, Tab invites, Trust again, and the switch's copy

**Files:**
- Create: `desktop/lib/widgets/shared_tab_notice.dart`, `desktop/lib/settings/sections/tab_invites_section.dart`
- Modify: `desktop/lib/settings/settings_section.dart` (~17–41, ~121–136), `desktop/lib/settings/settings_body.dart`
  (~36–43), `desktop/lib/settings/experimental_features.dart` (~41–43), `desktop/lib/app_shell.dart` (~409–419),
  `desktop/lib/state/app_state.dart` (`requestSharedTabs`/`takeSharedTabsRequest` like `requestMachines` ~4255–4266),
  `desktop/lib/screens/swarm_screen.dart` (~3141, ~3013), `desktop/lib/agent_messages/shared_tab_dialogs.dart`
- Test: `desktop/test/shared_tab_invites_test.dart`

**Interfaces:**
- Produces: `SettingsSection.tabInvites`; `Future<void> showAcceptInvite(BuildContext, AppNotifier, SharedTabInvite)`;
  `Future<void> showAddHarnesses(BuildContext, AppNotifier, String sharedTabId)`; `Future<void> showTrustAgain(BuildContext, AppNotifier, String sharedTabId)`;
  `AppNotifier.requestSharedTabs()` / `takeSharedTabsRequest()`.

- [ ] **Step 1: Write the failing tests**

```dart
testWidgets('a new invitation shows one notice with View, once per invitation', (tester) async {
  // snapshot with invite i1 from alice@example.com, tabName 'app': notice text 'alice@example.com invited you to the tab "app"';
  // View opens Settings ▸ Tab invites; a second refresh with the same invite shows no second notice (store key shared_tabs.invites_seen)
});
testWidgets('an invitation from an older backend says "a tab"', (tester) async { /* tabName '' → '… invited you to a tab' */ });
testWidgets('Accept shows the promise, then the fingerprint after it succeeds', (tester) async {
  // dialog: tab name, owner email, 'Alice and everyone in this tab will see the terminals of the harnesses you add. Only you can type into them.'
  // Accept → share_accept {inviteId: 'i1'} answers {sharedTabId: 's1', fingerprint: 'AB12 …'}:
  // shows the fingerprint and 'Compare it with alice@example.com if you want to be sure.' and a 'Add harnesses' button
});
testWidgets('a pending accept says the tab comes when the owner\'s computer is reachable', (tester) async {
  // answer {sharedTabId: 's1', pending: true} → "The tab will appear when alice@example.com's computer is reachable."
});
testWidgets('Add harnesses adds the picked ones, or opens New Harness in the tab', (tester) async {
  // own harnesses listed (name · engine · machine); pick two → two share_add {sharedTabId, harness: {machineId, agentId, name, engine}};
  // MACHINE_AWAY for one shows "<machine> is away. Try again when it's on." and keeps the dialog
});
testWidgets('Tab invites lists invitations and untrusted tabs with Trust again', (tester) async {
  // untrusted [{sharedTabId: 's2', ownerEmail: 'alice@example.com'}] → amber row "alice@example.com's computer has a new key." with Trust again;
  // Trust again → share_retrust_check answers {fingerprint, pinnedFingerprint, ...}: shows both, Confirm → share_retrust {sharedTabId, ownerPub}
});
testWidgets('the switch\'s copy names inviting people', (tester) async {
  // ExperimentalFeature.agentMessages description contains 'Invite people to a tab and their harnesses join it from their own computers.'
});
```

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tab_invites_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Notice: copy `NewDeviceNotice` (`lib/widgets/new_device_notice.dart` ~18–80) into `SharedTabNotice`, placed in
  `app_shell.dart` ~409–419 inside a `ListenableBuilder(listenable: app.sharedTabs, ...)`. It shows the newest pending
  invitation whose id is not in the store's `shared_tabs.invites_seen` (R7); View calls `app.requestSharedTabs()`, and
  showing it records the id. Daemon notices (`removed`, `full`, `refused`, `unsent`, `relay_taken`) show in the same
  slot, one at a time, with their copy from the Errors table ("You were removed from alice@example.com's tab" for
  `removed`) and a dismiss that calls `app.sharedTabs.dismiss(id)`.
- Settings: `SettingsSection.tabInvites` with keywords `['invite', 'shared tab', 'trust']`, in the group beside
  Experimental, `settings_body.dart` case, and `TabInvitesSection` built from `SettingRow`: one row per invitation
  (tab name or "a tab", owner email, expiry) with Accept and Decline (Decline = `share_revoke {inviteId}` — the
  backend lets the invitee drop it); then one amber row per untrusted tab with Trust again. Empty: "No invitations."
- `showAcceptInvite`: the copy above; Accept calls `share_accept {inviteId}`; on success either the fingerprint view
  or the pending text; then **Add harnesses**. `share_accept` errors (`OWNER_KEY_MISMATCH`, `ROSTER_INVALID`) show the
  daemon's message as plain text.
- `showAddHarnesses`: this account's harnesses (from `machineStates`, own machines only) with checkboxes and
  **New Harness here**, which starts the New Harness flow targeting the desk tab `sharedTabId` (R1) — C4's hook adds it.
- `showTrustAgain`: `share_retrust_check` then a confirm showing "New: <fingerprint>" and, when present, "Before:
  <pinnedFingerprint>", then `share_retrust {sharedTabId, ownerPub}`.
- `experimental_features.dart`: append the sentence to the Agent Messages description (base spec copy).
- `requestSharedTabs`/`takeSharedTabsRequest` copy `requestMachines`/`takeMachinesRequest`; the workspace opens
  `_settings(SettingsSection.tabInvites)` as `_maybeOpenMachinesRequest` does (~3141).

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tab_invites_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task C4: harnesses in a shared tab: adding, removing, chips

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`assignAgentToPane` after the insert ~15349; `movePaneToSwarm` ~15916),
  `desktop/lib/screens/swarm_screen.dart` (`paneActions` ~1973: `removeFromTab`), the pane header widget (find where
  the pane title row draws its chips, beside the existing shared-harness owner name),
  `desktop/lib/sharing/shared_harness_panel.dart` (~185–190, ~249–250: ended copy and Remove)
- Test: `desktop/test/shared_tab_panes_test.dart`

**Interfaces:**
- Consumes: `sharedTabs.isShared`, `tabForDesk`, `snapshot.pending` (B1), `sharedTabErrorText` (C2).
- Produces: pane chips `Leader`, `View only`, `Joining…`, `Sharing ended`; pane action `removeFromTab`.

- [ ] **Step 1: Write the failing tests**

```dart
testWidgets('dragging an own harness into a shared tab adds it to the tab', (tester) async {
  // assignAgentToPane(null, 'mb', 'b1', swarmId: 's1', intent: AttachIntent.person) → one share_add {sharedTabId: 's1',
  // harness: {machineId: 'mb', agentId: 'b1', name: ..., engine: ...}}
});
testWidgets('placement and desk reconcile never add to the tab', (tester) async { /* intent automatic → no share_add */ });
testWidgets('moving a pane into a shared tab adds it; out of it removes it', (tester) async { /* movePaneToSwarm both ways */ });
testWidgets('a shared machine\'s pane is never added', (tester) async { /* the foreign pane dragged elsewhere: no share_add */ });
testWidgets('Remove from Tab sends share_remove and the pane stays as an ordinary pane', (tester) async { /* … */ });
testWidgets('chips: Leader, View only with the owner, Joining… while pending, Sharing ended with Remove', (tester) async {
  // leader ma/a1 → 'Leader' on that pane; foreign pane → owner name + 'View only'; pending add of mb/b1 → 'Joining…' with
  // tooltip "Waiting for alice@example.com's computer"; grant gone → 'Sharing ended' and Remove closes the pane (pane.remove only)
});
testWidgets('a share_add refused with MACHINE_AWAY shows the away text', (tester) async { /* … */ });
```

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tab_panes_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

- In `assignAgentToPane`, after the pane is inserted: if `intent == AttachIntent.person`, the machine is not
  `isShared`, and `sharedTabs.tabForDesk(target.id)` is a tab, then `unawaited(_shareAdd(tab, machineId, agentId))`,
  which calls `sharedTabs.act('share_add', {'sharedTabId': tab.sharedTabId, 'harness': {...}})` with the harness's
  name and engine from `machineStates`, and on `SharedTabsFailure` shows `sharedTabErrorText` through the app's
  existing transient notice. New Harness ends in `assignAgentToPane(null, …, swarmId: targetId)` (~12831): pass
  `intent: AttachIntent.person` there when the person started it (check that call site's existing intent; New Harness
  is a person's action).
- `movePaneToSwarm`: moving into a shared tab adds (as above); moving an own harness out of a shared tab removes
  (`share_remove {sharedTabId, machineId, agentId}`).
- `paneActions['removeFromTab']`: shown on an own harness's pane in a shared tab; calls `share_remove`; the pane
  stays where it is (the person closes it if they want).
- Chips in the pane header: `Leader` when `tab.leader` is this pane; for a shared machine's pane in a shared tab,
  the owner's name and `View only`; `Joining…` (dimmed pane) while `snapshot.pending` holds an add for this pane, with
  the tooltip "Waiting for <owner>'s computer"; `Sharing ended` with **Remove** when the pane's grant is gone (the
  panel's ended state at `shared_harness_panel.dart` ~185–190, whose copy becomes "Sharing ended" and gains a Remove
  button that removes the pane from the desk, nothing else).
- Hostile names: chips and tooltips take names as `Text` with `maxLines: 1, overflow: TextOverflow.ellipsis`.

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tab_panes_test.dart test/swarm_state_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task C5: Show Agent Messages: Messages | People | Tasks

**Files:**
- Create: `desktop/lib/agent_messages/shared_tab_people.dart`, `desktop/lib/agent_messages/shared_tab_tasks.dart`
- Modify: `desktop/lib/agent_messages/agent_messages_view.dart` (`showAgentMessages` ~16)
- Test: `desktop/test/shared_tab_panel_test.dart`, `desktop/test/agent_messages_tab_test.dart` (unchanged behaviour for
  an unshared tab)

**Interfaces:**
- Consumes: `sharedTabs` (B1): `tabForDesk`, `snapshot.alerts/notices/untrusted/pending`, `who`, `tasksFor`,
  `loadTasks`, `act`, `dismiss`; dialogs from C2/C3.

- [ ] **Step 1: Write the failing tests**

```dart
testWidgets('an unshared tab shows the log alone, as today', (tester) async { /* no pills */ });
testWidgets('a shared tab has Messages, People and Tasks, by mouse and by ←/→', (tester) async { /* … */ });
testWidgets('People: one block per account, each harness with engine · machine · state · repo/branch', (tester) async {
  // who answers {'ma/a1': (project: 'api', branch: 'main')}; activity working for a1 → 'claude · ma · working · api/main';
  // while who has not answered, skeleton rows in the shape of the list (not a spinner, not "No harnesses")
});
testWidgets('the owner\'s computer has Invite, Revoke, Make Leader, Remove and Remove member', (tester) async {
  // Make Leader → share_leader {sharedTabId, leader: {machineId, agentId}}; Remove → share_remove; Remove member → share_remove_member {accountId}
});
testWidgets('another computer of the owner hides those, with where they can be done', (tester) async {
  // tooltip 'Only the computer that shares this tab can change it'; Stop and Move here still offered
});
testWidgets('alerts sit in an amber band with plain words and dismiss', (tester) async {
  // foreign_machine → 'The tab lists a computer as yours that isn\'t.'; dismiss → share_notice_dismiss {id}
});
testWidgets('RELAY_TAKEN and untrusted tabs show their bands', (tester) async { /* relay_taken notice → 'This tab is connected
  from another place; messages wait here.'; untrusted → "alice@example.com's computer has a new key." + Trust again */ });
testWidgets('Tasks: rows, Enter opens the issue, an assignee opens its pane, errors in one line', (tester) async {
  // GH_MISSING → 'Install the GitHub CLI (gh) on this computer to see tasks.'; GH_SIGNED_OUT → 'Run gh auth login on this computer to see tasks.';
  // RATE_LIMITED / TIMEOUT / GH_FAILED → 'GitHub didn\'t answer. Try again later.'; a title '<b>x</b>' renders literally
});
testWidgets('too old: one line instead of the panel\'s shared parts', (tester) async {
  // state tooOld → 'Update Harness on this computer to share tabs.'; off → a link to Settings ▸ Experimental
});
testWidgets('hostile names and emails in People stay plain and ellipsized (Review Focus 5)', (tester) async { /* … */ });
```

- [ ] **Step 2: Run to fail**

Run: `cd desktop && flutter test test/shared_tab_panel_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `showAgentMessages` gains `initialTab` and draws `DesktopPill` tabs with ←/→ focus handling as
  `lib/widgets/session_work_dialog.dart` ~170–176, ~254–285 does, only when `sharedTabs.tabForDesk(tabId)` is a tab.
  Opening the panel calls `sharedTabs.refresh()` (the spec's "when a panel opens").
- `SharedTabPeople`: the amber band first (this tab's undismissed alerts, its `relay_taken` notices, and the untrusted
  line when the tab is untrusted), each with plain words from this map and a dismiss:
  `foreign_machine` "The tab lists a computer as yours that isn't." (with Remove when the listed harness is on that
  machine: `share_remove`), `machine_key_mismatch` "A computer in this tab changed its key; its harnesses were left
  out.", `own_machine_listed` "The tab lists one of your computers under another account; it was left out.",
  `bad_signature` "A change to this tab wasn't signed by its owner's computer, so it was ignored.", `unpinned_key`
  "This tab is signed by a computer you haven't trusted yet." (with Trust again), `share_id_mismatch` "The Harness
  service named this tab differently than expected, so this computer didn't sign for it.", any other code "Something
  about this tab couldn't be verified." Then one block per account (owner first): email (and name), each harness with
  `engine · machine · state · repo/branch` (machine: the own machine's name, or the 8-character id for another
  account's; state from `machineStates` / shared activity; repo/branch from `who`, loaded on open). Owner on the
  owner's computer (`ownerMachineId == localMachineId`): Invite (opens C2), pending invitations with Revoke, Make Leader
  and Remove on each harness, Remove member on each member block. Elsewhere those are hidden and a single line says
  "Only the computer that shares this tab can change it."
- `SharedTabTasks`: on open `loadTasks`; skeleton rows while loading; a table (repo, issue, title, assignee, pull
  request, CI); Enter or click on a row opens the issue or pull request URL (`url_launcher` as the app does); an
  assignee cell focuses its pane (`app.focusAgent(machineId, agentId)` or the app's equivalent); errors in one line from
  the map in the test above; empty: "No tasks for this tab. Agents in it create them as GitHub issues."
- All names, emails, titles: `Text(..., maxLines: 1, overflow: TextOverflow.ellipsis)`, never `RichText` from markup.

- [ ] **Step 4: Run to pass**

Run: `cd desktop && flutter test test/shared_tab_panel_test.dart test/agent_messages_tab_test.dart && flutter analyze`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

---

## Phase D: verification and docs

### Task D1: native, web and by hand

**Files:**
- Modify: `desktop/integration_test/native_workspace_e2e_test.dart` (or `sign_in_native_test.dart`, whichever already
  drives the native tab row through `tool/native_driver.py`)
- Create: `desktop/test/web/shared_tabs_web_test.dart`

- [ ] **Step 1: Native mark.** An integration test that gives the fake daemon a `shares` answer with the active tab
  owned and 3 harnesses, and asserts through `native_driver.py` that the tab's select button help is "Shared tab, 3
  harnesses". (Context menus cannot be opened by the driver; their items are covered by `swarm_titlebar_checks.swift`
  in C1.)

Run: the command the existing native integration test documents in its header.
Expected: PASS.

- [ ] **Step 2: Web.** Chrome tests for the mouse-only paths: right-click the Flutter tab → Invite People… opens the
  form; the panel's People and Tasks pills switch by click; the web never offers Move Here.

Run: `cd desktop && flutter test --platform=chrome --dart-define=HARNESS_TEST=true test/web/shared_tabs_web_test.dart`
Expected: PASS.

- [ ] **Step 3: Full suites.**

Run: `cd desktop && flutter analyze && make -C .. desktop-test`; `cd cli && npm run test:shared-tabs && npm run test:core
&& npm test && npm run typecheck`; `cd backend && npm test`.
Expected: PASS, except failures documented as pre-existing on clean `main` (desktop has ~26 known reds; diff against a
clean worktree before calling any failure new).

- [ ] **Step 4: By hand.** `cli/scripts/spike-a-stack.ts` (two fake accounts on a local backend) with Bob's desktop
  built under the bundle id `ai.autonomous.harness.spike` against Bob's isolated daemon (never the installed
  Harness.app). Walk the whole flow and take a screenshot at each step: Alice shares and invites; Bob gets the notice,
  accepts (fingerprint), adds a harness; both see each other's harnesses (View only), the tab mark `app · 👥 N`, the
  spinner following the other account's harness; People, Tasks (with a `gh` stub repo or a real test repo), Make
  Leader; Bob leaves → Alice sees the harness gone; Alice stops → Bob's panes say `Sharing ended`. Record each
  screenshot path and anything that looked wrong in the task report.

- [ ] **Step 5: Checkpoint.**

### Task D2: docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-shared-tabs-desktop-design.md` (daemon additions now five; rulings R1–R9
  where they settle what the spec left open: the member's desk tab id, placed-once per computer, `share_who`,
  activity, the web's target, `api: 2`, the invitation's tab name, the Share form's tab mode, seam 4), its status line
  ("built" once D1 passes)
- Modify: `docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md` (status: 1c built; the table
  row for the desktop), `docs/design/2026-10-10-agent-messages.md` (step status), `docs/plans/2026-10-15-shared-tabs-1b-delivery.md`
  (Follow-ups: mark the ones 1c closed)
- Check: `docs/naming-system.md` for every new visible string of this plan (no "team"; "shared tab", "member",
  "leader")

- [ ] **Step 1: Write the changes,** each a short paragraph or a table row in the doc's own style.
- [ ] **Step 2: Grep the visible strings** added in C1–C5 for "team" and for internal words ("roster", "relay",
  "pin", "daemon") that a first-time user would not know; rewrite any found. ("Harness service" is the naming system's
  word for the backend.)

Run: `grep -rn -i "team\|roster\|relay\|daemon" desktop/lib/agent_messages/shared_tab_*.dart desktop/lib/widgets/shared_tab_notice.dart desktop/lib/settings/sections/tab_invites_section.dart`
Expected: no visible string matches (identifiers and comments may).

- [ ] **Step 3: Checkpoint.**

---

## Not in 1c

The consent view, "also visible to tab X" in the Share dialog, a notice center, the phone, composing messages or
tasks in the panel, a "?" mark for another account's harness waiting on a question (R4), friendly machine names for
another account's computers (a roster field later), and the 1b follow-ups not listed under D2.

## Follow-ups

- A computer that holds a tab but lists no harness in it (viewer-only) is refused by the relay and gets no spinner for
  other accounts' harnesses; forward through one of the account's listed computers.
- A member's shared tab shows at most 9 panes (the desk's grid); the rest are only listed under People.
- The `foreign_machine` alert has no Remove (alerts carry no machine id).
- Activity is sent per peer on a timer; deliver it per peer on change and with backoff.
- No way to decline an invitation other than waiting for it to expire.
- The skew e2e needs the 2c2c6be52 build as its old bundle (a fresh 4f92ee5e9 build fails the old-master test).
- A refresh answer computed before an idle frame can show `working` again for up to 30 s (the lease bounds it; final
  review of 1c, M3).
- A tab that drops out of one `shares` answer forgets what was placed, so a tab the member closed can come back once
  (final review of 1c, M4); limit the pruning to an explicit end (a `removed` notice or the member's own leave).
- A harness still `Joining…` from another computer of the account is withdrawn only from that computer: this
  computer's `shares` lists only the adds its own daemon holds.
- Owner flows were run by hand on the owner's desktop after the final fix wave (Invite, Revoke, Make Leader, Remove,
  Remove member, Move here from a second computer, Stop): all passed. Still with the owner: the pass with two real
  Google accounts and the docker boxes.
- A failed first `shares` read after a relaunch sets `unavailable`, and an owner's shared tab can then be given a new id
  until a later read succeeds; check `snapshot.me != null` instead of the state.
- A withdrawn `Joining…` add that the owner's computer already received is applied anyway; the roster lists a harness
  without consent (no one can watch it). Adopting a roster that lists such a harness with no queued add should queue a
  remove.
- Remove and Remove member in People act on the first click, with no confirmation.
- After a removal or Stop, the owner closes the "Sharing ended" panes one by one; offer to close them together.
- The Show Agent Messages panel re-centres when its content changes height, and the Tasks header can be cut off.
