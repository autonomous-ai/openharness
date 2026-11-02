# Web new-version notice Implementation Plan

> **For agentic workers:** Work task by task, test first (project instructions, revision 26: Engineer role, not subagent-driven-development). Steps use checkbox (`- [ ]`) syntax. There is no Execution Handoff: the Engineer goes on to implement.

**Goal:** An open Harness web page says so within minutes of a new web release ("A new version of Harness is ready." with Reload), Reload loads the new build, and the account menu shows the running version ("Harness X.Y.Z").

**Architecture:** The host already serves `release.json` (`no-store`, written by `scripts/build-web-release.sh`, read at start-up by `webReleaseVersion` for the running version). A new `WebUpdateWatcher` re-reads it every few minutes and when the tab comes back to the front, and says "new" when it names a version other than the one this page started with. A quiet bar at the top of the page (`WebUpdateFrame`, inside the store frame, above the app) shows it; Reload clears any old service worker and its caches, then reloads. The account menu takes the running version as an optional line, given only by the web build. Desktop (native) draws and does nothing new.

**Tech Stack:** Flutter web (`desktop/`), `package:web`, `flutter_test`.

**Spec:** Task #2185 (Huy). Mockup posted in the project chat: a bar "A new version of Harness is ready.    Reload", and "Harness 1.3.51" under Settings · Sign out in the account menu. No server or website change: the website's `release.json` and `index.html` are already `no-store` (`website/next.config.js`), and releases already start no service worker (`website/scripts/harness-web-assets.mjs`).

## Global Constraints

- The pull request body starts with: `Requested by phamngochuy.1989@gmail.com through Harness.`
- Web only; Desktop unchanged: the native app shows no bar and no version line, and runs no timer.
- A change people see follows the Harness design language (the quiet bar matches the store bar's surface and type).
- Before each web release a Tester checks the web build in Safari in the iPhone simulator on Tony's Mac (keyboard, top bar) and in a desktop browser.
- Copy exactly: "A new version of Harness is ready." / "Reload" / "Harness X.Y.Z".

## Review Focus

- A release.json that cannot be read (offline, 404, odd body) never shows the bar and never clears one already shown.
- The same version shows nothing; a different one (a newer release, or a rollback) shows the bar once, however many checks follow.
- A page that could not tell its own version at start-up never shows the bar (it would show for every release).
- The bar must not remount the app below it, and must not sit under a phone's top inset or the store bar.
- Reload with an old service worker or cache registered still loads the new build.
- Desktop's account menu is unchanged (no version line unless the web gives one).

---

### Task 1: The watcher

**Files:**
- Create: `desktop/lib/web/update/web_update_watcher.dart`
- Test: `desktop/test/web_update_watcher_test.dart`

**Interfaces:**
- Produces: `class WebUpdateWatcher extends ChangeNotifier { WebUpdateWatcher({required String? running, required Future<String?> Function() readLatest, Duration every = const Duration(minutes: 5)}); bool get updateReady; Future<void> check(); void start(); void dispose(); }`

- [ ] **Step 1: Write the failing tests** `a different version is ready, the same one is not`, `an unreadable manifest changes nothing, before or after the bar shows`, `a page that does not know its own version never says ready`, `it checks again every interval until disposed`, `many checks tell listeners once`.
- [ ] **Step 2: Run, expect FAIL** (`cd desktop && flutter test --no-pub test/web_update_watcher_test.dart`): file missing.
- [ ] **Step 3: Implement** `WebUpdateWatcher` with `Timer.periodic`; `updateReady` is latched true once a read names a version different from `running`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 2: The bar

**Files:**
- Create: `desktop/lib/web/update/web_update_bar.dart` (`WebUpdateFrame`, `WebUpdateBar`)
- Modify: `desktop/lib/web/web_entry.dart` (`appFrame`)
- Test: `desktop/test/web_update_bar_test.dart`

**Interfaces:**
- Consumes: Task 1.
- Produces: `WebUpdateFrame({required WebUpdateWatcher watcher, required VoidCallback reload, required Widget child})`; keys `web-update-bar`, `web-update-reload`.

- [ ] **Step 1: Write the failing tests**: ready shows the bar with the exact words and Reload calls `reload` once; not ready shows nothing; the child's state survives the bar appearing; the bar is a quiet strip in the store bar's colors.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the frame (one Column shape whether or not the bar shows, `SafeArea(bottom: false)` on the bar, `MediaQuery.removePadding(removeTop: true)` for the child while it shows); wire it in `appFrame` inside `WebAppStoreFrame`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 3: The account menu's version

**Files:**
- Modify: `desktop/lib/widgets/account_menu.dart`, `desktop/lib/screens/swarm_screen.dart` (`_showAccountMenu`)
- Test: `desktop/test/account_menu_version_test.dart`

**Interfaces:**
- Produces: `AccountMenu(version: String?)` and `showAccountMenu(version:)`; key `account-menu-version`, text `Harness $version` under the last row.

- [ ] **Step 1: Write the failing tests**: with a version the menu says "Harness 1.3.51"; with none (Desktop) there is no such line.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; `swarm_screen.dart` passes `declaredAppVersion` only when `kIsWeb`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 4: Reload that really loads the new build, and the timer

**Files:**
- Modify: `desktop/lib/web/parts/page_reload_web.dart`, `desktop/lib/web/parts/page_reload.dart`, `desktop/lib/web/web_entry.dart`
- Test: `desktop/test/web/web_reload_test.dart` (browser)

**Interfaces:**
- Produces: `Future<void> reloadForNewVersion()`: unregisters every service worker and deletes every cache of the page, then reloads; native is a no-op. The watcher is started in `appFrame` and also checks when the tab turns visible.

- [ ] **Step 1: Write the failing browser test**: with a service worker registration and a cache present, `reloadForNewVersion` removes both before the reload it asks for (reload injected).
- [ ] **Step 2: Run, expect FAIL** (`flutter test --platform chrome test/web/web_reload_test.dart`).
- [ ] **Step 3: Implement** with `package:web`; each step in try/catch so a refusal still reloads.
- [ ] **Step 4: Run, expect PASS; then the whole `test/web` and `analyze`.**
- [ ] **Step 5: Commit** test, then code.
