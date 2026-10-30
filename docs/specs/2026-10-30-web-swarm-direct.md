# Web Swarm chats straight from the backend

Status: approved by the Lead and built in #2306. Requested by Huy (10-30).

## Problem

On the web (the Desktop app built for the browser, also used on phones), every Swarm call goes through one of the
person's connected machines: `superTabs.transport` in `desktop/lib/state/app_state.dart` sends `super_tabs` /
`action: backend` to the machine `sharedTabsTarget` picks, and that machine's daemon calls `/api/super-tabs/...`
with its own sign-in (`cli/src/superTabs/service.ts`, `ownerRequest`). With no machine of the person's online, only
Team-account machines, or a slow link, the web shows "Connect one of your machines to open Swarm" or the catch-all
"Could not refresh this conversation" (`controller.dart` `_readFailure`), even though the backend could answer the
browser directly.

Finding that changes the brief's premise: the phone app does **not** call Swarm JSON routes directly today. It relays
through a machine exactly like the web (`mobile/lib/state/app_state.dart` `swarmRequest` → `_swarmRequestVia`). Only
chat file uploads and avatars go direct with the person's own sign-in (`ApiClient.uploadSwarmAttachment`,
`uploadSwarmAvatar`), on both phone and web. This spec reuses that direct-upload token model for every Swarm JSON
call on the web. The phone app is out of scope and can follow the same way later.

## What changes

On the web only (`viewer != null`), `superTabs.transport` calls the backend directly through the app's existing
`ApiClient` (`viewer.auth`, `BearerAuthInterceptor`): the same method, path and body the relay sent, the backend's
`{success, data, error}` envelope read as `wire.ts backend()` reads it (data on success; `error.code`,
`error.message` and the HTTP status as a `SuperTabFailure`; 426 as `UPDATE_REQUIRED`). Every Swarm screen goes
through that one transport, so chats, the chat list, threads, mentions, decisions, invitations, read marks, reactions,
commands (posts, Buddy chat) all go direct without per-screen changes.

Native Desktop (macOS, Windows, Linux) is unchanged: it keeps calling its own local daemon.

### Calls that go direct on the web

Everything `SuperTabClient.transport` sends: `GET`/`POST /api/super-tabs/**` (list, parts, conversations,
messages, threads, mentions, decisions, invitations, leaderboard, costs, commands). Uploads and avatars already go
direct and stay as they are.

### Calls that still need a machine (they act on that machine, not on the Swarm's data)

`superTabMachineRequest` with `prepareContribution` (adding a machine or a Buddy machine), `prepareNative`
(terminal sharing), `wake`, `teamSetupCheck` / `teamSetupDecline` / `teamSetup`; `sharedTabs` (`agent_messages`,
tabs shared with other accounts) and `tabActivity` (`tab_activity`); terminals and files on disk. These stay on the
machine they name. When it cannot answer, the web says why instead of the catch-all:

| Situation | Text (Naming System wording) |
|---|---|
| The named machine is offline | "{machine} is offline. Open Harness on it, then try again." |
| It is a Harness Team machine | "{machine} runs Swarm agents for a Harness Team account, so it cannot do this for you. Use another of your machines." |
| No answer within the timeout | "{machine} is taking too long to answer. Its connection may be slow. Try again." |
| No machine of the person's online (sharedTabs, tab activity) | "None of your machines is online." (as today) |

A direct Swarm read that fails without a backend answer (no network, timeout) becomes
`SuperTabFailure('NETWORK', 'Could not reach Harness. Check your connection.')`, so `_readFailure` shows that
instead of "Could not refresh this conversation". The catch-all stays only for errors that are neither.

### Machine gating removed on the web

`_onConnectionStatus` calls `superTabs.serverAvailable()` when a machine first becomes able to serve Swarm reads
(`sharedTabsTarget != null`). On the web the backend always serves them, so the Swarm reads on sign-in and on the
browser coming back online, not on a machine connecting. The machine-connect trigger stays for native.

### Authentication, CORS, CSRF

- Routes: the transport signs only the Swarm routes the web's screens call (list, invitations, routing policy, create;
  per Swarm: parts, changes, commands, mentions, decisions, leaderboard, sharing, routing policy, groups, conversations'
  messages, catch-up and read marks, project GitHub and roles, route decisions, machine removal, join, terminal
  sharing). Host, start, GitHub token, delivery and terminal routes are refused before anything is sent.
