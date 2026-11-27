# The CLI's version gets its own field on a device (2026-11-27)

## Why

`device_bindings.firmwareVersion` is meant to hold the firmware of a Wi-Fi dial. Today it holds the Harness CLI's
version: the CLI's device lane (`cli/src/device/deviceLink.ts:739`) says hello as
`{ chip: 'harness-cli', firmwareVersion: VERSION, caps: [...] }`, and the backend stores whatever `firmwareVersion` it
gets (`backend/src/lib/deviceWs.ts` `handleHello` → `DeviceService.recordHello`). A reader cannot tell a firmware
version from a CLI version.

Ken's decision (2026-11-27): `firmwareVersion` keeps its meaning. The CLI sends its version as `cliVersion`, the
backend stores it in an optional `cliVersion` field, and `firmwareVersion` stays null for `harness-cli` devices from
then on. A USB dial's real firmware version (the cable knows it) is not sent: nobody reads it yet.

## Today, measured

Production, read-only, 2026-11-27: `device_bindings` has 280 rows (89 KB, 317 B a row, 205 KB of indexes); 279 have
`chip: 'harness-cli'` and all 279 carry a `firmwareVersion` that is a CLI version (longest 44 characters); 1 row has no
chip and no version. No row comes from a Wi-Fi dial. 26 rows were created and 97 seen in the last 7 days.

## Goals

- A new CLI's hello carries `cliVersion`, never `firmwareVersion`.
- The backend stores `cliVersion` on the device row, and never again stores a CLI's version in `firmwareVersion`.
- The owner's device read (`/api/mobile/v1`) adds `cliVersion`. What the Autonomous mobile app shows today does not
  change: it reads `firmwareVersion`, so on a `harness-cli` device the API keeps returning the CLI's version there
  until the app reads `cliVersion` (Follow-up).
- Releases in either order break nothing: backend first, then the CLI.

## Non-goals

- Sending a USB dial's firmware version.
- Rewriting existing rows (no migration, no backfill job).
- Any change to the daemon core (`cli/src/core/`), the dial firmware, the desktop, the in-repo mobile app or the web.

## Approaches considered

1. **Chosen: a new optional field, written by the CLI's hello.** The CLI sends `cliVersion`; the backend stores it;
   on a `harness-cli` row the backend maps an older CLI's `firmwareVersion` to `cliVersion` and never writes
   `firmwareVersion`. The stored `firmwareVersion` of the 279 existing rows is left as it is (no data rewrite); readers
   inside the backend treat it as a CLI version on a `harness-cli` row, never as firmware.
2. **Reuse `Machine.clientVersion`.** The same computer's machine row already stores the CLI version from `?v=`. Rejected:
   a device row has no reliable link to one machine row (`computerId` is per device; a computer can hold several
   machines across environments), and the read path would grow a join for a field Ken chose to keep on the device.
3. **Rewrite `firmwareVersion` into `cliVersion` once (migration).** Rejected: a production data write, and the read
   rule above plus the next hello of each device gives the same result without one.

## Design of the change

### CLI (`cli/src/device/deviceLink.ts`)

The hello payload becomes `{ chip: 'harness-cli', cliVersion: VERSION, caps: ['e2ee_data', 'multi_machine'] }`. Not
the daemon core.

### Backend

- **Schema** (`prisma/schema.prisma`, `DeviceBinding`): `cliVersion String?`, next to `firmwareVersion`, with a comment:
  the Harness CLI's version as of its last hello; null on a dial and on a row whose CLI has not said hello since this
  release. `firmwareVersion`'s comment says it is a dial's firmware, and that on a `harness-cli` row it is an old CLI
  version that backend readers take as
  that row's last CLI version, never as firmware. Optional, no index, no migration (`prisma db push` adds nothing to Mongo).
- **Hello** (`deviceWs.ts` `handleHello`): both values pass through one shared version check, the one
  `Machine.clientVersion` already uses (`^[A-Za-z0-9._+-]{1,64}$`, today private in `adapterWs.ts`, moved to a small
  shared module both import). A value that fails it is dropped, not stored. Then:
  - `chip === 'harness-cli'`: `cliVersion = payload.cliVersion ?? payload.firmwareVersion` (an older CLI still sends
    the second); `firmwareVersion` is not written.
  - any other chip (a dial): `firmwareVersion = payload.firmwareVersion`, `cliVersion` not written.
  - The `commander device_hello` log line logs `cliVersion` and `firmwareVersion` (both versions, no content).
- **Store** (`DeviceService.recordHello`): takes `cliVersion` like the other facts: written when present, a missing one
  leaves the stored value alone.
