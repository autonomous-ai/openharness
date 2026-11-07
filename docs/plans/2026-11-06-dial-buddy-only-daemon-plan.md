# Round dial: Buddy only on the Lead face, no PM side, no threads — daemon plan

**Goal:** The daemon stops giving a round dial the PM side and the thread face: a swarmBuddy dial's Swarm face shows and talks to the person's Buddy only, and nothing about threads reaches any dial. Old dials keep connecting.

**Architecture:** The dial's `supertab` frame carries both a Lead chat (`chat`) and a Buddy (`buddies`, `sideChat`), a frame-level `side`, and thread fields (`thread`, `threadTitle`, `threadReplies`) for a `swarmThread` dial. `cards.ts` (`CardsHost`) keeps the per-Swarm `sides`, the dial's own `threads`, `titles`, `left` and the window's `threadRoot` focus; `cableSession.ts` reads `supertab.side` and `supertab.thread.leave` and announces nothing for threads. Buddy-only means the Buddy chat is the face for a swarmBuddy dial and nothing in the frame says "side" or "thread"; an old dial (no swarmBuddy) keeps the Lead face it has.

**Tech Stack:** TypeScript, vitest (cli/src/cable, cli/src/superTabs, cli/src/core, cli/src/services).

**Spec:** task #3908 (Diego, the final Board spec: people talk only to their Buddies; no Threads feature).

## Scope: this plan is the daemon half only
The firmware half (devices/harness-device/firmware/main: ui_habitat.c, cable_client.c, supertab.c/h and their host tests) needs ESP-IDF for `idf.py build`; ui_habitat.c is not compiled by `test/run.sh`. It is its own task for an Engineer on a machine with ESP-IDF. Shipping the daemon first is safe: an old dial that still sends `swarmThread` in its hello or `supertab.side`/`supertab.thread.leave` frames gets no thread data and its frames are ignored with no error.

## Global Constraints
- Old dials still connect; side and thread frames from them are ignored without errors or log noise; a hello with `swarmThread` is accepted and the capability not granted.
- Holding the recap still opens Personal | Team; tapping the name still opens the project list.
- Never publish firmware or touch the device update manifest; flash no device.
- `npm run test:core` stays at 100% for cli/src/core and cli/src/services.

## Review Focus
- No frame field a shipped firmware reads as mandatory is removed in a way that makes it drop the frame (cable_client.c / supertab.c parse side and thread fields as optional).
- The window's thread pane is never closed or opened by a dial again; Desktop moved its threads in #3365.

## Task 1: threads leave the dial's path (cards.ts, cableSession.ts, cableHost.ts, devicesLink.ts, core/api.ts, services/devices.ts, superTabs/service.ts)
**Files:** those, and their specs.
- [ ] Failing test: a dial that announces `swarmThread: 'v1'` is sent no `thread`, `threadTitle` or `threadReplies` fields on a Lead, a recap or a notice, and `supertab.thread.leave` from it is ignored without an error or a host call.
- [ ] Remove the capability, `threadLeave`, `swarmThreadLeave`, `superTabThread`, the dial's thread bookkeeping in cards.ts (`threads`, `titles`, `left`, `threadRoot` focus, thread-aware recap keys, `sayOptions`), and the thread fields of `SwarmChat`, `LeadRecap`, `LeadNotice`.

## Task 2: the PM side leaves the dial's path (cards.ts, cableSession.ts)
- [ ] Failing test: a swarmBuddy dial's frame has no `side`, each Lead is its Buddy face (`buddyLead`), and `supertab.side` (kept or not) is ignored with no error and no `swarmCardSide`/`followSide` call.
- [ ] Remove `sides`, `side()`, `sideOf`, `swarmCardSide`, `followSide`, the PM `sideChat` for Buddy dials, and the frame's `side`.
- [ ] An old dial's test: a dial without swarmBuddy gets the frame it got before.

## Task 3: gates
- [ ] `npx tsc --noEmit -p .`, `npx vitest run src/cable src/superTabs src/core src/services`, `npm run test:core` (100%), `npm run test:portability` if touched.
