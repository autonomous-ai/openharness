# WebSocket optimization roadmap

Date: 2026-10-28. Code read at `origin/main` (b766b4166). Measurements from prod backend logs
(45 min, 3 pods, v1.3.58_backend) and Atlas.

**Scope decided (Ken, 2026-10-28): phases 0–3 only.** Phases 4–5 (the multiplexed account socket) are
deferred because of their risk; they stay here for direction and are revisited after 0–3 ship and are
measured.

## Why

Clients and daemons open many short-lived sockets to the backend, and the Swarm keeps the backend busy
with HTTP polls that have no push. The question was whether to fold every data lane into one
WebSocket. The answer is yes, eventually, but most of the cost today comes from churn bugs and
polling, which are cheaper to fix first. Phases are ordered by priority: each one is worth doing even
if the later ones never ship.

## What we measured (prod, 45 min)

- `/api/web-ws`: 8,760 connects from 74 users, about 195 per minute. 81% of sockets close without ever
  sending `machine_select`. Bursts every 7–12 s, mostly 1–3 sockets, up to 8.
- One user: 44 connects/min. Every ~7 s it selects 4 machines plus one deleted on 2026-09-03, which is
  rejected with `NOT_YOUR_MACHINE`, then every socket closes.
- `/api/adapter-ws`: 227 reconnects (5/min); 5 machines reconnected more than 5 times.
- Hub heartbeat timeouts: 152 tracked, 148 web.
- Backend CPU after v1.3.58: about 1.5 cores, steady. Most of the remaining busy time is polling:
  host `/changes` 14.6%, Swarm `/changes` 10.9%, deliveries about 19%, messages 7.4%.
- What the logs cannot tell today: which client opened a socket (daemon relay, desktop, web, mobile,
  group sync), close codes, or how long a socket lived.

## What each connect costs today

- **Every web-ws connect, before any select:**
  - Sign-in check: in-process cache, then Redis, then SSO; plus 2 Mongo `user` reads.
  - Mongo `machine.findMany`, a presence MGET, and a `machine_nodes` read for each offline machine.
  - Mongo `deviceBinding.findMany`, then a device re-read every 30 s.
  - Six per-user Redis subscriptions, plus one per owned machine.
  - References: `backend/src/lib/webWs.ts:199-324`, `ssoAuth.ts:283-317`.
- **Every `machine_select`:**
  - Machine and share lookups, plus two presence reads.
  - A `machine_nodes` read even when the machine is online (`webWs.ts:341-344`).
  - Hub attach: a Redis SUBSCRIBE, HSET/HEXPIRE and a `__clients_dirty` publish (`hub.ts:122-165`).
- **A failed sign-in** still completes the upgrade and then closes with 4401/4403/1013
  (`webWs.ts:133-146`). Each failure therefore counts as a connect that lives under 1 s.

## Sockets in play

- **Daemon** (`cli/src/lib/remoteRelay.ts`, `gateway/*`):
  - 1 `adapter-ws`.
  - 1 `device-ws`, only while a device is plugged in. It already multiplexes machines.
  - 1 web-ws per remote machine for the window, plus up to 4 background web-ws per machine, each a
    separate E2EE session.
  - 1 `observer-ws` per watched share. These are not pooled, and each acquire re-reads
    `/api/harness-shares`.
  - 1 `agent-messages-ws` per shared tab.
- **Desktop native:** one local-ws per machine to its daemon. The daemon relays every remote machine.
- **Desktop web build and mobile:** one web-ws per machine, dialled directly
  (`desktop/lib/ws/ws_conn.dart:388`, `mobile/lib/ws/ws_conn.dart:363`). Group sync, password link and
  code link open one-shot web-ws sockets.
- **The backend binds one machine per web-ws** (`webWs.ts:405-412`). `device-ws` is the existing
  exception: N hub clients on one socket, routed by a `machineId` tag (`deviceWs.ts:400-431`).

## Phase 0 — Attribute every socket (highest priority, small)

Without this, phases 1–3 cannot be verified.

1. Every client declares itself on connect.
   - Daemon relay: `client=relay&v=<cli>`.
   - Group sync / password link / code link: `client=group-sync|link`.
   - Desktop native through the daemon: as the relay.
   - Web and mobile already send `client=web|mobile`.
   - The backend logs `surface`, `version`, `pod` and `connId` on connect.