- Token: the browser's own sign-in, which the web already sends on every other direct call (desk, machines, uploads):
  an Autonomous SSO access token, or a Harness `viewer` session after a QR sign-in. `registerAuthMiddleware` accepts
  both on every control route. Swarm routes treat the caller as the signed-in person; the only session-kind check in
  `backend/src/superTabs` is for `team` sessions (`store.ts`, `routes/superTabs.ts personOnly`), and a browser never
  holds one (team sessions are minted only for a machine's daemon, `lib/teamSession.ts`). So the browser has exactly
  the person's access, the same the relaying machine's `computer` session had. No daemon or Team-account credential
  is in the browser, before or after.
- CORS: which origins are let in is unchanged; only `Access-Control-Max-Age: 600` is added (Scale, below). The server
  already reflects the origin (`server.ts`, `lib/corsOptions.ts`); requests carry `Authorization: Bearer` from
  the app's own storage, which another origin cannot read. No route is added and none accepts weaker auth.
- CSRF: N/A because the control API authenticates only by the bearer header, never by cookie
  (`authMiddleware.ts bearerToken`); a cross-site form or link carries no credential.
- Backend change: none expected. Step 2 adds a backend route test that a `viewer` session reads a Swarm and posts a
  command exactly as a `computer` session does, a person outside the Swarm or Buddy chat is refused alike, and a
  `team` session is still refused. If that test shows a gap, the fix is in the route auth and reported here first.

### Caching and offline

Unchanged in kind. The web's saved Swarm views (`SuperTabSavedViews`, browser storage) are already claimed per
account, forgotten when another account signs in on that browser or the account leaves, and cleared by Settings ▸
Account ▸ Clear now. In-memory state is per account generation (`SuperTabClient.request` drops answers that land
after an account change; `superTabMachineRequest` the same by `_authRevision`). Offline: reads fail with the network
text above and retry on the existing poll; posts stay in the composer with their operation id, as now.

What else the web keeps of an account in browser storage, each keyed by account. A web sign-out (or another account
signing in) removes the leaving account's, and leaves any other account's (`super_tabs/account_keys.dart`). A write for an
account no longer signed in on that page is dropped, so a draft saved late cannot put one back; one another page wrote
before it reloaded is swept at the next sign-in or page start (`super_tab.signed_out`, at most 16 accounts).
- `super_tab.<account>.<swarm>`: each Swarm's unsent composer drafts per conversation, its selection and what is expanded;
- `super_tab.launch.<account>.<tab>.<conversation>`: an unsent New Harness or New Project draft;
- `super_tab.hidden.<account>`: the Swarms hidden on this browser;
- `super_tab.personal.<account>`: the Swarm last chosen in the switcher.

A 401 retry never goes out as another account (security review of 0993e291d): the bearer interceptor records which
sign-in each request went out under (`SignInRevision`, moving with every sign-in and sign-out, and in a browser with
another tab's too) and refuses the retry when it has moved, as the daemon's account fence does; the Swarm call then says
the account changed.

Live updates: the browser hears `swarm_changed` only on its sockets to the backend, one per machine
(`lib/webAccountPushes.ts`). With no machine at all there is no socket, so the web reads on its 15 s timer instead
(the existing fallback). Correct, just slower; adding an account socket for the browser is a separate change.

## Design (docs/feature-design-rules.md)

Reviewed revision: 0993e291d  Reviewers: the two security reviews of #2306 (sign-in and access checks; browser data and
sign-out on shared machines), no critical or important findings; their minor ones are fixed in the next revision.

1. **Growth:** N/A because nothing new is stored: no records, fields or caches. The saved views keep their existing
   lifecycle (above).
2. **Concurrency:** N/A because no new state is written. The server's per-Swarm write path is unchanged. On the
   client one build has one transport: the web always goes direct, native always to the local daemon. There is no
   fallback from direct to relay, so a call never goes both ways. A command repeated after a lost answer carries the
   same operation id as before, so the server applies it once.
3. **Read cost:** the same requests the relay sent (same paths, bodies and answers: a `parts` read and its
   changes-since reads as today); the server loads the same. What goes away is the WebSocket round trip through the
   machine and its daemon's work. Test: the web transport sends exactly the method, path and body it is given, and
   nothing else.
4. **Scale:** at 10x people on the web, the backend sees the same Swarm requests it sees today through daemons (the
   relay already counted them for the same person in the route rate limit), now from browsers instead of daemons.
   Daemon socket traffic drops. The first warning is the per-person route rate limit (`ROUTE_RATE_LIMIT_PER_PERSON_*`
   429s for `/api/super-tabs`) and the Swarm route p95 in route latency logs. Both are already measured.
   Measured (`desktop/test/super_tab_web_request_rate_test.dart`, the web's read policy, one Swarm on screen, ten
   simulated minutes): quiet 24.7 requests/min through a machine and 24.7 direct; a push every 10 s 33.3 and 33.3; a
   machine reconnecting every 20 s 29.5 through it and 24.7 direct (no read on reconnect any more). Against the default
   limits (15,000/person/min, 50/caller/s) a busy web client uses about 0.2% of its minute, about 450x headroom.
   Each of these is signed with an Authorization header, so a browser sends a CORS preflight before it, which would
   double the requests on the wire; `Access-Control-Max-Age: 600` (`backend/src/lib/corsOptions.ts`, the most Safari
   keeps) lets it keep that answer for 10 minutes, so it is one preflight per route per 10 minutes instead.
5. **Compatibility:** client-only. An old web bundle still relays through a machine, and the daemon keeps its
   `action: backend` (the phone app and old web bundles use it). A new web bundle against any server from the last
   months works, because these routes already accept the person's sign-in. The relay's `machine.contribute` retry
   with `maxAgents: 16` is for servers from before the limit was raised. Today's server takes up to 1024 (`commands.ts` `maxAgents`), so the direct path
   does not need it. Readers of `MACHINE_UNAVAILABLE` (`controller.dart:2852`, `launch.dart:751`) still get it for
   machine-only calls. `NETWORK` is new, and its only reader is `_readFailure`, which shows its message.
6. **Migration and rollback:** no data migration. Deploy is the web bundle alone. Rollback is the previous web bundle,
   which relays again. Nothing new was stored, so it has nothing to misread. No production restore is needed: no data
   changes (owner's check not required).
7. **Audience:** the server enforces it in the same route handlers and checked reads (`SwarmReads`, store
   `canReadGroup` and the Buddy chat's person-only rule), whichever client calls. Copies of private data: the
   browser's in-memory controller (dropped on account change by generation), the saved views in browser storage
   (claimed per account, cleared on Clear now), the browser's HTTP log (`attachHttpLog`: method, path and status only,
   no headers or bodies; paths hold Swarm and conversation ids, no content). Removed: the relaying machine's daemon no longer handles the person's
   Swarm answers on the web. Notifications, mentions and shares are unchanged.
8. **Identity:** each web Swarm call runs as the signed-in person, with the browser's own sign-in. Never a machine's
   or the Team account's. Missing or expired sign-in: the backend answers 401, and the app's existing sign-in flow
   takes over. Nothing falls back to a machine.
9. **Failure:** backend unreachable → "Could not reach Harness. Check your connection." with a bounded retry on the
   existing poll (no stuck Loading). Access lost → the existing `accessRevoked` path clears the view, as
   today. On the routes a person's app calls, anything the caller cannot reach (missing, never joined, removed, outside
   the Workspace, a refused link, another project's chat) answers one 404 with one body (`routes/superTabs.ts`
   `NOT_AVAILABLE`), so the answer never says which; the server log keeps the reason. Account changed mid-request → the answer is dropped (`ACCOUNT_CHANGED`). A machine-only action whose machine
   cannot answer → the specific text in the table above. 426 → "Update Harness".
10. **Platforms:** web on desktop and phone browsers changes. Native macOS, Windows and Linux are unchanged (local
    daemon). The phone app is unchanged (still relays) and is a follow-up.

## Tests (step 2, test first)

Desktop (`desktop/test`, fakes at the HTTP level, real `SuperTabClient`/controller):
- Web with no machine at all: the chat list, `#openharness` parts, a thread and the Buddy chat load. A post and a
  Buddy chat post send their command with the operation id. No `super_tabs` frame goes to any machine.
- The web transport sends the given method, path and body, unwraps `data`, and maps `{error}` and status to
  `SuperTabFailure` (403 FORBIDDEN → access revoked and cleared; 426 → update required).
- Access revoked while a chat is open: cached rows cleared, an in-flight answer that lands after is dropped.
- Account changed during a read: the answer is dropped, and the new account's state is untouched.
- A failed first read (network) shows the network text, then recovers on the next poll and the view works.
- Machine-only action on the web: offline machine, Team machine and a timeout each show their own text, never the
  catch-all.
- Native: the transport still goes to the local daemon (unchanged behaviour, regression).

Backend (`routes/superTabs.test.ts` or `superTabs` suite): a `viewer` session reads and posts like a `computer`
session; the Buddy chat and another project's ids are refused alike, with no title leak; a `team` session is still
refused.

Real app: light and dark screenshots of phone-width web loading `#openharness` and the Buddy chat with no machine
connected.
