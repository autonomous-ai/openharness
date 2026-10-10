# Native history consumers: baseline and completion scope

The remaining path-only native-history consumers are reviewed deletion and Change
agent handoff. They must use the same complete native identity and home evidence as
binding and lifecycle control. Unavailable or changed evidence must not authorize
reading another conversation, deleting history or publishing a partial handoff.
This is part of the existing [completion checklist](2026-10-09-daemon-core-completion.md).

## Former-code golden

`nativeConsumers.golden.spec.ts` was recorded from unmodified main
`526d6bb9d081a5e8afbefd21ddefb28586570adc` on October 10 at 09:46 UTC, before any
implementation move. Its 38 observations explicitly pin Linux and macOS, the clock,
UTC, private fixture paths and allocated-block facts. Host binaries, including Node,
tmux and git, are forbidden. The actual native files, inspection/deletion helpers,
handoff provider, transcript reader and document writer run in the fixture.

The record covers Claude, default/moved/profile Codex, Pi and terminal history;
verified missing-file cleanup; and twelve own, fork-parent and discovered-conversation
handoffs across the two platforms. Only disposable files created by this test are
deleted. Workspace folders remain. Recording and unchanged replay passed, followed
by typecheck; an initial typecheck required acknowledging the filesystem API's optional
missing-stat result in the fixture wrapper.

## Remaining implementation

Carry exact native identity through asynchronous handoff reads and final publication,
and through review, Stop and the last deletion boundary. Retain the former healthy
golden unchanged; add concrete incomplete, replaced-file, changed-catalog and stale
ownership regressions, with assertion-failing wiring mutations. Select coverage,
affected private lifecycle/handoff acceptance and matched cost checks before running
them. Independent exact-head/base review and all required CI checks precede the
authorized merge. No release is authorized.
