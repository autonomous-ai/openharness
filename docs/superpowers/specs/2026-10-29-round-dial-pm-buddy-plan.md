# Round dial PM ↔ Buddy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the round dial, each Swarm project gets a PM screen and a Buddy screen. Swipe up opens the Buddy screen
and swipe down returns to the PM screen. Voice works as today, and a refused post never becomes a terminal turn.

**Architecture:** As in the 10-28 swarm-chat design, the daemon decides and the firmware draws.
- `cli/src/superTabs/cards.ts` learns a per-Swarm *side* (`pm`/`buddy`) set by the dial. It picks the reader's Buddy
  chat as the face on the Buddy side, adds a `buddy` block to each Lead, and watches the Buddy chat for a quiet
  notice.
- The cable session negotiates `swarmBuddy: 'v1'`, carries the new fields and passes `supertab.side` through.
- The firmware keeps the side per Swarm, maps the vertical swipe, and draws the dots, the lilac ring, the avatar, the
  empty state and the quiet badge.

**Tech Stack:** TypeScript (cli, vitest), C (ESP-IDF 5.5 firmware, host tests through `make device-test`), Dart (one
parity test).

**Spec:** `2026-10-29-round-dial-pm-buddy-spec.md` (beside this file). The mockup is
`2026-10-29-round-dial-pm-buddy-mockup.html`. Read both before Task 1.

## Global Constraints

- Base on current `origin/main`; this plan was read at 5df861254. Follow `AGENTS.md` and `cli/AGENTS.md`.
- Merge with `make merge-pr ARGS="N --reviewed-head SHA --reviewed-base SHA --merge"` once `ci/required` is green and
  a Reviewer approved that exact head. Do not rerun CI except for a recorded flaky test.
- `cli/src/core/` and `cli/src/services/` keep 100 % per-file coverage: run `npm run test:core` locally and record it
  in the PR.
- The firmware gate is `idf.py build` plus `make device-test`.
  - Dev images to flash are built with `-DPROJECT_VER=0.0.99` and flashed only by the repo procedure, with the chip and
    MAC checked. Never force-flash.
  - Never publish firmware (`make upload-circle`) without the owner.
- A device without `swarmBuddy` must receive byte-identical frames to today (spec, acceptance 5).
- Device UI text is English, exactly:
  - "No Buddy here yet"
  - "Add one in the Harness app."
  - "Your Buddy replied"
  - "Sending to your Buddy"
- Colours:
  - lilac `#c49bff`: the ring at 32 % on the glass edge (r 230, 3 px), the active lower dot, and the badge;
  - inactive dot `#55565f`; active upper dot `#eaeaf0`;
  - dots at x 442, y 218 and 248; radius 6 when active, 4.5 when not;
  - badge at (449, 241), r 5, with a 2 px black stroke.
- The avatar algorithm is Desktop's `superTabAgentPattern`, unchanged. Colour is HSL(hue, 42 %, 72 %); disc at 16 %
  alpha, radius 46, centred at (233, 158). Test vectors:
  - `"diego's Buddy"`: half 25513, hue 13, `#d6a79a`;
  - `"ken's Buddy"`: half 30735, hue 327, `#d69abb`.

## Review Focus

1. **Desktop opens the Buddy chat while the dial is on PM, then the person swipes down.** The newest action wins: the
   swipe sets `pm` and the face goes to the Lead conversation, even though the Desktop focus still names the Buddy
   chat. The desktop's next focus change clears the side. Test in Task 2.
2. **A Buddy removed while its screen is open.** Its chat is still in the state, but no agent. Expected: the empty
   state, no crash, and voice not offered (there is no recipient). Test in Task 2 (`buddy.live` and the absent block)
   and Task 6.
3. **Buddies turned off while on the Buddy side.** Expected: `buddies` is absent and the dial snaps to the PM face
   with no dots. Test in Task 6.
4. **A `supertab` frame with 12 Leads, every name at 48 bytes, and a Buddy on each.** Expected: it stays under 8192 bytes.
   Test in Task 3.
