# Native location completeness and discovery retry

The former native location implementation was recorded in `1121bf7fd` before production edits. A separate fixture-only commit, `1f82cef1b`, maps streamed Linux descriptor enumeration in the existing identity golden to the same private evidence as its previous listing. The new 24-observation artifact pins Linux, UTC, clock, native declarations and private filesystem/process fixtures; no host binary runs. Recording again against merged main `138ae6766` left it unchanged. Artifact SHA-256: `0efe2ce638b5d65f34cace39a8d686e3e758aea55bf04cc5d61f371ea265809a`.

The existing locators could interpret read errors as absence, stop at the first matching transcript or descriptor, and accept the readable prefix of a failed process probe. Transcript discovery could leave its initial lookup permanently marked busy after rejection; one failed candidate could also abort the remaining sweep. Bound Copilot, continuation and argv-resume lookup failures could escape the serial binding pass.

## Behavior

Native directory enumeration now streams under an entry budget. Exact transcript lookup checks the complete project pool, distinguishes inode aliases from conflicting files, bounds workspace sidecars, and rejects a changed directory listing or candidate. Ordinary transcript appends keep the same file identity. A shared listing carries evidence for that one sweep and is checked before publication; caller-supplied subsets cannot hide competitors.

Copilot requires a complete lock pool and a unique newest claim. Every claim, including absence, is rechecked; the selected claim is read last. Linux descriptor enumeration shares one budget across its initial and verification listings, checks descriptor changes, and refuses conflicting or deleted conversation locks. Darwin's process probe has a four-second deadline and 256 KiB output bound per invocation; two complete matching replies are required. A failed probe's partial stdout is never authority.

Native reads are contained separately from registry publication in core binding. A rejected read preserves the current row and allows the next session and readiness to continue. Transcript discovery retains pending intent through lookup, listing and publication failures; one candidate's failure cannot abort its siblings. Remove, replacement and stop still revoke late completions. Repeated identical polling reasons are logged once per candidate.

## Validation plan and scope

Run types, architecture, core/services and master coverage at their per-file 100% gates, affected native/repair/Stop/Close specs and unchanged goldens. Run the affected resume coverage lane alone. Extend both private bundled eager-identity lanes: optional native modules missing and stalled, a held Copilot lock pool, a failed Cursor transcript lookup, sibling publication, and recovery. The mutation script deliberately breaks native declarations, completeness and retry wiring; every break must fail an assertion after a green baseline. Measure CPU, RSS and latency with the same private native corpus on former and candidate production. Exact-head independent review and automatic CI precede merge. No release.

The initial affected run passed 127 tests and types; the directory/descriptor race follow-up passed 135 tests and types. Final gate results, mutation outcomes, runtime cost, review and merge evidence are recorded in the PR and appended after completion. Initial recording passed its test but the validation wrapper correctly reported `source_changed` because recording created the artifact; verification with recording disabled passed. The later recording against merged main passed without changing the artifact.

This is part of the [completion checklist](2026-10-09-daemon-core-completion.md), not completion of its whole native-identity group. The legacy saved-home catalog, exact-ID traversal in `sessionRepair`/compatibility session records, complete Hermes pools, and shared visible binding-hold state remain separate named blockers. This change does not claim atomic filesystem snapshots or a cancellable filesystem API; it rejects observed incompleteness and changed evidence within bounded lookup work.

Timing starts with baseline preparation at approximately 13:55 UTC on October 9. Implementation and its focused validation overlap; final validation, independent review/CI waiting and merge are recorded separately. Publication remains zero.