2. On disconnect, for web-ws, adapter-ws, observer-ws and agent-messages-ws, log close code, reason,
   lifetime, whether a select happened, and the select outcome (accepted / error code).
3. Counters per endpoint and pod: open sockets, connects/min, and sockets that lived under 2 s.
4. Pre-upgrade refusals are counted separately from real connects.

Done when ≥95% of web-ws connects can be attributed to a client kind and version, and the 81%
"never selected" sockets are explained.

## Phase 1 — Stop the churn (high priority)

Bugs that open sockets for nothing. Each fix is small and independent.

1. **Deleted and stale machines stay selected forever.**
   - Daemon: on `NOT_YOUR_MACHINE` for a deleted machine, drop its pin
     (`remoteRelay.ts:317, 560-566`), and stop `groupSyncer.applyAll` from re-pinning it
     (`groupSyncer.ts:394`).
   - Desktop: close the pooled socket when a machine leaves the list (`app_state.dart:9595-9605`;
     mobile already does, :2808). Do not build sockets for unknown machine IDs (`workspace.dart:286,333`,
     `machines.dart:660`).
   - Mobile: the 6 s select watchdog must stop on `NOT_YOUR_MACHINE` instead of redialling
     (`mobile/lib/ws/ws_conn.dart:667-701`, `app_state.dart:10336`).
2. **Failed selects redial immediately.**
   - Give the daemon's window pool a dial cooldown and honour the backend's `retryAfterMs`
     (`remoteRelay.ts:50-54, 298, 563`).
   - Map `MACHINE_OFFLINE` to the same local close code (1013) on both paths
     (`localWsServer.ts:499-500`).
   - Desktop must not redial forever on a 1011 from a machine that is gone.
3. **Expired sign-in loops.** Clients back off on 4401 after one refresh attempt. Consider refusing a
   bad token with HTTP 401 before the upgrade, once clients handle it.
4. **Make an unselected socket cheap.** Start the per-user watchers only when the client asks
   (`machines_watch` / `devices_watch`):
   - machine list
   - presence reads
   - device bindings and the 30 s device re-read
   - per-user subscriptions

   Daemon relays and one-shot sockets never need them. Also drop the unconditional `machine_nodes`
   read in the select ack.
5. **Pool share watching.** Pool and linger `observer-ws` in the daemon like web-ws, and use the cached
   shares list instead of `GET /api/harness-shares` on every acquire (`gateway/start.ts:215`,
   `sharing/relay.ts:36`).
6. **Background shelf overflow.** Raise or rethink `ISOLATED_IDLE_MAX`: a 5th concurrent background
   reader closes its socket on detach (`remoteRelay.ts:351`).

Done when:
- web-ws connects drop from ~195/min to under 40/min;
- the median web-ws lifetime is over 1 minute;
- no selects of deleted machines;
- adapter reconnects are explained by close codes.

## Phase 2 — Push instead of poll for the Swarm (high priority, largest CPU win)

1. **Host feed.** Today the host feed polls about every second (`cli/src/superTabs/host.ts:324`,
   `hostFeed.ts:54-60`), even with no pools.
   - Push `swarm_host_changed{tabId, lastChangedAt}` down `adapter-ws`, following
     `backend/src/lib/swarmDeliveryPushes.ts`, so the host reads only when told.
   - Keep a 60 s safety net.
   - Do not run the loop at all on a machine with no Swarm pools.
2. **Client Swarm reads.** These are:
   - Swarm state: 3 s on desktop, 15 s on web.
   - Discovery: 15 s.
   - Invites: 15 s.
   - Native pane renew: 20 s.

   Push `swarm_changed{tabId, lastChangedAt, parts}` over the socket the client already has. Forward
   the existing `swarm-stamp` Redis broadcast (`bus.ts:325-344`) instead of adding a new source.
3. **Cheap "nothing changed" reads.** `/changes`, deliveries and messages answer an unchanged cursor
   before loading any state (304 or empty).
4. **Retire timers that already have a push**, keeping one long safety net each:
   - CLI: Agent Messages 15 s, machine list 60 s.
   - Desktop: experimental settings 30 s.
   - Offline machine with a pending agent: full `/api/machines` every 5 s.