5. **Voice on the Buddy side when the backend refuses** (`BUDDIES_OFF`, `BUDDY_FORBIDDEN`). Expected: `voice.error` with
   the backend's message, and `sendTurn` is never called. Test in Task 4.

---

### Task 1: The avatar pattern in TypeScript, pinned to Desktop

**Files:**
- Create: `cli/src/superTabs/buddyAvatar.ts`
- Test: `cli/src/superTabs/buddyAvatar.spec.ts`
- Modify: `desktop/test/super_tab_avatar_test.dart`, to add the two vectors

**Interfaces:**
- Produces: `buddyAvatar(name: string): { cells: number; color: string }`. `cells` holds the 15 half bits (bit `i` =
  `half[i]`); `color` is `#rrggbb` lower-case.

- [ ] **Step 1: Write the failing tests**
```ts
it('draws Desktop\'s pattern and dark tone for a Buddy name', () => {
  expect(buddyAvatar("diego's Buddy")).toEqual({ cells: 25513, color: '#d6a79a' })
  expect(buddyAvatar("  KEN's Buddy ")).toEqual({ cells: 30735, color: '#d69abb' })
})
it('never draws an empty pattern', () => { /* find or construct a name whose low 15 bits are 0; expect bit 7 set */ })
```
In Dart, `superTabAgentPattern("diego's Buddy")` has hue 13, and its first 15 `cells` read as half bits give 25513.
Check the same for `"ken's Buddy"`.
- [ ] **Step 2:** `cd cli && npx vitest run src/superTabs/buddyAvatar.spec.ts` should FAIL (module not found).
- [ ] **Step 3: Implement.** FNV-1a over UTF-16 code units, using `Math.imul` and `>>> 0`. The HSL to RGB rounding must
  match Flutter's `HSLColor.toColor()`, so check against the Dart test. If the Dart vectors disagree, the Dart output is
  the truth: fix the TS and update both specs.
- [ ] **Step 4:** run both tests; both PASS: `npx vitest run src/superTabs/buddyAvatar.spec.ts`, then `cd desktop && flutter test test/super_tab_avatar_test.dart`.
- [ ] **Step 5:** Commit: `feat(swarm): the Buddy avatar pattern for the dial, pinned to Desktop's`.

### Task 2: Cards: the side, the Buddy face, the Buddy block, the quiet notice

**Files:**
- Modify: `cli/src/core/api.ts`
  - `ChatKind` becomes `'lead' | 'pm' | 'group' | 'buddy'`;
  - new `SwarmBuddy`;
  - `SwarmLead.buddy?` and `SwarmLead.buddies?`;
  - `LeadNotice.chat` gains `'buddy'`;
  - new `CardSide = 'pm' | 'buddy'`.
