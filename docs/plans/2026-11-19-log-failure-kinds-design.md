# Daemon failure logs: a kind, never content

## Why

Daemon log lines on a failure do one of two wrong things today:

- **They leak content.** About 180 `console.*` calls in `cli/src` print `error.message`, `String(error)`, `${error}`
  or the error object itself (which prints its stack). A message or stack can carry file paths, file contents,
  prompts or a peer's text (AGENTS.md rule 7). Since #4447 the menu-bar app can "Export logs", so these lines now
  leave the machine.
- **They hide the kind.** About a dozen catches drop the error and log only "failed" (`[registry] save failed`,
  `[registry] save names failed`, `[registry] transaction save failed`, `[registry] resume admission failed`, status
  and shutdown flushes, write cleanup…). Nobody can act on "failed" (rule 6).

Found by the e2e-flakes session; pre-existing on `main`. #4458 already moved a first set of lines to ids, sizes,
counts and kind tokens (`error.name`, `typeof error`).

## Goal

Every daemon failure log line names the failure with a short, stable token, and carries no message text, path,
stack or other content.

- Non-goals: output a CLI command prints to the terminal of the person who ran it (`cli.ts`, `*Command.ts` and the
  like), `e2e/` scripts, `tui/`. That is the person's own screen, not a log. Errors returned to clients (reply
  `error`/`detail` fields) are not log lines and do not change.
- Also out of this branch (a different cause, reviewed by hand in a follow-up task): about 70 lines that log content
  not read from an error object at the line, such as stored `result.detail`/`.reason` strings, a process's stderr,
  paths, and error strings a peer or the backend sent; and the lines whose only content is an error's `.reason`,
  `.detail`, `.stderr`, `.stdout` or `.path`. The final report lists them file:line for that task, which extends the
  guard to those fields.
- Anti-goals: a token that can carry free text (a reason string, a path); a second logging path or console wrapper;
  losing the kind a line already had.

## Approach (chosen: A)

- **A, chosen.** One helper in `cli/src/lib/log.ts` (already in the core's process, beside `sid`), and every
  offending call site changed to use it. A guard spec scans `cli/src` and fails on a `console.*` call that logs raw
  error content. The guard is the red test for the sweep and keeps the cause from coming back (rule 13).
- B, rejected: wrap `console` in `installTimestampedConsole` to turn Error arguments into their kind. It cannot see a
  message already inside a template string, and it hides the rule in a shim.
- C, rejected: fix each site with no guard. The next change brings the cause back.

## The kind token

`failure(error: unknown): string` (name is the builder's call) returns, and never anything else:

- an error's `code` when it is a string shaped like a code (`EACCES`, `ENOSPC`, `EEXIST`, `ERR_SOCKET_CLOSED`,
  `IDENTITY_UNAVAILABLE`: upper case, digits, `_`, bounded length);
- the error's `name` when it is not the plain `Error` (`TypeError`, `AbortError`, `SyntaxError`, our own typed
  errors such as `IdentityReadUnavailable`, `RegistryOwnershipChanged`);
- both when both apply (a typed error with a fixed code, e.g. `RegistryOwnershipChanged IDENTITY_UNAVAILABLE`), so a
  failure of our own stays actionable;
- `Error` for a plain Error with no code; `typeof error` for a thrown non-Error (`string`, `object`, `undefined`).

A free-text reason (a constructor argument, a message) is never part of it. Where a wrapped error keeps the disk's
code on its `cause` (registry persistence), the builder decides whether the token follows `cause` one level; the
requirement is that the registry's save lines show the disk code when one exists.

## Call sites

- **Which lines.** A log line is any `console.*` call and any call to an injected logger (`deps.log`, `this.opts.log`,
  `this.wiring.log`, a `log`/`warn`/`error` parameter: about 92 more calls, some in the core). Files that both print
  command output and run in the daemon (`cli.ts`'s `start --foreground` path, `lib/selfUpdate.ts`,
  `lib/runtimeInstall.ts`, `lib/machineEngines.ts`) are judged line by line: a line that runs in the daemon follows
  the rule (our call: under launchd or systemd the foreground daemon's stdout is the log file).
- **A plain `Error` reads `Error`.** About 535 `throw new Error('…')` carry fixed text; their token is `Error`, and the
  line's tag and wording keep its context. This branch adds no typed errors and changes no error a client receives
  (our call: log text only).
- **What `harness start` reads stays readable.** `harness start` tells a revoked sign-in, a busy machine, a wrong
  backend and a certificate fault apart from the daemon's `[backend] socket error` line (`lib/daemonLaunch.ts`
  `connectFailure`). That line keeps the HTTP status as a number in fixed words
  (`· Unexpected server response: 401`) beside the kind, and `connectFailure` learns Node's TLS codes
  (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, …). Editing `lib/daemonLaunch.ts` is in scope.
- **Raw content:** each daemon log call that passes `error.message`, `String(error)`, `${error}` or the
  error object logs `failure(error)` instead. The line keeps its tag, ids (`sid`), sizes and counts. A line that
  printed a path or URL keeps at most what #4458 allows (an id, an extension, a method), never the path.
- **No kind:** each `.catch(() => console.*('… failed'))` and `catch { console.*('… failed') }` takes the error and
  logs its token. Lines that already name a fixed code (`LIVE_REATTACH_FAILED`, `VIEWER_STOP_FAILED`,
  `HISTORY_REPLY_FAILED`) add the token too.
- Named starting points: `cli/src/engines/hooks.ts` (`admitHook`: `[hooks] <engine> admission failed:`),
  `cli/src/lib/registry.ts` (save, save names, transaction save, resume and pending admission),
  `cli/src/lib/registryPersistence.ts`, `cli/src/core/main.ts`, `hookServer.ts`, `backendSocket.ts`.

## Guard

A spec beside the other architecture specs walks `cli/src` (excluding `*.spec.ts`, `e2e/`, `tui/` and the files
that only print CLI output to the person's own terminal, listed in the spec with the reason) and fails on any log
call (`console.*` or an injected logger, above) that logs content read from an error object: `.message`, `.stack`,
`String(<error>)`, `${<error>}`, a caught error passed bare, an error handed to a helper (`describe(error)`), or a
local derived from one. It also fails on a catch that logs "failed" with the error discarded. It does not flag an
error's `.reason`, `.detail`, `.stderr`, `.stdout` or `.path`: those belong to the follow-up task with the stored-string
lines, which extends the guard later. It must fail on `main` today (red) and pass once the sweep lands (green). An
exception list, if any, says why for each entry and is expected to be empty.

## Tests

- Unit tests of the helper: Node fs error (code), typed error with fixed code (name + code), `TypeError`, plain
  `Error` with a path in its message (token has no path), thrown string (token is `string`, not the string).
- Red-then-green log-line tests for the named sites: `admitHook` with an admission that throws an error whose message
  holds a path logs the kind and not the path; a registry save that fails with `EACCES`/`ENOSPC` logs that code and
  no path.
- The guard spec.
- The change touches `cli/src/core` and `lib/log.ts`, which the core loads: run `npm run test:core` and put its
  receipt in the pull request body before pushing.

## Platforms

CLI daemon on macOS, Linux and Windows; the change is in log text only and behaves the same on each.

## Left to the builder

The helper's name; whether the token follows `cause`; the guard's parsing method (regex or TypeScript AST); how the
sweep splits into tasks (by folder, files not shared between tasks).