5. **Deliver account pushes once.** A daemon with N relay sockets hears each account push N+1 times
   (`webAccountPushes.ts:15`). Send account pushes only on adapter-ws to daemons, and only once per
   app on web/mobile.

Done when:
- polling routes are under 20% of backend busy time (from ~60%);
- host `/changes` requests drop at least 10×;
- Mongo query/s and CPU fall with the same user activity.

## Phase 3 — Fewer sockets per daemon within today's protocol (medium priority)

1. **Background reads share one session per machine.** Demultiplex by request ID instead of keeping up
   to 4 isolated E2EE sessions per machine (`remoteRelay.ts:330-356`). The isolation exists only so
   pollers do not see each other's frames, and request IDs give the same guarantee.
2. **Visibility gating everywhere.**
   - Harness Monitor (3–15 s), the Swarm machines panel (15 s), usage (60 s) and agent sync (60 s)
     stop when the window or tab is hidden or closed.
   - On return, read once, then go live again.
3. **Observer fan-out.** Each observer subscribes to the machine's whole `up:{machineId}` stream and
   filters by `targetConnId` (`observerWs.ts:84-92`). Publish to a per-connection channel instead, and
   count observers in `__clients`.

Done when an idle daemon with K remote machines keeps at most K + 1 upstream sockets, and a hidden
window makes no periodic backend requests.

## Phase 4 — One multiplexed account socket (lower priority, largest change)

One socket per client for every data lane.

- **Where it runs:** the daemon first, because it carries Desktop native. Then web and mobile.
- **Base it on `device-ws`,** which already runs N machines on one socket with one E2EE session per
  machine (`deviceWs.ts:400-431`, `cli/src/gateway/lane.ts`).
- **Lanes:**
  - control and push (account events, Swarm changes)
  - one lane per machine session (`machineId` plus a session ID, so background readers can still be
    separate when needed)
  - one lane per share (observer)
  - one lane per shared tab (Agent Messages)
- **E2EE does not change.** Each lane keeps its own end-to-end session keyed by lane connId; the
  backend still only forwards sealed frames. `groupSeen` stays per machine and is never shared by two
  live sessions.
- **What must change on the backend:**
  - **Lane errors, not socket closes.** Today 1009 (frame too big), 1013 (outbound queue over 8 MiB),
    4403 (sharing ended) and observer 1012 each kill the whole socket. They become `lane_closed{lane,
    code}`.
  - **No head-of-line blocking.** Today one ordered inbox means a slow select or wake blocks every
    frame (`webWs.ts:570`). Each lane gets its own inbox.
  - **Flow control and priority:** control > interactive terminal > bulk history. Output that a slow
    lane cannot take is dropped or paused per lane.
  - **Chunking** for frames over the per-socket limit (adapter frames reach 16 MiB, history pages
    5.4 MiB).
  - **Every frame carries its lane ID,** including binary terminal frames.
  - **Resume on reconnect:** the client re-opens its lanes in one frame, and the backend re-attaches
    them without a select per machine.
- **Terminals already on p2p stay on p2p.** Only signalling uses the control lane.
- **Rollout:** dual stack behind a version check. Keep web-ws, observer-ws and agent-messages-ws until
  the old clients age out (see Phase 0 versions).

Done when each running app or daemon holds one account socket (plus adapter-ws for its own machine),
and connects/min tracks app starts and network changes, not activity.

## Phase 5 — Fold the machine side in (lowest priority)

Consider carrying `adapter-ws` and `device-ws` as lanes of the same account socket, so a daemon holds
exactly one backend socket. This is a small win after Phase 4. The adapter's billing, ownership
claims, supersede (4000) and team-machine (4009) rules need their own lane-level equivalents.

## Not in scope

- Moving terminal bytes off p2p.
- Changing the E2EE design.
- The manager socket (`/api/manager-ws`, server to server).

## Order of work and rough size

| Phase | Priority | Size | Risk |
|---|---|---|---|
| 0 Attribute | Highest | 1–2 days | None |
| 1 Churn bugs | High | 3–5 days, independent PRs | Low |
| 2 Swarm push | High | 1–2 weeks | Medium: missed pushes need the safety net |
| 3 Fewer sockets | Medium | 1 week | Low–medium |
| 4 Account socket | Lower | 3–5 weeks | High: protocol, both sides, rollout |
| 5 Machine side | Lowest | 1–2 weeks after 4 | Medium |
