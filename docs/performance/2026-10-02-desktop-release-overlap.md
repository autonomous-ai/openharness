# Overlapping Desktop release builds

The next measured opportunity after #612 is waiting behind another release.
[1.2.47](https://github.com/autonomous-ai/openharness/actions/runs/36964579887)
was requested at 04:26:45 UTC on October 2. Its first jobs started at 04:31:23,
three seconds after [1.2.46](https://github.com/autonomous-ai/openharness/actions/runs/36964024308)
finished. The earlier audit attributes 4m35s to the shared whole-workflow lock;
the full trigger-to-first-job interval was 4m38s.

## Change

Different versions can now build concurrently. Only publication and public download
verification hold the shared `desktop-release` lock. Retaining that lock name also
coordinates with an older workflow already running during the transition. The
remaining lock is a short publish/verify phase, rather than compilation and both
notarization passes. GitHub runner availability can still cause queues.

Publication validates all four platform files and all six expected entries, checks
the version against every live Desktop entry, reads one exact GCS generation and
writes only if that generation is still current. Duplicate or superseded versions
fail before building when already known, or before the final manifest write if
another release became live during the build. A corrupt or unreadable live manifest
is never silently replaced with an empty object. Initializing a new scratch manifest
is explicit and only an actual 404 is treated as absence.

Each macOS ZIP/DMG and Linux AppImage upload also uses a create-only GCS condition.
This closes the gap between checking that a versioned path does not exist and
uploading to it. The updater's public version, full SHA-256 and size checks remain
inside the publisher's lock. The release watcher accepts that exact successful
step, while still supporting #612's separate verification job.

These use [GCS generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
and [job concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
Concurrency does not promise version order. A newer release that finishes first
must remain live; a late older attempt is explicitly rejected. GitHub may also
replace pending jobs in a busy concurrency group. Never label such an attempt as
a successful publication or move an existing version tag to retry it.

## Validation and expected effect

The local process suite passes 40 tests, including the real publisher and actual
artifact upload commands against a disposable object-store fixture. Cases cover
complete publication, mixed/missing/wrong platform data, corrupt manifests,
permission failures, explicit initialization, stale reads/writes, all live version
comparisons and immutable artifact collisions. Workflow and shell syntax checks
also pass. The workflow includes a mode to exercise these storage preconditions
against actual GCS fixture objects without building or releasing an application.

For a release overlapping another, this removes the requirement to wait for the
previous build and notarization before starting. The historical 1.2.47 case had
4m35s of avoidable waiting. That is an opportunity illustrated by an actual past
queue, not a measured 4m35s reduction for every future release. A release with no
overlap gets little benefit from this change; its Flutter compilation and Apple
notarization still take their normal time. Publication and verification are now
on one worker, followed by release-page creation; the small handoff changes must
be included when measuring the next full release.