- **Read** (`DeviceService` `DeviceDetail` / `toDeviceDetail`, `routes/mobile.ts` `toMobileDevice`):
  - `DeviceDetail` gains `cliVersion`: the stored `cliVersion`, or on a `harness-cli` row that has not said hello since
    the release, its stored `firmwareVersion` (that row's last CLI version). Null on a dial.
  - `DeviceDetail.firmwareVersion` is the stored value on a dial and `null` on a `harness-cli` row: inside the backend
    it means firmware only.
  - `toMobileDevice` adds `cliVersion` (additive; the `/v1` shape keeps every field it had) and, for the app outside
    this repo that reads `firmwareVersion` today, sends `firmwareVersion: d.firmwareVersion ?? d.cliVersion` on a
    `harness-cli` device, so the app shows what it shows today. This one line is the only place a CLI version still
    reaches `firmwareVersion`, and it goes with the Follow-up.

### Decisions (harness-pm, 2026-11-27)

- An older CLI's `firmwareVersion` on a `harness-cli` hello is stored as `cliVersion`; a `harness-cli` row never gets
  `firmwareVersion` written again.
- `/api/mobile/v1` adds `cliVersion` and, on a `harness-cli` device, keeps returning the CLI's version in
  `firmwareVersion` as today, so the Autonomous app's users see no change.
- Both values pass the `Machine.clientVersion` check before they are stored.
- No rewrite of existing data.

### Follow-up (conditional, not in this branch)

When the Autonomous mobile app reads `cliVersion`, `toMobileDevice` stops copying the CLI's version into
`firmwareVersion` (it becomes `null` on a `harness-cli` device, as `DeviceDetail` already is). harness-pm tracks the
condition; nothing in this branch depends on it.

## Design (docs/feature-design-rules.md)

1. **Growth.** One short string (≤ 64 characters) on an existing row; no new record. The row's lifecycle is unchanged:
   created on the first connect (`resolveOrCreateForComputer`), overwritten at each hello, deleted when the owner
   forgets the device (`revokeDeviceForUser`) or by `pruneLegacyDeviceBindings`. 280 rows × ≤ 64 B ≈ 18 KB at most.
2. **Concurrency.** The write is the existing `updateMany({ deviceId })` in `recordHello`, one document; last hello
   wins, as for `chip` today. No invariant spans documents.
3. **Read cost.** No new query. `/api/mobile/v1/overview` and `/devices/:id` read the same rows (`listDetailedForUser`,
   by `userId`); each device grows by one field of ≤ 64 characters in the response. Tests assert both fields.
4. **Scale.** At 10x (2,800 rows) the field adds ≤ 180 KB to the collection. The metric that warns first is unchanged:
   `device_bindings` size and the overview's latency.
5. **Compatibility** (every reader, from `git grep firmwareVersion` and `device_bindings`/`deviceBinding`):
   - `backend/src/lib/deviceWs.ts` `handleHello`: the writer; changed as above.
   - `backend/src/services/DeviceService.ts` `recordHello`, `toDeviceDetail`: changed as above.
   - `backend/src/routes/mobile.ts` `toMobileDevice` (`/api/mobile/v1/overview`, `/devices/:id`): the only API that
     returns the field; read by the Autonomous mobile app (outside this repo). It sees the same `firmwareVersion` as
     today (the CLI's version on a `harness-cli` device) and a new `cliVersion` it may ignore.
   - `backend/src/routes/devices.ts` `/api/devices` (`DeviceView`), `backend/src/lib/webWs.ts` (`deviceId`,
     `lastSeenAt`), `UserService`, `lib/db/migrate.ts` `pruneLegacyDeviceBindings`: do not read either field.
   - Desktop, web, the in-repo mobile app, device-app: none reads the backend field; the desktop shows a dial's firmware
     from the cable (`devices_screen.dart`, `device.status.fw`), unchanged.
   - Analytics: no report reads the field; the `commander device_hello` log line changes its keys (above).
   - CLI e2e fake backend (`cli/e2e/harness/fakeBackend.ts`) ignores `device_hello`.
   Rolling deploys: an older backend reading a new CLI's hello ignores `cliVersion` and finds no `firmwareVersion`, so
   `recordHello` leaves the stored value alone (it keeps the CLI's last old-style version, which the app keeps
   showing); nothing breaks. A new backend reading an older CLI's hello stores its `firmwareVersion` as
   `cliVersion`.
6. **Migration and rollback.** Order: backend release, then the CLI release. No data migration; the 279 stored values
   stay, and the backend reads them as the row's last CLI version. Rolling the backend back: the previous release ignores the `cliVersion` field in Mongo
   (Prisma reads only the fields it declares), returns the stored `firmwareVersion` raw again (the old CLI version,
   frozen at its last pre-release hello for new CLIs), and stores an older CLI's version in `firmwareVersion` again.
   Nothing to undo. Checked against production with read-only counts (above), not a restore: no write to check.
7. **Audience.** The same predicate as today: rows by the caller's `userId` (`listDetailedForUser`, the per-device
   routes' owner check). Copies: the `/api/mobile/v1` response and the backend log line; a version string is neither
   personal nor secret.
8. **Identity.** N/A because nothing runs as anyone: the daemon reports its own version over the owner's socket.
9. **Failure.** A hello whose version fails the check stores nothing for it, and the
   stored value from the last good hello stays; the
   `recordHello` write is best-effort as today (logged `recordHello failed`, the device stays connected).
10. **Platforms.** The CLI change runs on macOS, Linux and Windows the same way (a payload key). The backend runs on
    Linux. No client UI changes.

## Tests

- CLI: `deviceLink.spec.ts`: the hello the lane sends carries `cliVersion: VERSION` and no `firmwareVersion`.
- Backend: `DeviceService.test.ts` (`recordHello` stores `cliVersion`; `toDeviceDetail` on a `harness-cli` row with
  and without a stored `cliVersion`, and on a dial), `mobile.test.ts` (overview and device carry `cliVersion`, and
  `firmwareVersion` on a `harness-cli` device is the CLI's version as today, from `cliVersion` or the old stored
  value), a `handleHello` test for the three hellos (new CLI, older CLI, dial) and a rejected version.

## Left to the builder

- Where the shared version check lives and its name (it replaces `sanitizeClientVersion`'s private regex, one rule).
- How `handleHello` is reached in a test (an existing deviceWs test harness, or a small exported pure function for the
  hello's facts).

## Calls made while writing (the builder check's minor points)

- A hello is a `harness-cli` hello by the `chip` it sends; a stored row is a `harness-cli` row by its stored `chip`.
- A `cliVersion` that fails the check is dropped; the hello does not fall back to its `firmwareVersion` (a new CLI
  never sends both).
- Stored values are not checked again on read: they came from the same CLI version string the check accepts.
- One pull request for the backend and the CLI; the release order (backend first) is a release step.
