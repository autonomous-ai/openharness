# Finish removing Swarm

The owner requested complete removal on 2026-11-16. The collaborative feature
already left the backend (#4280), Desktop (#4281), mobile/device/TUI (#4279),
and CLI/daemon (#4303). This change removes remaining phone notification
plumbing and obsolete product copy. It does not introduce a replacement.

Reviewed starting point: `2dc121d2c8432eaaaf7832615348a1d87c3a7eaa`.
The original working checkout was still at `d8fda0c` and contained the retired
CLI implementation; it has been fast-forwarded with the person's local
instruction edit and untracked files preserved. That working-copy update is
not publication of an application or backend release.

## Scope

- Delete the unused backend APNs/FCM delivery implementation, its private
  helpers, secret configuration and delivery metric. No production code calls
  those senders after Swarm's earlier removal.
- Stop accepting phone token registration. Retain authenticated unregister
  for supported older clients and the existing token expiry index.
- Remove mobile remote-push registration, lifecycle listeners, API methods,
  native channels and Android FCM dependency. Local agent/device notifications
  continue using their independent local-notification implementation.
- Use **New Tab** for automatic phone tab names and **tab** in placement
  errors. Remove current documentation requirements for deleted Super Tab and
  Product Manager flows.

The internal `Swarm` layout class, `swarms` layout keys and device tab-selection
messages now describe ordinary terminal tabs. They do not run the deleted
collaborative feature. Preserve working terminals, tab layouts, custom titles,
ordinary sharing and existing client/device contracts. Historical records may
continue to name the removed feature.

## Design

**Growth.** New push-token creation and renewal stop. Existing token records
expire through the unchanged 90-day `push_device_expiry` TTL or an older
client's authenticated unregister. No new collection, index, queue, timer or
bulk deletion is introduced. Existing project checkouts and agent history are
not removed by this change. Earlier authorized Swarm cleanup remains separate.

**Concurrency and audience.** Unregister retains its atomic indexed predicate
combining the platform/token digest with the authenticated account. Another
account cannot remove that record. Authentication, token validation and the
existing per-account rate limit remain. No credentials or token values enter
logs or new telemetry. No login or authority changes.

**Read cost and scale.** Retired registration returns before body parsing or
push-store access. Delivery fan-out and registration work disappear. Ordinary
tab naming adds no read, traversal, polling or request. Existing desk bounds
and serialized operations remain. HTTP status/latency metrics continue to
observe rejected old requests; the unused delivery metric is deleted.

**Compatibility.** The backend ships first. POST `/api/push-devices` returns
authenticated `410 SWARMS_REMOVED` through the existing retired-route handling;
unauthenticated callers remain refused. Earlier mobile `PushTokens.sync`
catches registration failures and backs off for an hour. Its sign-in caller
does not await that optional work, so retirement cannot reject sign-in.
The published unregister contract is POST `/api/push-devices/drop`; its method,
ownership checks, duplicate behavior and validation remain unchanged. Keep it
for at least 30 days after the last push-enabled supported client and until
supported callers are gone; 2026-12-16 is only the earliest possible date.
The new mobile client makes no push request and works with older backends.

**Stored names.** Normalize legacy automatic `New Swarm` names to `New Tab` for
display. Preserve shared-desk `nameIsCustom: true` titles exactly, including a
person's explicit `New Swarm`. Do not rewrite saved server records. The legacy
local pager layout has no custom-title flag and already treats its default as
an unnamed starter; retain that interpretation and every pane identity.
New automatic names use the existing ordinary string field, not a new schema.

**Migration and rollback.** No schema/index migration or production operation.
Retain the token model and TTL until old records expire, accounting for writes
by older backends after rollback. Remove the obsolete local token-registration
record through existing bounded client cleanup. Android loses the FCM receiver
and SDK; this is not proof that a provider revoked an existing token. Do not
retain an FCM runtime solely for a deletion shim. Narrow, dated iOS remote
unregister cleanup must preserve local notification delegation, permissions
and hotspot entitlements. Reverting code restores prior behavior without a
stored-data conversion; no deployed secret store is changed by this task.

**Failure.** Registration reports the explicit retired-feature response,
including malformed input, rather than claiming success. Unregister keeps its
existing error handling. Local notices and ordinary sign-in, resume, sign-out,
tab selection and terminal operations must remain usable without remote push.

**Platforms.** Backend TypeScript runs on Linux; local evidence names its host.
Mobile Dart and native changes affect iOS/Android. Desktop/web documentation
changes describe the existing tab UI. This task changes no daemon process
launch, terminal protocol or Windows implementation.

## Compatibility still required in the daemon

The CLI audit found no remaining live Swarm component at the reviewed head.
Retain these protections until their documented support windows close:

| Protection | Earliest documented removal |
| --- | --- |
| Successful exit for the old shell hook | 2026-12-10 |
| Owner-only completion no-op and refusal of old `super:` sharing grants | 2026-12-14 |
| Saved forced-mode/role migration | 2027-01-07/14 |
| Retired-state cleanup that preserves project checkouts | 2027-01-14 |

Removing those checks early would break old sessions or revive grants; it
would not remove another running feature. The core import closure is unchanged.

## Validation selected before implementation

1. Actual caller RED for backend registration and malformed bodies returning
   410 without token-store calls; a metrics scrape RED for the retired counter.
2. Phone caller/widget RED for outgoing automatic names, legacy automatic vs
   custom labels, and selecting/renaming a tab through Find.
3. Pre-removal sign-in/refresh proof observes actual registration through the
   existing injected `PushTokens` seam. Removing that seam requires an explicit
   fixture change: final tests use default AppNotifier with observed API/native
   boundaries and local-notification controls. Do not report these as an
   unchanged test or keep dead production injection solely for a test.
4. Focused GREEN and type checks; private Mongo legacy-token unregister tests
   for ownership/idempotency and the unchanged TTL. No production database.
5. Native manifest/entitlement/build checks, including local notification and
   hotspot preservation; mobile tests and backend unit/integration CI for the
   final source. Independent code review before merge.

Record commands, source identities, failures and actual platform coverage in
the PR and validation artifacts. Code merged, application published and native
device behavior verified are distinct outcomes.
