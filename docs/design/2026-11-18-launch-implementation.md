Launch implementation extraction — slice 1 proposal (source only)
Source: 81238b4b2f95bb4edac0cae8f1a2c5b38bc276ac; isolated tree /tmp/harness-core-launch-implementation.

Problem
lib/engineLaunch.ts is required terminal/session authority but loads installer programs and shell help/availability probes. Three live callers remain: dead-pane diagnosis, restart without native preparation, and launch-model preflight before creation-receipt admission. Default and explicit inline/no-master production composition already supply NativeSetup and prepareNativeLaunch; these bypass pane installers. CLI shellLaunch still intentionally installs and launches under its caller's login.

Proposed boundary
1. Move buildEngineInstallationArgv, shellAgentArgv, installIfMissingScript and its installer-only helpers; remove the unreachable old pane progress renderer to engines/kit/installationScript.ts, imported solely by nativeInstall and shellLaunch. Keep shell selection/quoting/stop-proof helpers needed by terminal launch in engineLaunch, export only those reused by the installation module. No installer import/re-export back from engineLaunch. Remove unused installFirst (no production caller), remove installIfMissing from native core launch options and callers; native setup remains the sole supervised installation owner. CLI shellLaunch retains its exact script/argv behavior. The native installer drops only an unreachable quiet-progress branch: its remaining public caller never enabled the retired pane-only FriendlyInstall option.
2. Move availability/output interactive probe implementations used by the existing engineProbe service into engines/kit/interactiveProbe.ts. Remove the old flag-probe cache and functions once their core callers no longer need them. No new RPC operation or generic command executor.
3. Model/effort preflight keeps its position before receipt admission. Inject a model-support query into createLaunchRequests. In main it uses a helper beside nativeLaunch: captureLaunchExecutable selects/bounds the exact executable and environment, setup.probe(executable, 'help', environment) uses the existing eight-slot setup process and existing timeout, then core revalidates executable.current() before interpreting only the declared launchModelArgs flags. A missing/held capture or unavailable/empty/nonzero probe remains an unknown preflight (no unsupported claim); the actual creator's required native preparation still holds rather than launching on unknown evidence. No arbitrary argv, environment or script comes back from setup.
4. Permission validation without native evidence no longer silently starts a direct interactive probe; for a requested permission flag it returns the existing NATIVE_LAUNCH_HELD state. Nonterminal create/restart composition must have native preparation before dispatch; production inline/no-master already supplies the same interface. No-native fallback unit fixtures become explicit prepared fake-native fixtures; a missing dependency test verifies no pane/spawn/stop occurs.
5. New-pane diagnosis receives the already selected NativeLaunch executable snapshot in place of the obsolete install recipe. executable.current() is an existing realpath/stat comparison with no descriptor or release owner. True proves the prepared executable unchanged; false/absent is unverified, never a claim that installation failed. No new lookup or subprocess and no new resource lifetime. Keep the original launch generation/route fence after every await. All production modes finish installation before opening a native pane.

Unchanged authority
Literal launch argv, selected executable/home, final publication and current/operation checks, permission decisions, terminal identity/holds and process dispatch remain core. Installer descendants and actual-settlement ownership stay nativeInstall/setup. Failure or absence of engineSetup does not select an in-core implementation. Explicit inline composition remains tested through services/inline.

Design checklist
Growth: no new persisted data, cache, queue, timer or service. Existing probe admission, output limit and deadline apply. Removed flag cache and inline installer scripts shrink retained core work.
Concurrency: captured executable identity checked after await; existing preparation/cancellation and terminal lifecycle locks remain. Dead-pane result is fenced again by its current launch before state publication.
Read cost: same bounded executable selection; worker help observation can reuse existing per-executable help cache. Model preflight may add capture overhead versus old cache; measure before/after, do not infer a win from lines.
Scale: no new fan-out; one model preflight per original request, max existing setup admissions, two declared model flags. Terminal/creation limits unchanged.
Compatibility: public request/reply names and pre-receipt LAUNCH_MODEL_UNSUPPORTED behavior stay. Old/default clients unchanged. Private worker protocol unchanged. Explicit inline setup still eager-prepares launches. No use of receipt persistence as a substitute for front-end refusal.
Migration/rollback: no stored-format change. Rollback uses old code with existing records and native files.
Audience/identity: existing local-owner setup calls and selected launch identity only; engineProbe remains its existing feature process. No worker-chosen arbitrary command becomes launch authority.
Failure: unknown is not missing/unsupported, required preparation holds visibly, dead-pane diagnosis reports inability to verify rather than claiming installation absent. Existing bounded deadlines.
Platforms: macOS/Linux POSIX installers and shell selection; Windows probe choice/no-window and native executable identity. Unit platform fixtures do not establish signed in-session Windows proof.

RED tests selected before edits
- Architecture: default core has no dependency on installationScript/interactiveProbe and engineLaunch no longer exports installer/probe entry points.
- Model preflight: actual injected selected-executable/setup helper rejects an unsupported flag before receipt.run; changed executable or unavailable worker produces no false unsupported result; no direct exec path; both model and effort flags, stderr help, exact token boundaries.
- Dead-pane diagnosis: unverified original executable does not report ENGINE_NOT_INSTALLED; a generation/route change during diagnosis cannot publish.
- Missing native preparation: create/restart returns hold and does not spawn/stop; prepared launches preserve existing permission, first-prompt and argv behavior.
- CLI/native installer script equivalence: existing installer and shell-launch tests move to their actual owner and keep exact generated command/environment/Windows refusal checks.

