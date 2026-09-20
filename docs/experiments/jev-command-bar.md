# JEV command bar experiment

The command bar is available in normal desktop builds, but its only entry point is **Cmd Shift J**. Build with `--dart-define=JEV_COMMAND_BAR=false` to disable it completely. Embedded remote viewers do not expose it.

The JEV command bar is hidden by default. **Cmd Shift J** opens or closes a Chrome-inspired pill input over the workspace; **Escape** or clicking outside dismisses it. The normal start page and workspace stay unchanged. The overlay does not resize terminals, and terminal screen refreshes preserve the keyboard's current owner. Existing **Cmd H/J/K/L** and **Cmd arrows** navigation remains unchanged.

## Try it alongside the current daemon

From this worktree, start the dedicated command service in one terminal:

```sh
cd cli
npm ci
HARNESS_JEV_PORT=18477 ./node_modules/.bin/tsx scripts/command-bar-server.ts
```

It reuses `OPENROUTER_API_KEY`, or the account saved by `ori login`. `ORI_CREDENTIALS_PATH` can override that credential file. For a temporary credential, append `--key-stdin`: input is hidden, stays in the service's memory, and disappears when the process exits. Never put a key in a Dart define or source file.

In another terminal:

```sh
cd desktop
flutter run -d macos \
  --dart-define=JEV_COMMAND_BAR_URL=http://127.0.0.1:18477
```

The normal daemon continues to own sessions, discovery and task delivery. The extra loopback service only makes JEV decisions. It does not run agents, execute commands, alter daemon data or store a credential. The same endpoints are also wired into the full daemon; omit `JEV_COMMAND_BAR_URL` when using an updated daemon. An older daemon or missing OpenRouter account leaves local actions available and reports setup guidance when a request is submitted. There are no JEV requests at app startup or while typing.

## What works

| Request | Result |
| --- | --- |
| “Take me back to the login bug” | Select an existing session by name and recent context. |
| “Fix the expired-session redirect in the auth agent” | Show the recipient and original prompt, then send through the existing routed-task delivery path. |
| “Build me a slide deck” | Suggest an advertised specialized harness and open its normal setup with the prompt filled in. |
| “Which sessions are ready to review?” | Show semantic matches with actual recent session evidence. |
| “Find work blocked on tests” | Search available session excerpts, status, live questions and harness verdicts. |
| “Which sessions are working on the same problem?” | Compare bounded recent evidence and show possible matches. These are suggestions, not conflict detection guarantees. |
| “Let me know when the auth tests pass” | Preview a watch; Start watching monitors the current sessions and shows matches in the command bar. |
| “Change the app theme”, “show history”, “split right” | Open the corresponding existing app controls. |

Auto mode interprets the operation and target. Find mode explicitly searches recent session activity. Typing only filters locally. On Enter, an exact, unambiguous app phrase runs locally; other requests go to JEV. An unavailable provider leaves local actions available. The shortcut is the experiment's only entry point in the app.

Exact phrases such as “Open settings”, “Show history”, “Show me the layout options”, “Open a new tab”, “Split right”, and “Show me the Harness Store” immediately invoke their existing app controls. “Open <session title>” and “Take me back to <session title>” also work locally when the title identifies one available target. Two matching names remain a choice. Matching considers the whole phrase, including negations or additional instructions; it never executes a matching fragment of a longer request locally.

Clear semantic navigation, supported app actions and searches can run on submission. An uncertain request explains whether the operation, target or match needs review, and omits negligible alternatives. Navigation offers **Go back** to restore the exact previous view if it is still available. This changes focus only; an opened view stays open. Sending a prompt, creating a harness and starting a watch require selecting the visible action card. New-harness setup retains the app's existing computer, folder, engine and installation checks.

## Decision flow

