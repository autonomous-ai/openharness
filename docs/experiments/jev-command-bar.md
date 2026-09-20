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

Auto mode interprets the operation and target. Find mode explicitly searches recent session activity. Typing only filters locally; Enter starts a provider request. An unavailable provider leaves local actions available. The shortcut is the experiment's only entry point in the app.

Clear, strongly matching navigation and supported app actions can run on submission. Sending a prompt, creating a harness and starting a watch require selecting the visible action card. New-harness setup retains the app's existing computer, folder, engine and installation checks.

## Decision flow

1. Build a bounded registry from the live workspace. Each entry has a stable identity, capability, short context, version and app-owned callback.
2. Use OpenRouter's **Decisions API**, `POST https://openrouter.ai/api/alpha/decisions`, with pinned model `typesafe/jev-1.13`. Classify the operation separately from selecting its target. These independent questions share one request.
3. Independently evaluate whether the chosen action is an appropriate next app interaction. Choice probability alone does not establish a match. Experimental confidence thresholds limit automatic navigation; they are not a calibrated correctness guarantee.
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

The last command performs eight live checks using synthetic work, including navigation versus task delivery, specialized harness selection, watches, unsupported operations and positive/negative semantic matching. It never executes app actions. It consumes a small amount of OpenRouter usage and requires the service above.

The recorded run passed all eight cases in approximately 0.4–1.4 seconds per check. Every supported case selected the expected action; the unsupported destructive request abstained. Only the navigation case was eligible for automatic execution in this conservative run. The other choices stayed reviewable, and the check script executed no app actions. These are smoke checks, not an accuracy benchmark or a latency guarantee. See [the live results](../../artifacts/command-bar/live-checks.txt).

```sh
cd desktop
flutter test --no-pub --concurrency=2 \
  test/command_bar_test.dart test/command_bar_catalog_test.dart \
  test/harness_command_bar_test.dart test/harness_start_page_test.dart \
  test/swarm_screen_test.dart test/swarm_interactions_test.dart \
  test/keymap_host_test.dart test/keymap_native_test.dart
```

Before merging into main, the full CLI suite passed **2,949 tests** (52 skipped), along with TypeScript type checking and the CLI build. The full desktop suite passed **1,955 tests** (2 skipped), with one failure in the unchanged `terminal_session_test.dart` recovery test: its 45 ms wall-clock wait expired before the final timer fired under load. Running that complete 57-test file separately passed, including the recovery case. The focused Flutter analyzer reported no issues, and the normal macOS debug build passed without experimental Dart defines.

The desktop run covers the default hidden shortcut, the disabled-feature path, unchanged pane navigation, cancellation, and typing through terminal refreshes. The native shortcut snapshot excludes the command bar binding when the feature is disabled. The terminal focus fix is a separate commit so the JEV feature can be reverted independently.

Set `HARNESS_COMMAND_CAPTURE_DIR` while running the widget tests to render screenshots. Tests cover cancellation, stale session identities, exact prompt delivery, duplicate submission, bounded context, watch scope, offline and blocked agents, keyboard entry, narrow layouts and large text.

The initial visible-home-page design is not part of the app. The experiment opens only with Cmd Shift J.
