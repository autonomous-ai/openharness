# Runtime profiles after the legacy manager

The former manager combined accepted session state and control waiters with native
configuration, catalogs and footer interpretation. Item 6 removes that file. The
state owner remains eager; optional engine readers hold only their native catalogs
and model targets. The supervised Claude Code and Codex worker boundary stays as it
was. Explicit inline mode supplies their existing runtime facets to the same state
owner.

`lib/runtimeProfileState.ts` owns accepted model/effort state, hydration, control
confirmation, waiters, notifications and forget. It performs no file reads or
subprocess work. `core/engines/runtimeProfiles.ts` routes supervised pilot readings
to the existing transport and local observations to that owner. Session stop,
binding, admission, launch, discovery and resume do not ask these readers.

Each other engine's `profileReader.ts` owns the interpretation previously embedded
in the manager. Its existing lazy `inProcess.ts` entry exports a factory. One
reader per engine per owner holds that engine's catalogs and targets. Cursor's
catalog/footer logic belongs to Cursor; Hermes reads the session's own native
home; Command Code refreshes per-model effort after an observed model change.
Catalog subprocesses keep their prior timeouts and size limits. These other engines
remain display-only. Their latent picker builders and the six unreachable pane
drivers are retained; this move enables no additional model control.

A missing chunk, missing factory or throwing factory leaves the existing accepted
profile intact. State confirmation and cleanup need no reader. A failed factory is
reported once and remains unavailable for that owner's lifetime.

Configuration reads and staged transcript hydration publish only against the same
current registry row, session identity, state object, state revision and control transaction. Configuration
also checks the latest read token. Native-home changes, newer observations, another
hydration, control changes and forget discard stale answers. Interpretation uses
copies; a staged read cannot expose a CLI version or confirmation before commit.
A repeated confirmation or same-value observation still advances the revision;
ignored records do not. A dependent config refresh starts after its synchronous
observation is accepted and is dropped if the registry replaces its row, newer
confirmation arrives, or an explicit config read has already started. It cannot
supersede the explicit read that a caller awaits.
Inline transcript attachment reads config into the staged profile, then installs
the parser and profile in one synchronous commit after the final tail-hold check.
Expiry, failure or newer evidence keeps both the previous parser and its profile.
Forget completes core state, timer and waiter cleanup before optional native
cleanup runs; a broken reader cannot interrupt the caller's session cleanup.
These are safety corrections found while extracting the former implementation,
covered by regressions that failed before the publication checks were added.

The daemon loads each native reader before delivering its transcript. Direct
compatibility callers must honor that same ordering; the Command Code regression
fixture now does. A pre-existing pane-poll limitation remains: a registry row
mutated in place while capture is pending needs a snapshot taken at dispatch.
Entry-time identity checks alone cannot distinguish that older screen; this is
tracked separately from the extraction's asynchronous config/stage fences.

The former-code baseline is commit `996476cf0`; its observation and state/control
fixtures must remain unchanged. The baseline method is in
[the recording note](../research/2026-10-09-runtime-profile-golden.md). Validation
includes deliberate wiring mutations, typecheck, architecture, core/harnessd 100%
gates, profile/controller/reader specs, and isolated reader/model-control/lean
end-to-end lanes. Performance uses the preceding four-agent/two-active workload,
with the same toolchain and short measurement windows, not a new threshold.
