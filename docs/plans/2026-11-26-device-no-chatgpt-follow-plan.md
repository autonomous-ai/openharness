# Harness Device no longer follows the ChatGPT app: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Harness Device stops following the ChatGPT app's window on macOS, Windows and Linux: no Follow ChatGPT
screen, no Accessibility request, no `{"thread"}` line on the watch's stdin. Release 0.1.15 carries it.

**Architecture:** Deletion inside `device-app/` only. The six follow modules go, with their wiring in the runner, the
reducer, the model, the types and `main.rs`; the dependencies and visibility they alone needed go back. The window loses
its third screen and the `allow` action. The app in front (`front*.rs`) and terminal tabs (`tabs*.rs`) stay as they
are. The CLI keeps accepting `{"thread"}` lines; removing that is a separate PR.

**Tech Stack:** Rust 2024 + Tauri 2 (`device-app/src-tauri`), TypeScript + Vitest + jsdom (`device-app/ui`), bash.

**Spec:** `docs/plans/2026-11-26-device-no-chatgpt-follow-design.md` (read it with this plan). PM decisions
(2026-11-26, for Diego): option B, off on every OS; the Follow screen and the Accessibility request go, so macOS asks for
no Accessibility; the CLI's `{"thread"}` handling is a separate follow-up PR; keep the task count small (three).

## Global Constraints

- Only `device-app/`, `desktop/design/desktop-design-system.md` and this plan change. No file under `cli/`.
- `Cargo.lock` is regenerated with `cargo check`, never `cargo update`; every later command uses `--locked`.
- Nothing left behind: no unused import, helper, constant or test double. `cargo test --locked` and `npx tsc --noEmit`
  print no warning from this crate or this UI.
- Kept as they are: the app in front (`front.rs`, `front_macos.rs`, `front_windows.rs`, and the behaviour of
  `front_x11.rs`, `front_sway.rs`, `front_hyprland.rs`), terminal tabs (`tabs.rs`, `tabs_macos.rs`), the bundle id,
  install paths, `Entitlements.plist` and `Info.plist`.
- An older `state.json` still loads: serde already ignores unknown keys (`Saved` has no `deny_unknown_fields`).
- Copy follows [the Naming System](../naming-system.md); comments say why.
- Platforms: macOS, Windows, Linux.

## What this plan decides from the spec's words

- **`tabs.rs` needs no change.** `follow.rs` imports `tabs::Out`, but `Out` was public since #4331 and the runner's tab
  thread keeps using it. The spec's "wiring in `tabs.rs`" is this import, which goes with `follow.rs`.
- **`watch.rs` changes too** (the spec does not list it): `Watch::thread`, added by #4508 for the title line, loses its
  only caller.
- **The visibility that goes back to private** is exactly what #4523 opened for the doors: `front_hyprland.rs`
  `next_line` and `ask`; `front_sway.rs` `SUBSCRIBE`, `GET_TREE`, `WINDOW_EVENT` and `pid`; `front_x11.rs`
  `property32` (back to one signature line, as rustfmt writes it). The other `pub` items in those files predate the
  doors and stay.
- **Dependencies:** `objc2-application-services` and `objc2-core-foundation` go, and so does the `libc` feature of
  `objc2-app-kit`, which #4508 added only for `follow_macos.rs`'s `processIdentifier` (no other file calls it). On
  Windows only the `Win32_Storage_Packaging_Appx` feature goes; `Win32_UI_Accessibility` stays (`front_windows.rs`'s
  WinEvent hook). The `windows-sys` comment loses "and the ChatGPT follow: …".
- **`Action` keeps four names** (`retry`, `sign_in`, `later`, `cancel`); `allow` becomes an unknown action that serde
  refuses.