Validation after agreement
Focused affected unit suites with single worker, per-file changed core coverage and types; default architecture walk. Prepare fixed source/caller cost attribution with production transforms after freeze, no measurement without coordinator quiet slot. Real isolated daemon create/restart/missing-engine/unsupported-model/inline checks selected with coordinator, no installed daemon or personal homes.

Optional settings remains same original task, separate second slice
Production PR branding is already retired (prLine null, attributionArgs test-only). Legacy agent-spawn instruction interpretation and quota statusLine settings/script publication remain live. Do not change inline config to a file unless precedence is proven. Investigate bounded declarative values plus owner-selected indexed script publication; no arbitrary argv return. This first slice does not claim optional settings completion.

Coordinator approved slice 1 before runtime edits, including the smaller original-executable dead-pane check. Missing required native preparation must hold regardless of permission mode.

Production composition proof (slice 1)
- core/main.ts creates `nativeSetup` from `createNativeSetupLink` for a supervised engineSetup, or `inline.createLocalNativeSetup` for explicit inline/no-master compatibility. The choice is before the single `createNativeLaunchPreparer` construction.
- `createAgentCreator`, `createAgentForker` and `createAgentRestarter` have no other non-test construction site. Each receives that `prepareNativeLaunch` function. Launch helpers/restore and the external resume preparer receive it too. `resumeAgentService` takes the launch overrides built by that same authority.
- `create.ts` no-native Codex hook/OpenCode plugin fallbacks were therefore unreachable for native production launches and are removed with their dependency slots. A terminal still needs no native setup. Permission refusal/downgrade helpers hold every nonterminal without native evidence, even when no mode flag is requested.
- `NativeExecutableSnapshot.current` compares realpath/stat identities and owns no descriptor or release callback. Retaining this small identity snapshot for dead-pane diagnosis extends no preparation reservation or native file lifetime.

Validation ledger so far
- Before implementation: 10 selected RED failures, actual 1; `/tmp/core-launch-implementation-slice1-red.log`.
- Focused core/native launch: 424 tests passed across 6 files, actual 0; `/tmp/core-launch-implementation-slice1-focused3.log`.
- Types after migrating remaining old caller fixtures: actual 0; `/tmp/core-launch-implementation-slice1-types4.log`.
- Owner checks 2: 286 passed, 3 failed, 4 gated skips, actual 1. Architecture, nativeInstall and moved interactive probes passed. One remaining watcher expectation and two native download fixture failures are unresolved in that result; do not call that run green.
- No performance acceptance, broad/core gate, real daemon/inline or real Windows evidence yet.

Slice 1 review checkpoint
- Types: actual 0 (`/tmp/core-launch-implementation-slice1-types5.log`).
- Required changed-core coverage: 496 tests / 9 files, actual 0; all seven changed core modules at 100% in statements, branches, functions and lines (`/tmp/core-launch-implementation-slice1-coverage2.log`, `/tmp/core-launch-slice1-coverage2/coverage-summary.json`). This is the selected per-file gate, not the entire test:core suite.
- Installer/probe owner checks: architecture, moved probes, native installer, engineLaunch and Windows fixtures passed in the selected owner run; its old watcher assertion was corrected and covered by the green core gate. Four real-tmux-gated shell cases were not run.
- Offline real installer fixtures: 12/12 passed, actual 0 (`/tmp/core-launch-implementation-slice1-user-install3.log`). The sandbox rejects /bin/ps, so the isolated throwaway-home fixtures ran outside it. Download tests now release their child from an observed wait, not a fixed sleep, and await cleanup of their own process groups.
- Exact CLI script/argv equivalence against bba49f7f4c: 16 engines, each with three literal argv shapes; all passed. Together with baseline launch recording, 18 tests / 2 files actual 0 (`/tmp/core-launch-slice1-equivalence-baseline.log`). Reproduction source: `/tmp/core-launch-slice1-prepare-equivalence.py`; exact source hashes and removed cases: `/tmp/core-launch-slice1-equivalence-evidence.json`. Baseline engineLaunch SHA256: 1e45935b477c5a0f8a506d2c0af75327c7e1734cdc6df31844affaf63d48b1ab; candidate installationScript SHA256: aa5c631744a4da17fae9501cc32ad796a5517afd8e83e5b70e8436c42149a506.
- The golden argv/script fixture was generated by the OLD engineLaunch source with only the retired installer options/shapes removed, then checked against the candidate. The four install-first cases are deleted. Override/adapter records are retained exactly from the original fixture; they were not re-recorded. The candidate golden suite passed.
- Resume: the complete isolated suite passed 174 cases and failed one obsolete four-argument mock assertion; the assertion was migrated with the removed shell parameter and its targeted rerun passed actual 0 (`/tmp/core-launch-slice1-resume-golden-final.log`, `/tmp/core-launch-slice1-resume-final-correction.log`). The earlier sandbox-only registry access failures are retained in the first caller log, not treated as application failures.
- Model preflight preserves the prior unknown result with no usable interactive shell, including Windows, with caller-visible tests. Selected executable current() is rechecked after the setup worker await. Cold/warm capture/probe cost is still to measure; warm model requests can add a capture before final native preparation.
- Performance, full core/release gates, isolated daemon/inline flows and real Windows remain coordinator-owned validation. This checkpoint does not claim the entire extraction or core refactor complete; optional settings are the next slice of the same original task.
