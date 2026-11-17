Launch implementation extraction — slice 1 proposal (source only)
Source: 81238b4b2f95bb4edac0cae8f1a2c5b38bc276ac; isolated tree /tmp/harness-core-launch-implementation.

Problem
lib/engineLaunch.ts is required terminal/session authority but loads installer programs and shell help/availability probes. Three live callers remain: dead-pane diagnosis, restart without native preparation, and launch-model preflight before creation-receipt admission. Default and explicit inline/no-master production composition already supply NativeSetup and prepareNativeLaunch; these bypass pane installers. CLI shellLaunch still intentionally installs and launches under its caller's login.

Proposed boundary
1. Move buildEngineInstallationArgv, shellAgentArgv, installIfMissingScript/progress and their installer-only helpers to engines/kit/installationScript.ts, imported solely by nativeInstall and shellLaunch. Keep shell selection/quoting/stop-proof helpers needed by terminal launch in engineLaunch, export only those reused by the installation module. No installer import/re-export back from engineLaunch. Remove unused installFirst (no production caller), remove installIfMissing from native core launch options and callers; native setup remains the sole supervised installation owner. CLI shellLaunch retains its exact script/argv behavior.
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
- Dead-pane diagnosis: unverified capture does not report ENGINE_NOT_INSTALLED; delayed result after generation/route change cannot publish.
- Missing native preparation: create/restart returns hold and does not spawn/stop; prepared launches preserve existing permission, first-prompt and argv behavior.
- CLI/native installer script equivalence: existing installer and shell-launch tests move to their actual owner and keep exact generated command/environment/Windows refusal checks.

Validation after agreement
Focused affected unit suites with single worker, per-file changed core coverage and types; default architecture walk. Prepare fixed source/caller cost attribution with production transforms after freeze, no measurement without coordinator quiet slot. Real isolated daemon create/restart/missing-engine/unsupported-model/inline checks selected with coordinator, no installed daemon or personal homes.

Optional settings remains same original task, separate second slice
Production PR branding is already retired (prLine null, attributionArgs test-only). Legacy agent-spawn instruction interpretation and quota statusLine settings/script publication remain live. Do not change inline config to a file unless precedence is proven. Investigate bounded declarative values plus owner-selected indexed script publication; no arbitrary argv return. This first slice does not claim optional settings completion.

Coordinator approved slice 1 before runtime edits, including the smaller original-executable dead-pane check. Missing required native preparation must hold regardless of permission mode.