- **No CI change.** No workflow names a follow test (`x11_live` is `front_x11.rs`'s). `scripts/ci-plan.py` selects
  `device-app`, `device-app-e2e`, `device-app-update`, `desktop` and `cross-read-scan` for this diff.

## Review Focus

1. A `state.json` written by 0.1.14 or older (`askedFollow`, `askedAx`, even `followOff`) loads with its other keys
   intact, and the next save drops all three. Task 1, `state.rs`.
2. A person who updates to 0.1.15 before answering Follow ChatGPT (on a Mac without Accessibility, `asked_follow`
   still false) sees nothing after Sign in, and no `chatgpt:` log line, on any OS. Task 1, `parity.rs`.
3. ChatGPT in front with the dial attached still writes its `{"front":"com.openai.codex"}` line, so the dial still
   shows ChatGPT's agents, and nothing more: no thread line, no `chatgpt:` log line. Task 1, `runner.rs` guard test.
4. A window that sends `allow` gets it refused like any other unknown action. Task 1, `types.rs`.
5. On Linux the app in front is still followed on X11, sway and Hyprland once the helpers are private again. Compiled
   only on Linux: PR CI's `device-app-checks` Linux leg and `linux.sh` in `device-app-e2e` (Verification).

## Task graph

| Task | Effort | Depends on | Files (all of them) |
| --- | --- | --- | --- |
| 1. The Rust side | xhigh | none | `device-app/src-tauri/Cargo.toml`, `Cargo.lock`, `src/{lib,main,runner,app,model,types,state,parity,watch,front_x11,front_sway,front_hyprland}.rs`, deleted `src/follow{,_macos,_windows,_x11,_sway,_hyprland}.rs` |
| 2. The window | high | none | `device-app/ui/src/{api,main,screens,gallery}.ts`, `device-app/ui/src/{api,screens,gallery}.test.ts` |
| 3. The docs and the e2e seed | medium | none | `device-app/AGENTS.md`, `device-app/RELEASE.md`, `desktop/design/desktop-design-system.md`, `device-app/scripts/e2e/macos.sh` |

No two tasks share a file and none needs another's output, so all three run at once. Longest chain: 1 task.

---

### Task 1: The Rust side

**Effort:** xhigh (the runner's threads and the saved state). **Depends on:** none.

**Files:**
- Delete: `device-app/src-tauri/src/follow.rs`, `follow_macos.rs`, `follow_windows.rs`, `follow_x11.rs`,
  `follow_sway.rs`, `follow_hyprland.rs`
- Modify: `device-app/src-tauri/Cargo.toml`, `device-app/src-tauri/Cargo.lock`
- Modify: `device-app/src-tauri/src/lib.rs`, `main.rs`, `runner.rs`, `app.rs`, `model.rs`, `types.rs`, `watch.rs`,
  `front_x11.rs`, `front_sway.rs`, `front_hyprland.rs`
- Test: `device-app/src-tauri/src/state.rs`, `parity.rs` (red first), plus the tests in `runner.rs`, `app.rs`,
  `model.rs`, `types.rs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Screen` = `Install | SignIn` (JSON `"install"`, `"sign_in"`); `Action` = `Retry | SignIn | Later | Cancel`;
  `Saved` = `{ version, cli_seen, asked_sign_in, login_item }` (JSON `version`, `cliSeen`, `askedSignIn`, `loginItem`);
  `Runner::polling_every(doors: Doors, send: Arc<dyn Fn(Event) + Send + Sync>, every: Duration) -> Runner` (test-only
  caller; `Runner::new` passes `POLL_EVERY`). Task 2's UI types mirror the first two.

- [ ] **Step 1: Write the failing state test** in `state.rs`'s tests, replacing
  `an_old_file_that_turned_follow_off_loads_and_follows`:

```rust
#[test]
fn an_old_file_with_the_follow_keys_loads_and_saves_without_them() {
    // 0.1.14 and before saved whether Follow ChatGPT and macOS's Accessibility prompt were asked; older still, a switch.
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("state.json"),
        concat!(
            r#"{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true,"askedFollow":true,"askedAx":true,"#,
            r#""followOff":true}"#
        ),
    )
    .unwrap();
    let log = Arc::new(MemoryLog::default());
    let file = JsonStateFile::new(dir.path().to_path_buf(), log.clone());
    let kept = Saved { cli_seen: true, asked_sign_in: true, login_item: true, ..Saved::default() };
    assert_eq!(file.load(), kept);
    assert!(log.lines().is_empty());
    file.save(&file.load()).unwrap();
    let written = fs::read_to_string(dir.path().join("state.json")).unwrap();
    for key in ["askedFollow", "askedAx", "followOff"] {
        assert!(!written.contains(key), "{written}");
    }
}
```

- [ ] **Step 2: Write the failing parity test** in `parity.rs`, against today's types (the door's answers are the four
  the runner told: macOS without and with the permission, every door off macOS, no door):

```rust
/// A first run, signed out: Sign in, then Later. Nothing shows after it, no menu row follows, nothing says `chatgpt:`.
#[test]
fn a_first_run_shows_nothing_after_sign_in_on_any_os() {
    for (trusted, gated) in [(false, true), (true, true), (true, false), (false, false)] {
        let seen = Saved { cli_seen: true, login_item: true, ..Saved::default() };
        let (mut app, mut effects) = App::new(seen, true, false, B, false);
        for event in [Event::StartDone { ok: true }, Event::Auth(Some(false)), Event::Follow { trusted, gated }] {
            effects.extend(app.handle(event));
        }
        assert_eq!(app.view().map(|view| view.screen), Some(Screen::SignIn), "{trusted} {gated}");
        effects.extend(app.handle(Event::Act(Action::Later)));
        assert_eq!(app.view(), None, "{trusted} {gated}");
        // no Effect::Menu item (Action or Check) whose label, lowercased, contains "follow"
        // no Effect::Log whose line starts with "chatgpt:"
    }
}
```

- [ ] **Step 3: Run both and see them fail**

Run (in `device-app/src-tauri`): `cargo test --locked --lib -- an_old_file_with_the_follow_keys a_first_run_shows_nothing`
Expected: both FAIL: the state test on `file.load()` (`asked_follow: true` kept), the parity test on
`(false, true)` (`Some(Screen::Follow)` after Later).

- [ ] **Step 4: Commit the red tests**

```bash
git add device-app/src-tauri/src/state.rs device-app/src-tauri/src/parity.rs
git commit -m "test(device-app): an old state.json drops the follow keys, and nothing follows Sign in on any OS (red)"
```

- [ ] **Step 5: Delete the follow doors and what only they used**
  - Delete the six `follow*.rs` files; their six `pub mod` lines go from `lib.rs`.
  - `main.rs`: `use harness_device::follow;` and the `follow:` field of `Doors`.
  - `watch.rs`: `Watch::thread` and its doc comment.
  - `front_hyprland.rs` `next_line`, `ask`; `front_sway.rs` `SUBSCRIBE`, `GET_TREE`, `WINDOW_EVENT`, `pid`;
    `front_x11.rs` `property32`: back to private (no `pub(crate)`).
  - `Cargo.toml`: remove the `objc2-application-services` and `objc2-core-foundation` lines and their comment, the
    `libc` feature of `objc2-app-kit`, the `Win32_Storage_Packaging_Appx` feature, and "and the ChatGPT follow: its
    window's title and its package family" from the `windows-sys` comment. Then `cargo check` (never
    `cargo update`) to rewrite `Cargo.lock`.

