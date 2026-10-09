# Native home catalog evidence

Exact resume and process discovery now read a fresh bounded `engine-homes.json` through `nativeSessionRoots`. The former reader cached inode/mtime/size and treated read failures as an empty or partial catalog. An unreadable competing home could therefore disappear from an identity pool. A same-stamp replacement could also hide a newly adopted home.

The new reader requires a complete regular file owned by this account, without group/world write permission or a final symlink. It opens nonblocking, ties the descriptor to the inspected file, reads at most 64 KiB, and checks the descriptor and pathname again. Invalid UTF-8, incomplete JSON, duplicate properties, unknown schemas and malformed paths hold lookup with `IDENTITY_UNAVAILABLE`. There are at most 63 moved homes per engine, leaving one slot for its default home, 64 read calls and a 250 ms work deadline. Missing parents are inspected with a 32-component bound; a dangling parent link does not prove an empty installation. These are bounded work and change-detection checks, not cancellable kernel I/O or an atomic filesystem snapshot.

Every positive root comes from that call's complete file. Previously observed and in-memory adopted homes are used only to detect missing evidence: an unsaved adoption cannot silently remove a possible competitor. Valid held reads add positive facts before omission checks, so A → B (held) → A cannot forget competitor B. The cumulative facts stay bounded; an overflow remains a hold, and an oversized legacy list is rejected before visiting it. Those facts cannot supply a cached positive result. An explicit Codex profile and engines without movable session stores do not require this catalog. Existing exact/discovery/process-record final root checks read it again after asynchronous native evidence.

The separate golden commit `75d80e65f2ebf56b7c31ffdff94e012cd7b1fe7f` recorded 28 former-main observations on `fb834fb18c8642b424a30d06b643db376ca27cf9`, with Linux, UTC, fixed time, private homes and forbidden host binaries. Native roots replay its healthy observations; the artifact stays unchanged at SHA-256 `271edb4bf525076a19681d142b16be2db22da4e21aa115b2341093e4ad081f7f`. Compatibility observations, including legacy bound-home fallback, remain explicitly about the old API.

Validation covers malformed and disappearing catalogs, failed adoption persistence, a same-stamp added competitor, descriptor/path replacement, short reads, bounds, typed recovery and deliberate broken wiring. The private daemon case corrupts the catalog while a hookless process awaits binding: readiness and a sibling continue, Stop/Close keep the process alive with the reason, and the same process binds after atomic catalog recovery. Exact-head receipts, review and merge timing belong in the PR body. Matched root-collection costs use the committed private workload driver; its raw samples and comparison are added after final local acceptance.

## Explicitly unfinished compatibility migration

This change does not make legacy `sessionRoots`, `movedHomes`, home selection or catalog writers strict. Their caller migration remains part of the fixed [completion checklist](2026-10-09-daemon-core-completion.md). The independent design review identified the required ordering:

- Serialize cooperating catalog writers and confirm durable adoption before treating it as saved. A failed save must retain pending adoption; retry hook installation even if rename succeeded before durability confirmation failed.
- Preserve typed unavailability through transcript validation, and contain registration errors per discovery row. Registry load must retain affected bindings and prevent unverified rows from automatically restoring.
- Check home evidence before restart terminates an engine. Restore needs a durable hold and a real retry trigger; native catalog recovery does not produce a service-connect event.
- Validate checkpoint evidence before writing screen/history files. A bound transcript with no proven home must not fall back to another login.
- Contain unavailable homes per row for titles, activity, resources and optional readers. Search admission requires a complete snapshot and final fence when its roots migrate.
- Hook publication must retain pending intent if its final synchronous commit cannot confirm evidence. Prompt effects follow successful admission, and distinct prompt deliveries must remain distinct.

These are existing callers that must migrate together with their hold/retry behavior. Leaving the compatibility API explicit avoids introducing a new exception after a legacy caller has already stopped a process or written a checkpoint. The native-identity group is not yet complete. No release is authorized.