- Modify: `cli/src/superTabs/cards.ts`: `faceOf`, `leadsOf`, `target`, `watchNotices`, `want`, and a new `side()`.
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Consumes: `buddyAvatar` (Task 1).
- Produces:
  - `export interface SwarmBuddy { chatId: string; name: string; engine: string; cells: number; color: string; live: boolean }`
  - `SwarmLead.buddies?: true` (present only while the Swarm's `buddies` is true).
  - `SwarmLead.buddy?: SwarmBuddy` (present only when the reader has a Buddy agent in the project).
  - `cards.side(tabId: string, side: CardSide): void`. It rebuilds the cards at once (as a focus change does) and
    pushes the open recap.
  - `faceOf(conversations, projectId, lead, focus?, side?, buddyChat?)`, returning kind `'buddy'` when
    `side === 'buddy'` and a Buddy chat exists.

- [ ] **Step 1: Write the failing tests** in `cards.spec.ts`, reusing its `roster`, `agent` and `conv` helpers.
  Use a Buddy chat `conv('buddy-p1', null, { projectId: 'web', kind: 'buddy', agentIds: ['y1'], buddyOwnerId: 'p1' })`
  and a Buddy agent `agent('y1', { buddyOf: { personId: 'p1', generation: 'g1' }, name: "diego's Buddy", configuration: { engine: 'codex' } })`.
  The tests are:
  - `'gives each Lead a buddy block for the reader\'s own Buddy, with Desktop\'s avatar'`:
    `lead.buddy` equals `{ chatId: 'buddy-p1', name: "diego's Buddy", engine: 'codex', cells: buddyAvatar("diego's Buddy").cells, color: …, live: true }`.
  - `'marks buddies only while the Swarm has them on'`: with `state.buddies` true, `lead.buddies === true`; when it is
    absent, so are `buddies` and `buddy`.
  - `'shows no buddy block for a Buddy chat with no Buddy agent'`: the chat is present but no agent, so `buddy` is
    undefined.
  - `'puts the Buddy chat on the face on the buddy side, and its recap is the Buddy\'s last message'`: call
    `cards.side('t1', 'buddy')`. Then `lead.chat` equals `{ kind: 'buddy', id: 'buddy-p1', name: "diego's Buddy", working: false }`,
    and `recap('t1', lead, true)` returns the Buddy's newest message, not the owner's.
  - `'keeps the Lead face on the buddy side when the project has no Buddy chat'`.
  - `'a later desktop focus clears the dial\'s side'`: `side('t1','buddy')`, then `want(true, [], { tabId: 't1', conversationId: 'lead-web' })`,
    so `chat.kind === 'lead'`. Also: with focus on `buddy-p1`, `side('t1','pm')` gives `chat.kind === 'lead'`. Review
    Focus 1.
  - `'never puts a read-only Chat with PM on the face while Buddies are on'`: with focus on a PM chat (`audience` set)
    and `state.buddies` true, `chat.kind === 'lead'`.
  - `'raises a buddy notice for the Buddy\'s new message, never for the owner\'s'`: the notice is
    `{ chat: 'buddy', chatId: 'buddy-p1', … }`, and an owner's message raises none.
- [ ] **Step 2:** `cd cli && npx vitest run src/superTabs/cards.spec.ts` FAILS on the new cases only.
- [ ] **Step 3: Implement.**
  - **Helpers:**
    - `isBuddyChat(c)`: `c.kind === 'buddy'`.
    - The reader's Buddy chat in a project: `isBuddyChat(c) && inProject(c, projectId) && c.buddyOwnerId === me`.
    - The Buddy agent: the first agent whose id is in that chat's `agentIds` and that has `buddyOf`.
  - **`want()`:** when `refocused`, clear `this.sides` (a `Map<tabId, CardSide>`).
  - **`voicesOf`:** for `'buddy'`, the chat's `agentIds`.
  - **`chat.name`** for `'buddy'`: the Buddy agent's `displayName ?? name`, cut to `NAME_BYTES`.
  - **`watchNotices`:** add the reader's Buddy chat of each project as `chat: 'buddy'`, with voices = its Buddy
    agent ids.
- [ ] **Step 4:** run the same file; all PASS. Also run `npx vitest run src/superTabs` for the neighbours.
- [ ] **Step 5:** Commit: `feat(swarm): cards know the dial's side and the reader's Buddy`.

### Task 3: Cable and services: `swarmBuddy`, `supertab.side`, the frames

**Files:**
- Modify: `cli/src/cable/cableSession.ts`:
  - hello parsing next to `swarmChat` (around :1271);
  - the `named` caps list (:702);
  - `chatLead` (:177);
  - `noticeFrame` (:184);
  - the frame switch (:1377);
  - `onSuperTab`.
- Modify: `cli/src/cable/cableHost.ts`: the new wiring `swarmCardSide?: (tabId: string, side: 'pm' | 'buddy') => void`.
- Modify: `cli/src/services/devices.ts`: wiring → `askCards({ action: 'cardSide', tabId, side })`.
- Modify: `cli/src/core/devicesLink.ts`: pass `side` for `cardSide`.
- Modify: `cli/src/superTabs/inCore/cards.ts`: route `cardSide`.
- Modify: `cli/src/superTabs/service.ts`: accept `cardSide` when `cardId(tabId)` and `side ∈ {pm, buddy}`, then call
  `cards().side()`.
- Check `cli/src/core/main.ts` `superTabRequest`: its allowlist must let `cardSide` through, if it filters actions.
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/core/devicesLink.spec.ts`, `cli/src/superTabs/service.spec.ts`
  (or the files that test those paths today).

**Interfaces:**
- Consumes: `SwarmLead.buddy`, `buddies`, `cards.side` (Task 2).
- Produces:
  - **Device → daemon:** `{"t":"supertab.side","tab":"<id>","side":"pm"|"buddy"}`. It is ignored unless the device
    said `swarmBuddy: 'v1'` and `tab` matches `CARD_ID`.
  - **The Lead entry** for a `swarmBuddy` device: `chatLead` output plus `buddies: true` and
    `buddy: { chatId, name, engine, cells, color, live }`. `chat` may be `'buddy'`.
  - **A `swarmChat` device without `swarmBuddy`:** a `'buddy'` face chat is sent as today's `'group'` (so older
    firmware keeps working), and no `buddy` or `buddies` fields are sent.
  - **`supertab.notice`** with `chat: 'buddy'` goes only to `swarmBuddy` devices.

- [ ] **Step 1: Write the failing tests:**
  - `'a swarmBuddy dial gets each Lead\'s buddy block and buddies flag'`;
  - `'a swarmChat dial without swarmBuddy gets today\'s frame, a Buddy face reading as a group'`: byte-compare against
    today's output for the same input;
  - `'supertab.side reaches the cards as cardSide, and only from a swarmBuddy dial'`;
  - `'a buddy notice reaches only a swarmBuddy dial'`;
  - `'the supertab frame with 12 Leads, 48-byte names and a Buddy each stays under 8192 bytes'`: assert
    `Buffer.byteLength(JSON.stringify(frame)) < 8192` (Review Focus 4);
  - the core link and service forward `cardSide` with `side`, and refuse a bad `side`.
- [ ] **Step 2:** `npx vitest run src/cable/cableSession.spec.ts src/core/devicesLink.spec.ts src/superTabs/service.spec.ts` FAILS on the new cases.
- [ ] **Step 3:** Implement as the Interfaces block says.
- [ ] **Step 4:** run the same files and PASS. Then `npm run test:core` must report 100 % (devicesLink.ts is a core
  file), and `npx tsc --noEmit -p .` must be clean.
- [ ] **Step 5:** Commit: `feat(cable): swarmBuddy dials get the Buddy block and send supertab.side`.

### Task 4: A refused Swarm post is never typed into a terminal

**Files:**
- Modify: `cli/src/superTabs/cards.ts` `say()`. It returns
  `Promise<{ said: true } | { said: false; refused?: { code: string; message: string } }>`: a `SuperTabHostError` with
  status 400–499 is `refused`, and any other failure rethrows as today.
- Modify: `cli/src/superTabs/service.ts`: `cardSay` returns `{ ok: true, said, ...(refused ? { refused } : {}) }`.
- Modify: `cli/src/services/devices.ts`, `cli/src/cable/cableHost.ts`: `swarmSay` resolves to
  `{ said: boolean; refused?: { code: string; message: string } }`.
- Modify: `cli/src/cable/cableSession.ts`, the voice path around :2294:
  - when `refused`, reply `{ t: 'voice.error', message: refused.message }` and return;
  - on a `buddy` face, never fall back to `sendTurn`; reply `voice.error` "Could not reach your Buddy. Try again."
    instead.
- Test: `cards.spec.ts`, `cableSession.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `'say reports a 403 as refused with the backend\'s message'`, using a stub backend that answers 403
    `PM_CHAT_READ_ONLY`;
  - `'a refused voice post shows voice.error and types nothing'`: assert the host's `sendTurn` spy has 0 calls (fails
    today: it is called once);
  - `'on the Buddy face an unreachable post shows voice.error and types nothing'`;
  - `'on the PM face an unreachable post still falls back to the turn'` (today's behaviour, kept).
- [ ] **Step 2:** run the two spec files; the new cases FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, plus `npm run test:core` and `npx tsc --noEmit -p .`.
- [ ] **Step 5:** Commit: `fix(cable): a Swarm post the backend refuses is shown on the dial, never typed into a terminal`.

### Task 5: Firmware model and wire

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/supertab.h` and `supertab.c`:
  - `ht_chat_kind_t` gains `HT_CHAT_BUDDY`;
  - `ht_lead_t` gains `bool buddies;` and
    `struct { bool has, live; char chat_id[ID_MAX], name[HT_SUPERTAB_NAME], engine[16]; uint16_t cells; uint16_t color565; } buddy;`;
  - `ht_lead_in_t` gains the parsed inputs.
- Modify: `main/cable_client.c`:
  - hello adds `msg_string(&root, "swarmBuddy", "v1")` after `swarmChat` (:326);
  - `handle_supertab` parses `buddies` and the `buddy` object, with `color` `#rrggbb` → RGB565 and `cells` 0..32767;
  - `handle_supertab_notice` maps `"buddy"` → `HT_CHAT_BUDDY`;
  - new `cable_client_supertab_side(const char *tab, bool buddy)` sends `supertab.side`.
- Modify: `main/cable_client.h`.
- Test: `test/test_cable_supertab.py`, `test/test_supertab.c`.

- [ ] **Step 1: Write the failing tests:**
  - **parse:** a lead with `buddies:true` and `buddy:{chatId:"b1",name:"diego's Buddy",engine:"codex",cells:25513,color:"#d6a79a",live:true}`
    yields `has`, `live`, `cells == 25513`, and `color565` equal to RGB565 of (0xd6,0xa7,0x9a);
  - **parse:** a `chat:"buddy"` lead reads `HT_CHAT_BUDDY`;
  - **parse:** a bad `color` or `cells > 32767` drops the block (`has == false`);
  - **frame:** `cable_client_supertab_side("t1", true)` emits `{"t":"supertab.side","tab":"t1","side":"buddy"}`, and an
    over-long tab emits nothing;
  - **hello:** carries `swarmBuddy: v1`;
  - **notice:** `chat:"buddy"` reaches the UI as `HT_CHAT_BUDDY`.
- [ ] **Step 2:** `make device-test`: the new cases FAIL.
- [ ] **Step 3:** Implement. Keep the `supertab` card in `EXT_RAM_BSS_ATTR`, and check that `sizeof(ht_supertab_t)` still
  fits the static.
- [ ] **Step 4:** `make device-test` is all green, and `idf.py build` passes.
- [ ] **Step 5:** Commit: `feat(round): the dial reads each project's Buddy and can name its side`.

### Task 6: Firmware UI: side, gestures, face, voice

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`:
  - `sw` gains `bool buddy_side[HT_SUPERTABS_MAX]`, keyed like `sw.focus`, or a per-tab entry next to it;
  - the vertical-swipe branch (around :3516);
  - `render_swarm_face` (:1293);
  - the voice view render;
  - `swarm_show` and `swarm_enter`: re-send the side on entering a Swarm.
- Modify: `main/ui/habitat/focus.c` / `terminal.c` only as needed:
  - an avatar draw helper `ht_buddy_avatar(scene, cx, cy, r, cells, color565)`, drawn as rounded 5×5 cells over a disc
    at 16 % alpha;
  - the lilac ring;
  - the two dots and the badge.
- Test: `test/test_touch_ui.py` (screens and gestures).

**Interfaces:**
- Consumes: `ht_lead_t.buddies` and `.buddy`, `cable_client_supertab_side` (Task 5).

- [ ] **Step 1: Write the failing tests** in `test_touch_ui.py`:
  - **Gestures:**
    - With `buddies` and a Buddy, swipe up on the face sends `supertab.side buddy`, and the scene has the lilac ring
      and the avatar at (233, 158).
    - Swipe down on the Buddy face sends `supertab.side pm` and the PM face returns.
    - On the PM face with an unread Lead notice, swipe down still opens INBOX.
    - Swipe up on the Buddy face does nothing.
  - **Side and project:**
    - The side is kept across a horizontal swipe to the next project.
    - A project without a Buddy shows "No Buddy here yet" / "Add one in the Harness app.", and a tap there starts no
      voice.
  - **Buddies off:** with `buddies` absent, there are no dots, swipe up is inert, and the face is pixel-identical to
    today's golden. When `buddies` turns off while on the Buddy side, the dial snaps to PM (Review Focus 3).
  - **Quiet notice:** a buddy notice on the PM side draws the badge at (449, 241) and "Your Buddy replied" on the lower
    arc, makes no `audio_notify_done` call and adds no inbox entry. Opening the Buddy side reads it.
  - **Voice:** a tap on the Buddy face starts voice with the Buddy engine's pet: Codex's `listening` frames for a Codex
    Buddy, Claude's `listen` for Claude. Sending shows "Sending to your Buddy" and keeps the lilac ring.
  - **Run counts:** constant per screen, as the Focus tests require.
- [ ] **Step 2:** `make device-test`: the new cases FAIL.
- [ ] **Step 3:** Implement using the numbers in Global Constraints. The Buddy-side recap uses today's card geometry.
  Voice uses today's screens, with the engine taken from `l->buddy.engine` on the Buddy side.
- [ ] **Step 4:** `make device-test` is green, and `idf.py -DPROJECT_VER=0.0.99 build` passes. Rasterise the PM, Buddy,
  empty, badge, listening and sending screens, and compare them with the mockup.
- [ ] **Step 5:** Commit: `feat(round): swipe up for your Buddy, down for the PM`.

### Task 7: Docs and the on-device check

**Files:**
- Modify: `docs/swarms.md` § Buddies: one paragraph on the round dial.
- Modify: `devices/harness-device/firmware/README.md`, only if it lists gestures.

- [ ] **Step 1:** Write the docs paragraph: swipe up or down on the dial, the Buddy screen, voice, and the quiet notice.
- [ ] **Step 2:** Flash a dev build (0.0.99) on a dev round dial by the repo procedure, checking the chip and the MAC.
  Go through acceptance 1–8 in the spec with a Swarm that has Buddies on. Record the results in the PR.
- [ ] **Step 3:** Commit: `docs: the round dial's PM and Buddy screens`.

## Pre-flight (shared interfaces)

| Producer → consumer | Contract | Check |
|---|---|---|
| Task 1 → 2 | `buddyAvatar(name) → {cells, color}` | Task 2 imports it, nothing else |
| Task 2 → 3 | `SwarmLead.buddy` / `buddies`, `cards.side(tab, side)`, `ChatKind 'buddy'`, `LeadNotice.chat 'buddy'` | Task 3 maps them to wire fields one to one |
| Task 3 → 5 | wire: `buddies`, `buddy{chatId,name,engine,cells,color,live}`, `chat:'buddy'`, `supertab.side{tab,side}`, `swarmBuddy:'v1'` | Task 5 parses exactly these names |
| Task 4 ↔ 3 | both edit `cableSession.ts` and `devices.ts` | run Task 4 after Task 3 to avoid conflicts |
| Task 5 → 6 | `ht_lead_t.buddy`, `HT_CHAT_BUDDY`, `cable_client_supertab_side` | Task 6 uses only these |

**Order:**
- Tasks 1 → 2 → 3 → 4 go in one CLI PR.
- Tasks 5 → 6 → 7 go in one firmware PR, opened after the CLI PR merges.
- The firmware without the daemon change is harmless: an old daemon ignores `supertab.side` and never sends `buddies`.

## Execution handoff

The plan is complete. The recommendation is **subagent-driven**: there are two PRs in two languages, and the frames
are a cross-process contract, so a review after each task is worth its cost.
