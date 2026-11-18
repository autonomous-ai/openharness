# Terminal screen interpretation in the engine worker

The default core imports `engines/kit/screen`, bringing the vendor pane and question parsers into
its process solely for ordinary terminal sessions. Route those stateless reads through the existing
engine-others screen port. Keep the same terminal reader and every recorded screen result, including
its neutral no-capture result. Core retains capture bounds, session binding and input authority.

## Design

- Growth: no new retained screens, process, cache or request map. Reuse the existing screen transport's
  eight active and 64 queued requests per worker, 256-KiB capture and 1-MiB reply limits.
- Concurrency: the existing FIFO deadline and worker connection generation fence every read. Session
  binding is checked before and after the await. Worker loss never invokes an in-core parser.
- Read cost: one captured screen per request; no history or Registry scan. Measure the existing
  in-process reader against this boundary on the same captures before release.
- Scale: at ten times the active screen workload, existing bounded queue admission refuses excess
  requests. Existing engine busy/unavailable failure identities apply; no new poller.
- Compatibility: engine-others capability version 5 advertises terminal screen support. Current
  authenticated worker cohorts include this capability in their existing derived plan. Older masters
  and explicit inline/Harness OS composition keep the existing terminal reader through the already
  dynamic inline module until 2026-12-15. Null remains unavailable for other worker-backed engines;
  the terminal's existing null-capture reading travels through its own reader. Public frames unchanged.
- Migration and rollback: no stored data changes. Preserve existing cohort refusal and legacy master
  compatibility; never infer inline compatibility from worker failure.
- Audience: only the authenticated local owner service can invoke the private screen request. Terminal
  support extends only screen capabilities/read; runtime, model and question-control doors still refuse it.
- Identity: no account, process environment, path or terminal handle goes to the reader; only bounded
  capture text. Nothing is logged from that text.
- Failure: existing request deadline, malformed reply and stale-generation rejection return unavailable
  evidence. Terminal controls remain in core and cannot act on a late screen.
- Platforms: portable TypeScript on macOS, Linux and Windows; same existing worker startup/transport.
  Native macOS proof required; native Windows execution is deferred by the user.

## Validation

First reproduce the current missing terminal port and null-capture loss with tests through real
`otherRuntimeRequests` and `createScreenTransport`, plus core's final binding check. Preserve the full
frozen terminal screen corpus. Cover terminal refusal on non-screen doors, unauthorized/oversized
reads, worker disconnect/replacement, deadline and bounded queue controls. Run affected engine/core/
harnessd coverage and types, architecture closure and packaged screen failure isolation on the final
combined artifact. Source size reports are informative, not performance or acceptance evidence.

The first architecture check exposed two additional eager edges: OpenClaw's declared contract uses
only `stripAnsi` from the pane parser, and question authority uses only typed-question approval
classification from the question parser. The former uses the identical existing runtime helper;
the latter is kept in one small shared `questionApproval` module, used by core consent and worker
screen holds. Its unchanged regexes and behavior are covered by the existing approval/permission
cases. Core does not gain raw pane parsing or a feature-specific record. This removes the parsers,
not just the main screen import.

## Source evidence

Actual initial RED: `20261118T075733.687027Z-44320`, two failures through core's screen reader
and the real bounded worker port. Final source gate `20261118T080733.507453Z-54538` passes
257 tests in 12 files plus types. Screens, screen transport, snapshot transport and the shared
approval classifier each pass 100% statements/branches/functions/lines (94 statements, 83 branches,
18 functions in total). All frozen terminal readings, including no capture, are unchanged.

Intermediate failed receipts remain: `075904` found missing eager-import edges and the old master
capability expectation; `080055` identified the now-unreachable dialog-end parser; `080603` caught
parser constants moved together with an adjacent comment. The constants are restored to their
parser; no golden expectations were changed. The final architecture list has 507 files versus
510 before, removing four parser files and adding the 27-line typed-question approval classifier.
This count is not performance acceptance.

Two packaged terminal shell-input cases are prepared in `e2e/engineReaders.e2e.ts`: supervised
worker freeze/refusal/recovery with the same live core, and explicit inline compatibility. They
have not run yet. Native execution, matched costs and independent review remain required.
