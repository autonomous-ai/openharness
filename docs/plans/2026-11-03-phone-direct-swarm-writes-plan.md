# Phone Direct Swarm Writes Implementation Plan

> **For agentic workers:** Implement this plan task by task in the current Harness session, test first. Commit each failing test before its implementation; use independent whole-branch review and simulator testing when ready.

**Goal:** A signed-in person can post and answer a Swarm decision from the phone while all their machines are offline, with retries retaining the same operation ID.

**Architecture:** Reuse the phone API client's bearer authentication, refresh interceptor and Swarm response parser for POST requests. AppNotifier tries the backend before selecting a machine; write access refusals stand, while transport failures and server unavailability may fall back to the existing machine path with the unchanged body. Keep machine-specific requests and terminal transport as they are.

**Tech Stack:** Flutter 3.47.2, Dart, Dio, flutter_test, existing in-memory account/socket fixtures.

**Spec:** Swarm task #2303, “Phone: Swarm commands go straight to the server with the phone's own sign-in (Huy),” conversation `b847053227ae321848ae8b5d`; supporting API/state paths approved by the PM.

## Global Constraints

- Phone package only, plus this plan: no backend, terminal, notification or polling changes.
- Never install on a phone or contact real accounts in tests; run on Tony's Mac with memory authentication and fake HTTP/sockets.
- Preserve the supplied command body and operation ID through bearer refresh, machine fallback and user retry.
- Direct write failures about authentication, access, rate limits or invalid input must not gain access through a machine.
- Two independent security reviews (sign-in, tokens, access), simulator testing, red/green evidence in a PR comment and green CI before completion.
- PR body starts with: Requested by phamngochuy.1989@gmail.com through Harness.
- Stop only owned processes by ID; temporary files go in a directory created with mktemp -d; install nothing system-wide.

## Design

- Growth: No new persistent data; existing server retention and operation receipts apply.
- Concurrency: Existing server command transaction and operation-ID deduplication remain authoritative; client retries reuse the request.
- Read cost: No new reads or polling; reuse current refresh behavior after writes.
- Scale: Same one POST per write, with at most one bearer refresh and existing bounded machine fallback; direct failure frequency/latency warns first at 10x traffic.
- Compatibility: Existing backend routes and wire bodies; machine fallback remains for unavailable direct transport. Machine-specific operations still require a machine.
- Migration + rollback: No schema migration; reverting mobile transport restores machine forwarding.
- Audience: Backend membership and decision-target checks enforce access; definitive direct refusals never fall back.
- Identity: Phone bearer identifies the signed-in person; no machine-owner login or identity field is substituted.
- Failure: Preserve backend refusal details; discard replies and prevent fallback after account changes; existing UI displays unconfirmed sends and offers retry.
- Platforms: iOS and Android share the Dart transport; test on Tony's Mac and an iPhone simulator, never a real phone.

## Review Focus

- A token refresh must retain the exact command and operation ID and never log credentials or message bodies.
- A backend access/authentication refusal must not trigger a machine fallback with different privileges.
- A reply or failure after account change must be discarded before fallback can write for a new account.
- A lost direct reply followed by fallback or user retry must retain one operation ID; idempotence remains server-enforced.
- A direct request must remain on the configured backend, refuse redirects, and leave machine-specific/terminal operations untouched.

## Validation Plan

Run focused API and Swarm transport tests for each red/green cycle, then the complete mobile Flutter suite once (two workers on this shared Mac, bounded to 15 minutes), targeted static analysis and the Swarm style check. Automatic ready-PR CI supplies the Linux component/process checks; no manual CI runs. No backend suite is required because backend code is unchanged. Independent reviewers inspect source and evidence; a Tester runs the offline post/decision flows in the simulator. Record implementation, validation, review/CI waiting and handoff durations separately; the PM owns merge/publication.

### Task 1: Authenticated direct Swarm POST transport

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Test: `mobile/test/api/api_client_test.dart`

**Interfaces:**
- Consume: existing `AccessTokenSource`, `BearerAuthInterceptor`, Dio adapter and Swarm envelope semantics.
- Produce: `Future<Object?> ApiClient.swarmWrite(String path, {Map<String, dynamic>? body})`, POST only, signed with the phone bearer, unchanged JSON, no cross-host or redirect forwarding; retain `swarmRead(String path)` for current consumers.

- [ ] Add and commit failing API tests: POST message and decision payloads use the phone bearer/environment; 401 refresh replays identical JSON/operation ID with the refreshed token; missing credentials make no HTTP request; access failures retain code/status; redirects are refused; foreign absolute paths are rejected; tokens and private text stay out of logs.
- [ ] Run `flutter test --no-pub --concurrency=2 --timeout=60s test/api/api_client_test.dart`; observe the new transport tests fail before adding production code.
- [ ] Add `swarmWrite`, reuse the existing envelope decoder, and disable redirects for writes. Keep the shared bearer interceptor unchanged.
- [ ] Run the API tests and commit the passing implementation; push both commits to the draft PR.

### Task 2: Direct-first routing and offline phone actions

**Files:**
- Modify: `mobile/lib/state/app_state.dart`
- Modify: `mobile/lib/swarm/swarm_outbox.dart` (transport documentation)
- Modify: `mobile/README.md`
- Test: `mobile/test/swarm/swarm_request_test.dart`
- Create: `mobile/test/swarm/swarm_direct_writes_test.dart`

**Interfaces:**
- Consume: Task 1 `ApiClient.swarmWrite`, `AppNotifier.swarmRequest(String method, String path, {Map<String, dynamic>? body})`, existing `SwarmConversation`/`SwarmAsks` request injection and operation receipts.
- Produce: same `SwarmRequest` contract; GET behavior unchanged, POST uses direct transport first, machine forwarding retains body and operation ID after unavailable transport/server responses.

- [ ] Add and commit failing tests using a real ApiClient with an in-process HTTP adapter and an in-memory AppNotifier: post and decision answer with all account machines disconnected; lost response then retry retains operation ID; network/5xx fallback carries the same JSON; 400/401/403/404/426/429 refusals never reach a machine; sign-out during held success/failure drops it with no fallback; non-command writes use direct POST too.
- [ ] Replace the old test asserting commands always use a machine with the new direct-first expectation; preserve existing GET/machine tests.
- [ ] Run `flutter test --no-pub --concurrency=2 --timeout=60s test/swarm/swarm_direct_writes_test.dart test/swarm/swarm_request_test.dart`; record expected failures.
- [ ] Try `swarmWrite` for POST before selecting a machine. Check the original authentication revision after each asynchronous direct result and before fallback; allow write fallback only for transport/server unavailability. Preserve GET fallback policy and machine-local requests.
- [ ] Update README to describe direct signed-in reads/writes, bounded machine fallback and unchanged encrypted terminal transport; update stale transport comments.
- [ ] Run focused tests, the complete mobile suite and targeted analysis/style validation; commit passing code and push.
- [ ] Record red/green evidence in a PR comment, mark Ready, keep head stable, route two independent security reviews and a simulator Tester, then record passed acceptance checks and hand off to the PM.