1. Build a registry from the live workspace. Each entry has a stable identity, capability, short context, version and app-owned callback. Exact app-owned phrases resolve against the local catalog before creating the bounded provider snapshot. Duplicate exact matches never auto-run. Local phrases and return callbacks are not transmitted.
2. Use OpenRouter's **Decisions API**, `POST https://openrouter.ai/api/alpha/decisions`, with pinned model `typesafe/jev-1.13`. Classify the operation separately from selecting its target. These independent questions share one request.
3. Independently evaluate whether the chosen action honors the whole request as an appropriate next app interaction. Automatic opening, commands and search require absolute fit of at least **0.88**, plus selected probability of at least **0.85** and a lead of at least **0.35** for both operation and target. Complete valid distributions are required. The derived `confidence` field is not a second veto on the same probability distribution; see [TypeSafe's confidence documentation](https://docs.typesafe.ai/confidence). These experimental thresholds are not a calibrated correctness guarantee.
4. Revalidate the exact action/session identity against live app state before invoking the existing callback. Provider answers never contain executable code or generated arguments.

JEV questions explicitly name the relevant state fields: question IDs are not visible to the model. Responses are schema checked, unknown targets rejected, requests bounded and timed out, and stale requests cancelled. The server accepts native loopback requests with a custom header, rejects browser origins, limits concurrent evaluations and avoids logging provider bodies or credentials.

The official wire contract was checked against [OpenRouter's Decisions implementation](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/funcs/alphaDecisionsCreate.ts), [request schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsrequest.ts), and [answer schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsresponse.ts).

## Scope of this prototype

- Recent activity, not a full transcript or repository index. The initial catalog considers up to 24 recent sessions, 24 advertised specialized harnesses and live app commands. A 96-candidate / 32k-character transmission budget may narrow that further.
- Two watches per window. Each fixes its scope when started, rechecks changed evidence at most once a minute, pauses on provider errors and stops when the window closes. Notifications appear in the app; there are no OS push notifications or durable background jobs yet.
- No arbitrary shell execution, automatic permission answers, browser clicking, viewer-object manipulation or multi-step Studio handoffs. Work requests can be handed to an existing or new agent; specialized UI automation needs dedicated action adapters.
- No microphone, attachments or generated chat answers. The plus menu creates/explores harnesses. Result explanations are actual session excerpts or fixed app labels.
- Experimental desktop feature only; remote viewer builds retain their existing UI.

## Validation

```sh
cd cli
npm run typecheck
npm test -- src/lib/commandBar.test.ts src/hookServer.spec.ts src/lib/openrouter.spec.ts
HARNESS_JEV_PORT=18477 ./node_modules/.bin/tsx scripts/check-command-bar.ts
```

The last command performs twelve live checks using synthetic work, including automatic navigation and app controls versus explicit task delivery, specialized harness selection, watches, unsupported/negated/compound requests, ambiguous targets and positive/negative semantic matching. It never executes app actions. It consumes a small amount of OpenRouter usage and requires the service above.

The recorded run passed all eight cases in approximately 0.4–1.4 seconds per check. Every supported case selected the expected action; the unsupported destructive request abstained. Only the navigation case was eligible for automatic execution in this conservative run. The other choices stayed reviewable, and the check script executed no app actions. These are smoke checks, not an accuracy benchmark or a latency guarantee. See [the live results](../../artifacts/command-bar/live-checks.txt).

```sh
cd desktop
flutter test --no-pub --concurrency=2 \
  test/command_bar_test.dart test/command_bar_catalog_test.dart \
  test/harness_command_bar_test.dart test/harness_start_page_test.dart \
  test/swarm_screen_test.dart test/swarm_interactions_test.dart \
  test/keymap_host_test.dart test/keymap_native_test.dart
```

Validation against `main` at `a940c824`: TypeScript type checking, the CLI build, the updater's 100% coverage gate, the focused Flutter analyzer, and a normal macOS debug build passed. The full CLI run passed **3,539 tests** (63 skipped), with two failures in unchanged hook-notification and installer tests; rerunning those complete suites with one worker passed all **61 tests**. The full desktop run passed **2,055 tests** (4 skipped). Its two failures, in `engine_identity_test.dart` and `group_a_identity_test.dart`, both come from a pre-existing FreeCAD tagline mismatch between the bundled identity and Store metadata; the affected files are identical to `main`. All JEV, navigation, focus and terminal recovery checks passed.

The desktop run covers the default hidden shortcut, the disabled-feature path, unchanged pane navigation, cancellation, and typing through terminal refreshes. The native shortcut snapshot excludes the command bar binding when the feature is disabled. Plain terminal panes and read-only shared sessions remain navigation targets but are excluded from task delivery.

Set `HARNESS_COMMAND_CAPTURE_DIR` while running the widget tests to render screenshots. Tests cover cancellation, stale session identities, exact prompt delivery, duplicate submission, bounded context, watch scope, offline and blocked agents, keyboard entry, narrow layouts and large text.

The direct-command follow-up on `main` at `afff73eb` passed **27 CLI decision tests** and **48 desktop command, focus and keyboard tests**, TypeScript checking, the CLI build, the focused Flutter analyzer, and a macOS debug build. The checks cover exact local dispatch without a provider, duplicate names beyond the transmitted snapshot, partial/compound prompts, malformed decision distributions, explicit send/create/watch selection despite automatic flags, and returning to an existing view without recreating a closed or replaced session. The desktop interaction test exercises **Go back** from the completion notification. The expanded live run passed **12/12**: Settings, navigation and semantic search were automatic; task delivery, setup and watches remained explicit; negated, compound, destructive and ambiguous requests never auto-ran. See [the synthetic live results](../../artifacts/command-bar/direct-live-checks.txt). These checks validate the sampled cases, not a general accuracy rate. The full repository suites were not rerun for this follow-up.

The initial visible-home-page design is not part of the app. The experiment opens only with Cmd Shift J. [Current overlay screenshot](../../artifacts/command-bar/hidden-palette.png) uses synthetic workspace data.