- [ ] **Step 6: Delete the runner's follow thread** (`runner.rs`, non-test)
  - The `crate::follow` import; `Doors::follow`; `Shared::chatgpt`; `struct Chatgpt`, `ChatgptState`, `enum Step` and
    `impl Chatgpt`; `Shared::follow_chatgpt` and `Shared::heard`.
  - `polling_every` loses its `trust_again` parameter, the follow door's `start`, the first `tell` and the follow
    thread's spawn; `Runner::new` calls `Runner::polling_every(doors, send, POLL_EVERY)`.
  - Every `chatgpt.tell(...)` beside a `tabs.tell(...)` (in `run`'s `StopWatch`, and in `spawn_watch`: the number, the
    watch's `WatchLine` and `WatchExit`, the spawn error), `front_changed`'s permission read and `chatgpt.tell`, the
    `Effect::AskAx` and `Effect::OpenAxSettings` arms, and `chatgpt.end()` in `Drop` (its comment: the tab thread only).
  - `spawn_watch`'s tuple of clones drops `chatgpt`.

- [ ] **Step 7: Delete the reducer's, model's and types' follow state**
  - `types.rs`: `Saved::asked_follow`, `Saved::asked_ax` (and in `Default`); the `state.json` doc lists
    `version`, `cliSeen`, `askedSignIn`, `loginItem` and says the keys of the Claude Code and Codex offers and of
    Follow ChatGPT (`askedFollow`, `askedAx`, `followOff`) an older app wrote are ignored. `Screen::Follow`,
    `Action::Allow` (doc: four names), `AppState::follow`, `FollowState`, `Event::Follow`, `Effect::AskAx`,
    `Effect::OpenAxSettings`.
  - `model.rs`: `due` ends after Sign in (`None`); its doc names install then sign-in only.
  - `app.rs`: `follow_said`; the `Event::Follow` arm; in `WindowClosed` the Follow comments (closing Sign in is its
    Later; any other screen closes); `forget_unanswered`'s `Screen::Follow` arm and its doc's Follow clause; `act`'s two
    `Screen::Follow` arms; `view_of`'s `Screen::Follow` arm; `show`'s `asked_follow` remembering and its comment.

- [ ] **Step 8: Bring the tests to the new types**
  - `parity.rs`: the red test loses its door loop and the `Event::Follow` event (one run, the same assertions);
    `follow_shown`, `only_macos_without_the_permission_asks_and_no_menu_has_a_follow_item`,
    `on_windows_the_door_is_always_trusted_and_asks_nothing`, the `crate::follow` import, and the module doc's Follow
    sentence go; `the_one_os_property_of_the_rules_is_install_exits_app`'s script loses its three follow events.
  - `state.rs`: `an_old_file_without_the_follow_keys_keeps_asked_sign_in` and `the_follow_keys_read_back` go.
  - `types.rs`: `a_view_is_the_json_the_window_reads` loses its `Screen::Follow` line;
    `the_window_may_ask_five_things` becomes `the_window_may_ask_four_things` with `json!("allow")` among the refused;
    `state_json_keys` has the four keys.
  - `model.rs`: `following`, the follow dimension of `states()` (and its doc), `no_menu_has_a_follow_item`,
    `the_follow_screen_is_due_after_install_and_sign_in_once_on_macos_without_the_permission`, and the "Following has
    no row" loop go.
  - `app.rs`: `SEEN` loses two fields; `a_follow_screen_open_at_the_relaunch_is_asked_again_by_the_new_process`,
    `a_follow_screen_answered_after_a_held_install_that_failed_is_not_asked_again`, and every test from
    `the_follow_screen_shows_at_the_first_launch_on_macos_without_the_permission_and_is_remembered` to
    `only_allow_and_not_now_act_on_the_follow_screen` go, with `follow_offer`, `follow`, `on_follow` and any helper
    (`attached`, `signed_in`, `saves`) left with no caller.
  - `runner.rs` tests: the `crate::follow` import, `AGAIN`, `FIX_LOGIN`, `World::known_installed`, `world_following`,
    `doors()`'s `follow` field, `follow()`, `title()`, the `ChatgptDoor` double with its `DoorCalls`/`DoorState`,
    `allow_asks_macos_and_the_settings_open_with_one_fixed_argument`, the two Ax effects in
    `the_binary_gets_its_four_effects_back`, and every test from
    `the_chatgpt_title_is_written_to_the_watch_with_chatgpt_in_front_the_dial_attached_and_the_permission` to
    `the_follow_thread_ends_with_the_runner` (with `skipped` and `SKIPPED`) go. `world_where` calls
    `Runner::polling_every(doors, send, EVERY)`.
  - `runner.rs` gets one guard test, which keeps `CHATGPT_LINE`:

```rust
#[test]
fn chatgpt_in_front_is_its_front_line_and_nothing_more() {
    let (w, _fronts) = world_in_front_of("com.openai.codex");
    w.fake.script("hardware watch --json", &ATTACHED);
    assert_eq!(w.answer(Effect::SpawnWatch), a_dial());
    assert_eq!(w.answer(Effect::StopWatch), Event::WatchExit(Some(0)));
    assert_eq!(w.fake.stdin(), [CHATGPT_LINE]);
    assert!(w.fake.log().lines().iter().all(|line| !line.starts_with("chatgpt:")));
}
```

- [ ] **Step 9: Check nothing of follow is left**

Run (in `device-app/src-tauri`):
`grep -rnE "follow::|FollowState|FollowDoor|Chatgpt|AskAx|OpenAxSettings|AX_SETTINGS|asked_follow|asked_ax|Screen::Follow|Action::Allow|chatgpt:|\.thread\(" src`
Expected: only the `"chatgpt:"` assertions of the parity test and the runner guard test.

- [ ] **Step 10: Run every rule on this Mac** (the PM's slot; `ui/dist` built by `cd ../ui && npm ci && npm run build`)

Run: `cargo test --locked`
Expected: PASS, 0 failed, no warning from `harness-device`, `Cargo.lock` unchanged by the run.

- [ ] **Step 11: Commit**

```bash
git add -A device-app/src-tauri
git commit -m "fix(device-app): Harness Device no longer follows the ChatGPT app, and asks for no Accessibility"
```

---

### Task 2: The window

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `device-app/ui/src/api.ts`, `main.ts`, `screens.ts`, `gallery.ts`
- Test: `device-app/ui/src/screens.test.ts`, `gallery.test.ts` (red first), `api.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks; mirrors Task 1's `Screen` and `Action`.
- Produces: `type Screen = 'install' | 'sign_in'`; `type Action = 'retry' | 'sign_in' | 'later' | 'cancel'`.

- [ ] **Step 1: Write the failing tests**
  - `screens.test.ts`, `a screen Rust no longer sends draws nothing`: add `['follow', 'offer']` to its list.
  - `gallery.test.ts`: `CONTRACT_PAIRS` without `'follow.offer'`; `expect(STATES).toHaveLength(9)`.

- [ ] **Step 2: Run them and see them fail**

Run (in `device-app/ui`): `npx vitest run src/screens.test.ts src/gallery.test.ts`
Expected: FAIL: `follow.offer` draws a screen; the gallery has 10 states.

- [ ] **Step 3: Commit the red tests**

```bash
git add device-app/ui/src/screens.test.ts device-app/ui/src/gallery.test.ts
git commit -m "test(device-app): the window draws no Follow ChatGPT screen, and the gallery has none (red)"
```

- [ ] **Step 4: Remove the screen**
  - `api.ts`: `Screen` and `Action` as in Interfaces.
  - `screens.ts`: the `'follow.offer'` face; `Button.focused` and its comment; the focus is
    `face.buttons.find((button) => button.primary)`, and the comment above it keeps "Return takes the primary answer"
    and "A screen without one focuses nothing" (no "unless another button takes the focus"); the file's first comment
    names two screens, Install and Sign in.
  - `main.ts`: the close comment reads "which Rust answers as Sign in's Later".
  - `gallery.ts`: the `Follow ChatGPT · offer` state.

- [ ] **Step 5: Bring the other tests to it**
  - `api.test.ts`: `sends Allow by its name` goes.
  - `screens.test.ts`: `follow: Allow, Not now` goes; the `['follow', 'offer', 'Allow']` row goes; the Follow part of
    `a screen reader hears a failure, and what the focused button answers` goes; the focus test is named
    `the primary button has the focus on every screen that has one, and no other button` and loses its Follow part.

- [ ] **Step 6: Run the window's checks**

Run (in `device-app/ui`): `npm test && npm run typecheck && npm run gallery`
Expected: all PASS; `grep -rn "follow\|allow\|Allow" src` prints only the `['follow', 'offer']` entry of the
"no longer sends" test.

- [ ] **Step 7: Commit**

```bash
git add device-app/ui/src
git commit -m "fix(device-app): the window has no Follow ChatGPT screen"
```

---

### Task 3: The docs and the e2e seed

**Effort:** medium. **Depends on:** none. No behaviour changes, so no failing test; one commit.

**Files:**
- Modify: `device-app/AGENTS.md`, `device-app/RELEASE.md`, `desktop/design/desktop-design-system.md`,
  `device-app/scripts/e2e/macos.sh`

- [ ] **Step 1: `device-app/AGENTS.md`**
  - Intro: "offers sign-in once and, with the ChatGPT app, follows its window … never on GNOME or KDE on Wayland." becomes
    "offers sign-in once"; "the window's three screens" becomes "the window's two screens". The Accessibility naming
    sentence stays (it is why the app is named Harness Device).
  - Fixed arguments: "one of five action names (`retry`, `sign_in`, `later`, `cancel`, `allow`)" becomes four, without
    `allow`; the "On macOS, System Settings' Accessibility list: `open x-apple.systempreferences:…`" item goes.
  - "The app in front is private": the sentence about `chatgpt: skipped · no permission` goes.
  - The bullets "The ChatGPT window's title is private as a tty", "What Accessibility reads" and "What the other doors
    read" go.
  - "One entitlement": "Accessibility needs none." goes.

- [ ] **Step 2: `device-app/RELEASE.md`**: "shows its Sign in or Follow ChatGPT screen again" becomes "shows its Sign
  in screen again".

- [ ] **Step 3: `desktop/design/desktop-design-system.md`, Harness Device section**
  - "it offers sign-in and, with the ChatGPT app, follows its window." becomes "it offers sign-in."
  - "has three screens, Install, Sign in and Follow ChatGPT," becomes "has two screens, Install and Sign in,".
  - Focus: "Return takes the primary button, as a dialog's default. A screen with only `Cancel` focuses nothing."
  - The "Follow ChatGPT asks once, on macOS only …" bullet goes.
  - Windows and Linux differences: the "ChatGPT is always followed, with no screen …" bullet goes.
  - The gallery that pairs with this section is `device-app/ui/src/gallery.ts` (Task 2).

- [ ] **Step 4: `device-app/scripts/e2e/macos.sh`**: the seed is
  `{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}` and its comment reads "cliSeen, askedSignIn and
  loginItem: nothing is installed, no window opens and no login item is registered." (the Accessibility sentence goes).

- [ ] **Step 5: Check**

Run: `grep -nE "ChatGPT|Accessibility|askedFollow|chatgpt:|\`allow\`" device-app/AGENTS.md device-app/RELEASE.md device-app/scripts/e2e/macos.sh`
and `ChatGPT|Accessibility|Allow` in the design doc's Harness Device section.
Expected: only AGENTS.md's naming sentence ("two apps named Harness sat side by side in Accessibility"); none in the
design doc's section.

- [ ] **Step 6: Commit**

```bash
git add device-app/AGENTS.md device-app/RELEASE.md desktop/design/desktop-design-system.md device-app/scripts/e2e/macos.sh
git commit -m "docs(device-app): Harness Device has two screens and follows no ChatGPT window"
```

---

## Verification

Every check runs against the fake CLI (`device-app/src-tauri/tests/fake-harness`), with no backend and no account:
the e2e drivers make their own temporary home, data folder and state. Nothing touches production or a real person's
login.

1. **PR CI, selected by `scripts/ci-plan.py` for this diff** (it says so for these paths):
   - `device-app` (`device-app-checks`): Linux runs `npx tsc --noEmit`, `npx vitest run`, `npm run build`,
     `cargo test --locked` and the `x11_live` front test; Windows runs `cargo test --locked`. Windows is where the
     `Win32_Storage_Packaging_Appx` drop compiles, Linux where the private `front_*` helpers do.
   - `device-app-e2e`: `linux.sh` on the x64 and arm64 AppImages (a fake tray host, X11, sway and a scripted
     Hyprland: the app in front still followed, Review Focus 5) and `windows.ps1` on the x64 and arm64 NSIS installers.
   - `device-app-update`: `update-pair.sh` and each driver's update path (the Cargo files changed).
   - `desktop`: the design doc changed. `cross-read-scan`.
   - `device-app-desktop` and `device-app-install` are not selected: none of their paths change.
2. **Local Mac gate** (macOS, this Mac, on the PM's slot): in `device-app/ui` `npm ci && npm run build`, then in
   `device-app/src-tauri` `cargo test --locked`. Expected: 0 failed, no warning from `harness-device`. This is the only
   place the macOS dependency drop compiles. Record it in the pull request.
3. **The gallery, by eye** (a person, on any machine): `cd device-app/ui && npm run gallery`, open `ui/gallery.html`:
   nine states per theme, Install and Sign in only, the Sign in offer the one focused frame.
4. **`macos.sh`: not needed.** Install (`install.rs`), start (`harness start`, the login item, the keep-alive) and the
   app in front (`front_macos.rs`) do not change; the runner's start only loses the follow door's start. The one
   `macos.sh` change is its seed's ignored key, which Task 1's state test proves loads.

## Open questions

None.
