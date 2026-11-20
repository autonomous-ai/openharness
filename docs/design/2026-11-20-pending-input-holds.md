# Preserve untyped input through pane holds

The packaged lifecycle test drops a queued ordinary message when the person clears a draft. Binding records the draft as identityHold and advances evidenceRevision. The input retry treats that current presentation change as replacement authority and discards the message before a byte was typed.

## Design

Keep the effect-time session fence unchanged. Only after an OpenClaw not-started pane refusal, at a retry boundary with no effect running, allow the same pending intent to acquire fresh authority. Match all previously captured binding fields except the changing hold/revision, preserve the engine state folder and local mode, and require an absent or known recoverable pane hold. Unknown identity/store holds and remote-machine holds refuse. Revalidate the selected native runtime, then require the exact fresh row and original caller/state still current before replacing this operation's snapshot. Actual paste/Enter continues using the unchanged strict fence. A short hold entirely between retry readings can renew only through this same fresh validation; a revision alone never grants an effect.

No new queue, timer, persisted state, dependency, process, public protocol, account identity or telemetry. The existing bounded pane/lease retry spends validation time in its original deadline. The ordinary successful path gains no native probe. Original session, process, pane, folder, caller cancellation and all unknown holds still revoke. Add regressions before changing code, including a hold wholly between retries and mutation during fresh validation. Rollback is code only. Shared TypeScript affects macOS/Linux/Windows; native Windows remains user-deferred. Existing runtime-cost and extraction holds remain open.
