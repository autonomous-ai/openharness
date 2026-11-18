# Wi-Fi projection byte admission

## Design

The fixed attribution3 diagnostic on frozen 839a6ede62 sampled 60.3 ms inside the
Wi-Fi projection's repeated `boundedJsonBytes` retention walk across eight complete
refreshes. Unknown-record validation accounted for another 122.0 ms and producer
admission for 193.3 ms. Transport encoding/decoding sampled 104.6 ms, versus 15.5 ms
in the old view. These are source diagnostic samples, not accepted timing; the v8
complete-refresh performance hold remains. Surviving heap samples were dominated
by inspector bookkeeping and do not establish allocation churn.

The component already validates every unknown record before its observer and
projection. Wi-Fi then constructs two fixed, shallow objects containing only
checked strings, nulls and constant state strings. It copies no unknown keys,
objects or prototypes. Repeating the descriptor/proxy/cycle walk on these new
objects is unnecessary. Size each constructed object with native JSON encoding
and UTF-8 byte length, then discard the encoded string before retaining its row.
Each transient encoding covers one projection of one already bounded input row;
no complete view is encoded or copied. The machine ID comes from the separately
bounded checked header, and canonical workspace resolution remains synchronous
with its existing fallback. No cache changes the timing of filesystem reads.

Replace the shared projection's implicit object-sizing callback with an explicit
byte budget: its remaining bytes and an admission method accepting an exact byte
count (or refusal). This is component-local accounting, not a wire or core API.
The same single per-read counter still enforces 64 MiB, the same 48-byte overhead
per retained object, and the same membership overhead. Admission rejects null,
negative, fractional, unsafe or excessive sizes before a row enters its array.
Expose remaining capacity through a read-only getter so Devices retains its
existing early refusal with `boundedJsonBytes(row, budget.remaining)`.

Devices spreads checked rows, including unused nested fields, so it retains its
security walk. Header accounting also retains its security walk. The unknown
record boundary, inline-source checks, synchronous settlement, identity observer,
exact-end commit and current-owner failure invalidation are unchanged. No trust
flag, retained raw view, wider reply, new core state or capability is added.

### Checklist

1. Growth: the byte counter and budget exist for one read. Success replaces the
   caller's previous view; failure, abort, disconnect or replacement discards the
   provisional rows. There is no archive or persistent record, so archive/purge
   readers are N/A. Each temporary encoded string is discarded before array admission.
2. Concurrency: the existing single active read per connection and synchronous
   row/settlement callbacks own admission. No await separates sizing from retaining
   a row. Existing component/core/machine fences still decide whether to commit;
   no lock, retry or write path is added.
3. Read cost: wire records and database work are unchanged (no database reads in
   this correction). The 1,600-row diagnostic encoded 1,023,009 Wi-Fi bytes;
   independent output hashes matched the baseline. These diagnostic paths have
   different fixture-root lengths from v8 timing, so their byte totals are not a
   new timing comparison. Gone records, exact membership/end and complete output
   tests remain. Only constructed Wi-Fi rows avoid the repeated security walk.
4. Scale: 10x the 1,600-row case is 16,000 rows, not measured or accepted here.
   Existing 8 MiB membership, 16 MiB record and 64 MiB retained-view limits still
   refuse the entire read. No limit is raised. Encoded/retained bytes, full-refresh
   CPU/latency and post-read retention in the frozen comparison warn first. The
   current ~3x refresh regression remains a release hold; this sampled subset
   cannot establish complete-path performance. No new production metric is added.
5. Compatibility: no wire/public field, version or state changes. A caller census
   finds Wi-Fi's `wifiProjection` and Devices' inline projection as the only runtime
   `SessionProjection` producers. Wi-Fi changes size computation; Devices retains
   the security walk and exact remaining capacity. Store's direct projection
   fixture changes its test-only budget shape. Existing and rolling clients receive
   identical views, including nulls, absent fields and unavailable-read behavior.
6. Migration/rollback: no stored data/schema migration; production backup restore
   and anomaly queries are N/A. Reverting the three service files restores the
   previous sizing walk without changing data or component/core cohorts.
7. Audience: existing authenticated service read scopes and current machine/core
   checks remain the only authority. Checked records stay in the same component's
   provisional view and are published only after complete settlement. No new feed,
   share, notification, transcript copy or logged content is introduced.
8. Identity: no action or login is added. Existing verified machine and component
   owners are required; missing/replaced identity refuses the view. No fallback
   to another machine/account is introduced.
9. Failure: malformed input remains `SESSION_READ_UNAVAILABLE`; failed byte
   admission remains `SESSION_READ_TOO_LARGE` before commit. Existing caller failure
   handling keeps the view unavailable or the previously admitted Devices view;
   a later ordinary refresh can recover. No replay or partial-empty result is added.
10. Platforms: shared TypeScript runs on macOS, Linux and Windows, with the existing
    synchronous filesystem canonicalization behavior. macOS source gates run here;
    Windows is deferred by the user and Linux is unverified in this local slice.
    Mobile/web changes and new platform dependencies are N/A.

## Proof

First fail a real `readWifiView` test showing its newly constructed output rows
are still sent through the unknown-object security walker. Preserve the full
output and prove every incoming record is still checked. Then cover exact JSON
UTF-8 sizing for ASCII, controls, quotes, backslashes, multibyte Unicode and lone
surrogates, null/absent fields, failed-launch detail, and canonical workspaces.
Check the exact aggregate boundary and one-byte overflow with the unchanged
overheads, invalid byte counts, failure before commit, and both former capacity
cases (4097 rows and two valid 1.6 MB DSH fields). Existing getter/proxy/malformed
input and Devices nested-data controls remain mandatory.

Selected validation is sessionSnapshot, wifiView, Devices process, Wi-Fi process
and service callers, bounded JSON helper tests, architecture and types, with
100% per-file coverage for the three changed service files. No native or timing
execution is included; remeasurement requires a separately reviewed packet.
macOS source tests run here; Windows remains explicitly deferred by the user.
