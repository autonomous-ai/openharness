# Session-owner query envelopes

## Design

Packaged native acceptance found that the authenticated service link adds `query` and
`requestId` to every payload. Session-owner Begin and Append passed those transport fields
into exact-field admission, which correctly refused them. Cloud could create a provider
session but could not publish it or deliver its question.

Remove only these two reserved routing fields at the existing query dispatcher before
handing Begin and Append to the session-owner door. Unknown domain fields remain invalid.
Current connection identity, factory ownership, byte/count limits, deadlines, atomic
publication and native precedence are unchanged. No new state, storage, queue or process.
Growth, locking, identity and audience are unchanged; one bounded transient object replaces
the transport envelope on each stage query. Wire compatibility and persisted data do not
change, so migration and rollback need no data rewrite. Refusals remain named and visible.
The shared path affects macOS/Linux/Windows; macOS native acceptance runs here, and native
Windows remains deferred by the owner.

Before runtime edits, exercise empty and populated publications through the actual service
link, component API and session-owner validator. Preserve unknown-field rejection. Then
run the dispatcher, owner, transport and Cloud caller tests, coverage, types, and packaged
native Cloud lifecycle acceptance. The original native failures remain evidence.

## Evidence

The final `6c2d898b71` packaged native run (`20261119T104401.200425Z-11981`) passes
seven Paste cases and fails all three Cloud cases. Two service-link regression cases
fail on that unchanged runtime in `20261119T104844.119917Z-19986`. With the correction,
477 cases across 25 caller files pass and the dispatcher reaches 100% across all four
coverage metrics (`20261119T105131.773676Z-22620`). Types pass in
`20261119T104935.151501Z-20528`. The two intermediate batches passed all their behavior
cases but failed coverage because they omitted existing indirect callers; those failed
receipts remain. Packaged native validation of the correction follows this source check.
