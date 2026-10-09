# Kilo adoption boundary

Before changing module dependencies, the adoption golden was re-recorded from
main `47d2f5a6b` with pinned Linux platform, clock, UTC, private homes and `/tmp`.
The existing outcomes were unchanged. An additional case records Kilo alone:
its own SQLite store, complete history, exact process ownership and busy answer,
while an OpenCode process is present. Four golden specs pass.

This is the separate former-code recording commit. The subsequent move will
remove the adoption-provider re-export from Kilo's runtime entry and explicitly
ask OpenCode's module for the shared store reader, as allowed by the handoff.
Kilo's native runtime module will no longer import the adoption reader or the
OpenCode runtime code that reader reaches. The fixtures must pass unchanged,
and redirecting Kilo to the OpenCode store must fail their assertions.
