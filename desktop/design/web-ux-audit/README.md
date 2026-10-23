# Harness web: UX audit

This audit covers every screen of the Harness web app (the Flutter web build of `desktop/`,
`lib/web/web_entry.dart`, served at harness.autonomous.ai/harness-web) on phones, a tablet
and a computer. It records what a person can reach, what goes wrong, and how the fixes could
be split. It changes no product code.

- **Source revision:** audited on branch `super-tab/fc53732c35338a2ea34cb592` (`a521af922`),
  from `main` at `d763e16d6`. The review tooling then moved to `main` (`desktop/tool/web_ux/`).
- **Evidence:** every screenshot here comes from the no-login review fixture, which renders
  the real widgets with fake data. A live pass against the owner's account did not run;
  see [Live pass](#live-pass). Every finding is tagged **fixture**, and also says whether
  the problem is in the **widget code** (it would appear with real data) or in the
  **fixture data** (needs a live check).
- **Widths:** 360×740 (Android phone), 390×844 (iPhone), 768×1024 (iPad mini) and
  1440×900 (computer, mouse). Phones and the tablet are emulated with touch, a mobile user
  agent and the platform their browser reports, so Flutter sees iOS or Android and the
  store bar shows, as it does on a real phone. All widths are captured in dark
  (Graphite, the default a new user sees). 390 and 1440 are also captured in light (Paper).

## Contents

1. [How to reproduce](#how-to-reproduce)
2. [Inventory](#inventory)
3. [Not reachable on web](#not-reachable-on-web)
4. [Findings](#findings): [blocks](#blocks), [slows](#slows), [polish](#polish)
5. [Cross-cutting checks](#cross-cutting-checks)
6. [First load](#first-load)
7. [Unverified](#unverified)
8. [Proposed fix groups](#proposed-fix-groups)
9. [Live pass](#live-pass)
10. [Pre-existing issues](#pre-existing-issues)

## How to reproduce

The screenshots this README links to are on the audit branch
(`super-tab/fc53732c35338a2ea34cb592`, revision `a521af922`), not on `main`, so `main` does not
carry 11 MB of images. Every `screens/…` and `checks/…` link opens that revision on GitHub.
The baseline results it was written from are here: `checks.json` and `load-time.json`.

Run from `desktop/`:

```bash
# The whole app, signed in as a fake account; ?scenario= picks the state.
flutter build web --no-web-resources-cdn --dart-define=HARNESS_TEST=true \
  -t tool/web_ux_fixture.dart -o /tmp/web-ux
# The Super Tab, from PR #1570's fixture; ?theme=dark is the Graphite theme.
flutter build web --no-web-resources-cdn --dart-define=HARNESS_TEST=true \
  -t tool/super_tab_mobile_fixture.dart -o /tmp/web-ux-super-tab

# Playwright is not a dependency of this repository: install it once outside it.
pnpm --dir ~/.cache/web-ux-playwright add playwright
export PLAYWRIGHT_DIR=~/.cache/web-ux-playwright      # CHROME_PATH may name an installed Chromium

node tool/web_ux/capture.mjs /tmp/web-ux out                          # out/screens/<flow>/<width>-<theme>.png
FIXTURE=super-tab node tool/web_ux/capture.mjs /tmp/web-ux-super-tab out   # the super-tab-* flows
node tool/web_ux/checks.mjs /tmp/web-ux out                           # tap sizes, wheel, swipe, hover, focus
flutter build web --release --no-wasm-dry-run --no-web-resources-cdn \
  --base-href=/harness-web/ -o /tmp/web-release
node tool/web_ux/load-time.mjs /tmp/web-release out                   # first load, three network profiles
```

| File | What it is |
| --- | --- |
| `tool/web_ux_fixture.dart` | Runs the real `HarnessApp` (store bar, `RootShell`, browser workspace) on a fake account |
| `tool/web_ux_scenarios.dart` | Merges every fix group's scenarios into the `?scenario=` names |
| `tool/web_ux/scenarios/<group>.dart` | One file per fix group (`menus`, `store`, `first_computer`, `first_load`, `pane`, `welcome`, `states`) plus `base`: the state each scenario seeds |
| `tool/web_ux_seed.dart` | Fake person, computers, tabs and terminal text |
| `test/support/web_ux_app.dart` | The fake `AppNotifier`: never signs in, reads or dials; API base is a closed loopback port |
| `test/web_ux_app_test.dart` | Its test |
| `tool/web_ux/flows/<group>.mjs` | One file per fix group, same keys: each flow is a scenario plus the clicks a person makes, by accessible name. `load-flows.mjs` reads every file in the folder |
| `tool/web_ux/capture.mjs`, `serve.mjs` | Screenshots; blocks every request that leaves the page (`blocked*.json` is empty) |
| `tool/web_ux/checks.mjs` | Cross-cutting interaction checks, results in `checks.json` and `checks/` |
| `tool/web_ux/load-time.mjs` | First load of a release build; results in `load-time.json` |
| `tool/web_ux/playwright.mjs` | Finds Playwright in `PLAYWRIGHT_DIR` |

A fix group adds its scenarios and flows to its own two files and edits nothing else; a name
used by two groups stops the fixture or the capture with an error. Flow names are the audit's,
unchanged.

Flows reach dialogs and panels by clicking through the accessibility tree, the way a person
does. A flow that cannot be clicked through is recorded as failed in `captures*.json`
instead of being opened in code.

## Inventory

Every screen and state a web user can reach, with its source and its screenshots under
[`screens/<flow>/`](https://github.com/autonomous-ai/openharness/tree/a521af922/desktop/design/web-ux-audit/screens) on the audit branch (`360-dark`, `390-dark`, `390-light`, `768-dark`, `1440-dark`,
`1440-light`). "Web" means the widget lives in `lib/web/`; everything else is shared with the
Desktop app. A few controls exist only at some widths, so their flows do too:
- **Phone only (below 720 px):** the tab switcher, the footer dropdown and the Super Tab
  conversations drawer.
- **768 and 1440 only:** a tab's right-click, the Add Phone button and the footer's Harness
  Monitor count. On phones, Add phone is not in the menu, and the Harnesses count sits
  inside the footer dropdown.

### Before the workspace

| Screen or state | How a person gets there | Source | Flow |
| --- | --- | --- | --- |
| Store bar ("Get the app") | Any page on an iPhone, iPad or Android browser | `lib/web/shell/web_store_banner.dart` (web) | every phone and tablet capture |
| Sign-in | Signed out | `lib/screens/login_screen.dart` `_webPage` | `signin` |
| Sign-in, waiting for Google or Apple | After a sign-in button | same, `_Action` | `signin-waiting` |
| Sign-in, error | A failed sign-in | same, `_ErrorTile` | `signin-error` |
| Sign-in, session expired | The server refused the saved session | same | `signin-expired` |
| Sign-in with a phone, QR | Scan with your phone (computer widths only) | same | `signin-qr` |
| Sign-in with a phone, confirm account | The phone approved | same | `signin-confirm` |
| Starting up | Opening the app | `lib/widgets/bootstrapping_screen.dart` | `booting` |
| Connect a computer (no computer yet) | Signed in, no computer on the account | `lib/web/onboarding/web_first_machine.dart` (web) | `first-machine` |
| Before the machine list answers | First seconds after sign-in | `lib/widgets/harness_start_page.dart` | `first-machine-loading` |
| Connect your computer, one ready | A computer waits for this browser | `lib/web/onboarding/web_your_computers.dart` (web) | `link-machine` |
| Your computers: offline, ready, removed | Several computers, none connected | same, `ComputerLinkState` | `computers` |
| Connect, then refused | Connect on a computer that does not trust this browser | same | `link-password` |
| Only computer offline | The one connected computer goes offline | `web_first_machine.dart` replaces the workspace | `offline-only` |
| Shared harness link `/s/…` | A link someone sent | `lib/sharing/shared_agent_page.dart` | `shared-link` |
| Viewer link `/?viewer=1&machine=&agent=` | `hn view` | `lib/viewer/viewer_page.dart` | `viewer-page` |
| Incomplete viewer link `/?viewer=1` | A cut-off `hn view` link | `lib/app_shell.dart:384-389` | `viewer-incomplete` |

### Workspace

| Screen or state | How a person gets there | Source | Flow |
| --- | --- | --- | --- |
| Workspace, three panes / one pane | Signed in with a connected computer | `lib/screens/swarm_screen.dart`, `lib/widgets/pane_grid.dart`, chrome from `lib/web/shell/web_chrome.dart` (web) | `workspace`, `workspace-one` |
| Phone layout: one pane, tab switcher, footer dropdown | Any width under 720 px | `lib/web/tabs/web_tab_switcher.dart`, `lib/web/footer/web_footer_bar.dart` (web) | every 360/390 capture |
| Many tabs (tab row scrolls) | 16 tabs | `swarm_screen.dart` tab row, `WorkspaceTabScroller` | `many-tabs` |
| Tab switcher (phone) | Tap "1:code · 3/3" | `lib/web/tabs/web_tab_switcher.dart`, `web_tab_menu.dart` (web) | `tab-switcher` |
| Right-click on a tab (computer) | Right-click a tab | `lib/widgets/desktop_workspace_tab.dart:202-243` | `tab-menu` |
| App menu | ☰ | `lib/web/shell/web_app_menu.dart`, `web_menu_items.dart` (web) | `app-menu` |
| Footer dropdown (phone) | Tap the machine name at the bottom | `lib/web/footer/web_footer_bar.dart` (web) | `footer-menu` |
| New tab page | + (or a first tab with no panes) | `lib/widgets/workspace_welcome.dart`, `lib/widgets/harness_start_page.dart` | `new-tab`, `empty-tab` |
| Error banner with Retry | A launch or sign-in failure | `swarm_screen.dart` (~7990-8080) | `error-banner` |
| New device band | Another device joined the account | `lib/widgets/new_device_notice.dart` | `new-device` |
| Notifications | Bell | `showNotificationInbox` | `notifications` |
| Open Harness (picker) | Search icon | `lib/widgets/swarm_switcher.dart`, `desktop_search_panel.dart` | `open-harness` |
| Agent picker | Pane header, agent name | same picker, Agents | `agent-picker` |
| Model and subscription picker | Pane header, model name | same picker, Models; `lib/models/models_panel.dart` | `model-picker`, `models` |
| Machines | Menu ▸ Machines | `lib/widgets/machines_panel.dart` | `machines` |
| History | Menu ▸ History | `swarm_screen.dart` navigation history | `history` |
| All commands | Menu ▸ All commands | `swarm_screen.dart` `_searchCommands` | `all-commands` |
| Appearance panel | Menu ▸ Appearance | `lib/widgets/harness_customize_pane.dart` | `appearance` |
| New Harness form (Split pane) | Menu ▸ Split pane | `lib/widgets/new_harness_form.dart` | `split-pane` |
| Add your phone | Phone icon (computer widths) | `showAddPhoneDialog` | `add-phone` |
| Harness Monitor | Footer "Harnesses 4" | `lib/state/harness_monitor_controller.dart` | `harness-monitor` |
| Store, Store product page | Store icon (computer) or Menu ▸ Store (phone) | `lib/store/store_screen.dart` | `store`, `store-product` |

### Terminal panes

| State | When | Source | Flow |
| --- | --- | --- | --- |
| Connected | Normal | `lib/widgets/terminal_panel.dart` | `workspace` |
| Connecting (session opening) | Opening a terminal | `terminal_panel.dart:2741-2770` | `opening` |
| Computer connecting / reconnecting | The relay is (re)dialling | `pane_grid.dart` header, tab status icon | `connecting`, `reconnecting` |
| Computer offline (another one still connected) | The computer went to sleep | `pane_grid.dart:1708-1860` | `offline` |
| View only | A terminal this browser may watch but not type into | `TerminalSession.readOnly` | `view-only` |
| Another app took control | Opened elsewhere | `terminal_panel.dart` `_ControlBanner` | `taken-over` |
| Error, Reconnect | The session failed | `terminal_panel.dart` | `terminal-error` |

### Settings

Menu ▸ Settings: a screen with a rail on a computer, a list then a page on a phone
(`lib/settings/settings_screen.dart`, `settings_compact.dart`).

| Section | Source | Flow |
| --- | --- | --- |
| Account | `settings/sections/account_section.dart` | `settings-account` |
| Appearance (opens the panel) | `harness_customize_pane.dart` | `settings-appearance` |
| Notifications | `settings/sections/` alerts | `settings-notifications` |
| Privacy (web only) | `settings/sections/` privacy | `settings-privacy` |
| Keyboard shortcuts | `lib/shortcuts/shortcuts_browser.dart` | `settings-keyboard-shortcuts` |
| Usage (browser activity only) | `settings/sections/usage_section.dart:122` | `settings-usage` |
| Routing | `settings/sections/` routing | `settings-routing` |
| Tab invites | `settings/sections/tab_invites_section.dart` | `settings-tab-invites` |
| Experimental | `settings/sections/` experimental | `settings-experimental` |
| About | `settings/sections/` about | `settings-about` |

### Super Tab

From `tool/super_tab_mobile_fixture.dart` (the real `SuperTabView`, `lib/super_tabs/view.dart`,
on PR #1570's fake backend). On the web it is reached from Recent Swarms or a tab invite.

| State | Flow |
| --- | --- |
| Lead conversation with projects, people, machines | `super-tab` |
| A work group needing a person, with an unconfirmed delivery | `super-tab-group` |
| One project | `super-tab-one` |
| No projects | `super-tab-empty` |
| Viewer (read only) | `super-tab-viewer` |
| Backend unreachable | `super-tab-offline` |
| Conversations drawer (phone) | `super-tab-conversations` |
| Members and machines | `super-tab-roster` (at 1440 the roster is always open and has no button, so that capture's click is recorded as failed and shows it in place) |
| Group terminals, Pull requests | `super-tab-terminals`, `super-tab-pull-requests` |

## Not reachable on web

Each is switched off in code; the line is given so the claim can be checked.

| Screen | Why a web user never sees it |
| --- | --- |
| Environment check and setup | `lib/state/app_state.dart:5954`: `_prepareEnvironment` returns ready when `viewer != null` (always on web) |
| Setup tour, desktop sign-in step | `lib/state/app_state.dart:1300`: `signInStepShowing` is false when `viewer != null` |
| Update notice | `lib/state/app_state.dart:1136`: `updateChecksEnabled` needs `viewer == null` |
| Devices tab and its button | `lib/state/app_state.dart:2660`: `devicesEnabled => !kIsWeb && !kViewerMode` |
| Companions (creature, daemon talk) | `lib/screens/swarm_screen.dart:351-355`: `_creatureChoice` needs `app.viewer == null`. A Companions tab would show the text at `swarm_screen.dart:8320` ("available in Settings → Experimental", a switch that the web's Experimental page does not have); no web path creates such a tab |
| Account avatar menu | `lib/screens/swarm_screen.dart:3268`: `_accountControlShown => app.viewer == null`; the web app menu carries the email and Sign out instead |
| Finder | `lib/finder/finder_availability.dart:12`: `canOpenFinderOn` needs `!kViewerMode` |
| Settings ▸ Connectors | `lib/settings/settings_section.dart:110`: hidden when `kIsWeb` |
| In-window menu bar, Export logs, About dialog | Linux/Windows menu bar and the native menu only (`lib/app_shell.dart` `runAppMenuAction`); Settings ▸ Debug hides Export on web (`settings/sections/debug_toolbar.dart:35`) |

## Findings

Ranked by severity: **blocks** (a person cannot do the task), **slows** (they can, with
effort or confusion), **polish**. "Widget code" means the problem is in production widgets
and appears with any data; "fixture data" means it depends on the fake data and needs a live
check before fixing. Screenshot paths are relative to this folder.

Every finding is tagged **fixture**, because the live pass did not run.

### Blocks

#### B1 · The Store cannot be used on a phone
- **Screen, width:** Store and a Store product page · 360, 390. At 768 it is tight but usable.
- **Screenshots:** [`screens/store/360-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/store/360-dark.png), [`screens/store/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/store/390-dark.png), [`screens/store-product/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/store-product/390-dark.png)
- **Steps:** on a phone, Menu ▸ Store, then open Claude.
- **What goes wrong:** the Store keeps its computer layout. Its own left rail (Discover, All
  harnesses, Disciplines) takes about 45% of the screen, so the catalogue is ~150 px wide. Headings
  break one letter per line ("S t a r t w…"), and cards and the product page are squeezed into a
  strip.
- **Fix:** below 720 px, turn the Store rail into a row of chips or a dropdown above the content,
  and give the content the full width.
- **Files, size:** `lib/store/store_screen.dart`, `store_discover.dart` (shared). Add a
  `compactBelow` seam like Settings already takes from `WorkspaceChrome`; Desktop keeps
  today's layout. M.
- **Source:** widget code · fixture.

#### B2 · A Swarm cannot be created with a mouse or on a phone
- **Screen, width:** app menu, All commands, New tab page · all widths.
- **Screenshots:** [`screens/app-menu/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/app-menu/1440-dark.png), [`screens/all-commands/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/all-commands/1440-dark.png), [`screens/new-tab/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/new-tab/1440-dark.png)
- **Steps:** look for a way to start a new Swarm.
- **What goes wrong:** New Swarm (`super_tab.new`) is `hidden: true`
  (`lib/shortcuts/keymap_commands.dart:712-718`), so All commands does not list it. No menu or
  button runs it. The web runs it only from the keyboard (Alt+S), so a phone cannot start one at
  all. Recent Swarms only reopens a Swarm that already exists (`swarm_screen.dart:7871`).
  "Ctrl+Alt+S Build beyond code" on the New tab page opens the Store, not a Swarm.
- **Fix:** add **New Swarm** to the web app menu and the New tab page.
- **Files, size:** `lib/web/shell/web_menu_items.dart` (web only). S.
- **Source:** widget code (checked in code) · fixture.

### Slows

#### S1 · Tap targets under 44 px on phones
- **Screen, width:** app menu, tab switcher, footer dropdown, Machines actions, Settings back, pane
  header controls · 360, 390.
- **Screenshots:** [`screens/app-menu/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/app-menu/390-dark.png), [`screens/tab-switcher/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/tab-switcher/390-dark.png),
  [`screens/footer-menu/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/footer-menu/390-dark.png), [`screens/machines/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/machines/390-dark.png); measurements in `checks.json` (`tapTargets`).
- **Steps:** open any menu on a phone.
- **What goes wrong:** every phone screen has controls under 44 px (`checks.json`,
  `tapTargets`, 360 and 390): in the top bar, Menu 31×28, New Tab 23×28, Open Harness and
  Notifications 31×28; in the pane header, Close Pane 28×28 and the agent and model labels
  28 tall; app menu and footer dropdown rows 32 tall; tab switcher rows 40; Machines actions
  (Rename, Remove, Add machine, History…) 28; picker filter chips 32; Store Back and Forward
  32×30; New tab page rows 24; Settings rows and Back 38; New Harness form fields 32.
- **Fix:** on compact web, give menu rows and bar controls a 44 px minimum hit area. The
  visible size can stay as it is.
- **Files, size:** `lib/web/shell/web_app_menu.dart`, `web_menu_items.dart`,
  `lib/web/tabs/web_tab_menu.dart`, `lib/web/footer/web_footer_bar.dart`,
  `web_dropdown_control.dart` (web). The pane header and Machines pills are shared: use a seam
  (`WorkspaceChrome`) for their hit size. M.
- **Source:** widget code · fixture.

#### S2 · On phones and tablets the pane header hides the harness name and its state
- **Screen, width:** any pane · 360, 390, and 768 with three panes.
- **Screenshots:** [`screens/workspace/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/workspace/390-dark.png), [`screens/opening/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/opening/390-dark.png),
  [`screens/offline/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/offline/390-dark.png), [`screens/taken-over/360-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/taken-over/360-dark.png), [`screens/workspace/768-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/workspace/768-dark.png)
- **Steps:** open a harness on a phone.
- **What goes wrong:** the name shrinks to "Fix chec…" while "Claude Code Anthropic" keeps its
  full width. Status words that a computer shows ("Connecting", "Offline", "Take control")
  shrink to unlabelled icons. At 768 the three-column grid stays, so each pane is about 250 px
  and reads "Fix ch… Clau… Anth…".
- **Fix:** on compact web, put agent and model behind one menu and keep the status word. Between
  720 and ~1000 px, use at most two columns.
- **Files, size:** `lib/widgets/pane_grid.dart` pane header (shared), behind
  `WorkspaceChrome.compactPaneHeader` (read with `compactPaneHeaderAt(width)`): on for web,
  off for Desktop. M.
- **Source:** widget code · fixture.

#### S3 · A computer that is connecting or reconnecting shows only a ⊘ icon
- **Screen, width:** pane and tab · all widths.
- **Screenshots:** [`screens/connecting/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/connecting/1440-dark.png), [`screens/reconnecting/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/reconnecting/1440-dark.png), [`screens/reconnecting/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/reconnecting/390-dark.png)
- **Steps:** the relay drops while a terminal is open.
- **What goes wrong:** the terminal looks live and accepts focus. The only signal is a small ⊘
  beside the tab and pane names. Its meaning appears only in a tooltip, which phones never show.
  An offline computer gets a labelled "Offline" chip ([`screens/offline/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/offline/1440-dark.png)), but this
  state gets none.
- **Fix:** a "Reconnecting…" chip with the same look as "Offline", and dim the input until the
  connection is back.
- **Files, size:** `lib/widgets/pane_grid.dart` (shared), behind
  `WorkspaceChrome.labelsPaneStatus`: web only, Desktop unchanged (plan section 7, call 1). S.
- **Source:** widget code · fixture.

#### S4 · A view-only terminal does not say it is view only
- **Screen, width:** pane · all widths.
- **Screenshots:** [`screens/view-only/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/view-only/1440-dark.png), [`screens/view-only/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/view-only/390-dark.png)
- **Steps:** open a terminal this browser may watch but not control.
- **What goes wrong:** only the model name turns grey. Nothing says typing is off, and the cursor
  still blinks.
- **Fix:** a "View only" chip in the header, and a lock in place of the cursor.
- **Files, size:** `lib/widgets/pane_grid.dart`, `terminal_panel.dart` (shared). S.
- **Source:** widget code · fixture.

#### S5 · When the only computer goes offline, its panes give way to setup instructions
- **Screen, width:** workspace · all widths.
- **Screenshots:** [`screens/offline-only/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/offline-only/1440-dark.png), [`screens/offline-only/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/offline-only/390-dark.png);
  compare [`screens/offline/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/offline/1440-dark.png) (another computer still connected).
- **Steps:** have one computer and let it sleep.
- **What goes wrong:** the tab row stays, but the open terminals are replaced by "Connect your
  computer" and the install commands. The person loses the output they were reading and is
  shown set-up steps for a computer that is already set up. `SwarmScreen._needsFirstConnection`
  (`swarm_screen.dart:7389-7420`) treats an offline computer as no computer.
- **Fix:** show the first-computer page only to an account that has never connected one.
  Otherwise keep the panes in their Offline state, with a band reading "Studio Mac is offline".
- **Files, size:** `lib/web/onboarding/web_first_machine.dart` (web) and the
  `_needsFirstConnection` condition (shared, behind the existing `WorkspaceChrome.firstMachine`
  seam). S.
- **Source:** widget code · fixture.

#### S6 · First load shows a page and then replaces it
- **Screen, width:** after sign-in · all widths.
- **Screenshots:** [`screens/first-machine-loading/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/first-machine-loading/1440-dark.png), then [`screens/first-machine/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/first-machine/1440-dark.png)
- **Steps:** sign in on an account with no computer.
- **What goes wrong:** until the machine list answers, the New tab page shows (search, Quick
  start, Keyboard practice, Store cards, footer "Harnesses 0"). It then jumps to "Connect a
  computer".
- **Fix:** while `machineInventoryLoaded` is false, show the connect page's skeleton or
  "Finding your computers…".
- **Files, size:** `lib/web/onboarding/web_first_machine.dart` (web), `_needsFirstConnection`
  (shared seam). S.
- **Source:** widget code · fixture. How long the gap lasts needs a live check.

#### S7 · The New tab page sells keyboard chords to a mouse-first web
- **Screen, width:** New tab · all widths, phones included.
- **Screenshots:** [`screens/new-tab/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/new-tab/1440-dark.png), [`screens/new-tab/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/new-tab/390-dark.png), [`screens/empty-tab/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/empty-tab/390-dark.png)
- **Steps:** press +.
- **What goes wrong:** "Harness like a boss." and a table of Alt+N / Alt+P / Alt+I / Alt+M /
  Ctrl+Alt+S, in the terminal style, even on a phone. The web hides key hints everywhere else
  (`WorkspaceChrome.showsKeyHints: false`). The row labels do not match where they go: "Build
  beyond code" opens the Store. A first tab with no panes shows a different welcome (search,
  New Tab, New Pane, Quick start, Keyboard practice), so the same moment has two designs.
- **Fix:** on web, one New tab page with plain buttons (New Harness, Open Harness, Machines,
  New Swarm, Store) and no chords. Drop Keyboard practice on compact.
- **Files, size:** `lib/widgets/workspace_welcome.dart` (the chord table) and
  `lib/widgets/harness_start_page.dart` (the other welcome) (shared, behind the existing
  `showsKeyHints` seam). S.
- **Source:** widget code · fixture.

#### S8 · Keyboard instructions on touch screens
- **Screen, width:** New Harness form, Take control banner, Settings ▸ Keyboard shortcuts, All commands · phones.
- **Screenshots:** [`screens/split-pane/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/split-pane/390-dark.png) ("ctrl-enter create · tab / shift-tab
  fields · esc close"), [`screens/taken-over/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/taken-over/390-dark.png) ("Click here or press ⏎"),
  [`screens/settings-keyboard-shortcuts/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/settings-keyboard-shortcuts/390-dark.png) ("↑↓ Browse · Return Practice"),
  [`screens/all-commands/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/all-commands/390-dark.png) (Alt+B beside rows)
- **What goes wrong:** instructions a phone cannot follow take space and suggest the wrong way
  to act. On a computer browser, "cmd-enter" is wrong on Windows and Linux.
- **Fix:** honour `showsKeyHints: false` in these four places, and hide Keyboard shortcuts and
  Keyboard practice below 720 px.
- **Files, size:** `lib/widgets/new_harness_form.dart`, `terminal_panel.dart` (`_ControlBanner`),
  `lib/shortcuts/shortcuts_browser.dart` (shared, existing `KeyHints` seam). S.
- **Source:** widget code · fixture.

#### S9 · Three ways to download on a phone, two of them for a computer
- **Screen, width:** sign-in, workspace, first computer · 360, 390, 768.
- **Screenshots:** [`screens/signin/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/signin/390-dark.png), [`screens/workspace/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/workspace/390-dark.png), [`screens/first-machine/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/first-machine/390-dark.png)
- **What goes wrong:** the store bar says **Get the app** (the phone app). The sign-in page also
  shows **Download app** at the top right, and the workspace footer shows a blue **Download
  app**, and both send a phone to the desktop download. The footer button takes a third of
  the only bottom bar.
- **Fix:** when the store bar is shown (iOS or Android), hide `WebDownloadButton` in the footer and
  the sign-in header; keep the "Desktop app" card on the first-computer page.
- **Files, size:** `lib/web/footer/web_footer_bar.dart` (web), `lib/widgets/web_download_button.dart`
  and the sign-in header in `login_screen.dart` (shared file, web-only branch). S.
- **Source:** widget code · fixture.

#### S10 · Right-click on a tab does nothing; rename only by double-click
- **Screen, width:** tab row · 768, 1440.
- **Screenshots:** [`screens/tab-menu/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/tab-menu/1440-dark.png)
- **Steps:** right-click a tab to rename or close it.
- **What goes wrong:** a tab has a context menu only when it has sharing actions
  (`lib/widgets/desktop_workspace_tab.dart:202-208`, `_hasMenu`). An ordinary tab shows nothing, and
  the browser's own menu is not suppressed for it. Renaming is a double-click, which nothing on
  screen suggests except a screen-reader hint. On phones the tab switcher has **Rename this tab**.
- **Fix:** on web, give every tab a menu with Rename Tab and Close Tab (plus the sharing actions).
- **Files, size:** `desktop_workspace_tab.dart` (shared), behind
  `WorkspaceChrome.menuOnEveryTab`; reuse `lib/web/tabs/web_tab_menu.dart` rows (web). S.
- **Source:** widget code · fixture.

#### S11 · The new-device band cuts off what it is asking about
- **Screen, width:** band above the workspace · 360, 390.
- **Screenshots:** [`screens/new-device/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/new-device/390-dark.png), [`screens/new-device/360-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/new-device/360-dark.png)
- **What goes wrong:** "Jamie's iPhone signed in to y…" is cut to one line beside **It's mine** and
  **Review**. The person must confirm a device without reading the sentence.
- **Fix:** below 720 px, let the text wrap above the two buttons.
- **Files, size:** `lib/widgets/new_device_notice.dart` (shared). S.
- **Source:** widget code · fixture.

#### S12 · Super Tab: an error and an endless "Loading" at once
- **Screen, width:** Super Tab with the backend unreachable · all widths.
- **Screenshots:** [`screens/super-tab-offline/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/super-tab-offline/1440-dark.png), [`screens/super-tab-offline/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/super-tab-offline/390-dark.png)
- **What goes wrong:** "Could not refresh this conversation. Try again." with Retry sits above a
  body and composer that say "Loading conversation…" forever.
- **Fix:** when the first read fails, show the error as the empty state and disable the composer.
- **Files, size:** `lib/super_tabs/view.dart` (shared). S.
- **Source:** widget code, with the fixture's failing reads · fixture.

#### S13 · An incomplete viewer link is a raw error
- **Screen, width:** `/?viewer=1` · all widths.
- **Screenshots:** [`screens/viewer-incomplete/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/viewer-incomplete/1440-dark.png), [`screens/viewer-incomplete/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/viewer-incomplete/390-dark.png)
- **What goes wrong:** large red text with yellow double underlines (no `Material` above it),
  "This viewer link is incomplete. Run hn view again.", and no way back to the workspace.
- **Fix:** a styled message with `hn view` as code and an **Open Harness** button.
- **Files, size:** `lib/app_shell.dart:384-389` (shared file, web-only branch); better moved to
  `lib/viewer/`. S.
- **Source:** widget code · fixture.

#### S14 · Screen readers find buttons hidden under "Connect a computer"
- **Screen, width:** first computer · all widths.
- **Screenshots:** [`screens/first-machine/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/first-machine/1440-dark.png); the tree is in `checks.json`
  (`tapTargets`, `first-machine`: Keyboard practice, New Pane and New Tab under the page)
- **Steps:** with a screen reader, or by role in a test, look for the page's buttons.
- **What goes wrong:** the New tab page stays mounted under the first-computer page and keeps
  its accessibility tree. Its buttons (New Tab, New Pane, Quick start, Keyboard practice) are
  announced, but they cannot be pressed: a click on "Keyboard practice" lands on the page
  above it.
- **Fix:** exclude the covered workspace from semantics (and from focus) while
  `firstMachine` is shown.
- **Files, size:** where `_needsFirstConnection` stacks the page, `swarm_screen.dart:7407`
  (shared, web path only). S.
- **Source:** widget code · fixture.

#### S15 · A sign-in error lands below the fold on a computer
- **Screen, width:** sign-in after a failure · 1440×900.
- **Screenshots:** [`screens/signin-error/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/signin-error/1440-dark.png)
- **Steps:** a sign-in fails and the page comes back.
- **What goes wrong:** only the first line, "Could not sign in", shows at the bottom edge. The
  reason and **Try again** are below the fold, under a hero that fills most of the screen.
- **Fix:** put the error tile above the sign-in buttons, or shrink the fleet map while an error
  shows.
- **Files, size:** `lib/screens/login_screen.dart` `_webPage` (shared file, web-only branch). S.
- **Source:** widget code · fixture.

#### S16 · First load is a blank page for 8 to 40 seconds on a phone
- **Screen, width:** first visit · phones.
- **Evidence:** the [First load](#first-load) table.
- **Steps:** open harness.autonomous.ai/harness-web on a phone with an empty cache.
- **What goes wrong:** nothing is drawn until the engine starts: 8 s on fast 4G, 40 s on slow
  4G, on a dark empty page with no logo, progress or text. It looks broken.
- **Fix:** a static logo and "Opening Harness…" in `web/index.html`, removed when Flutter's
  first frame lands (the release keeps the same `<body>` background).
- **Files, size:** `desktop/web/index.html` (web only). S.
- **Source:** build output · measured locally (production host compression unverified).

#### S17 · 1.5 MB of icon fonts that the app does not use
- **What goes wrong:** the app uses only Lucide weight 400 (`lib/shared/theme/app_icons.dart`),
  which the build tree-shakes to 36 KB. The browser still downloads `lucide.ttf` and five other
  `LucideVariable` weights on first load, 1.53 MB compressed: a fifth of the first load.
- **Fix:** keep the unused Lucide families out of the web build's font manifest (a build step in
  `scripts/build-web-release.sh`, or depending on the single weight the app uses).
- **Files, size:** `desktop/scripts/build-web-release.sh` (web release only); `pubspec.yaml` if
  the dependency changes (shared, would also shrink the Desktop bundle). S.
- **Source:** build output · measured locally.

### Polish

#### P1 · Faint text is below 4.5:1
- **Where:** "End-to-end encrypted" on sign-in, meta lines and hints across the app.
- **Screenshots:** [`screens/signin/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/signin/390-dark.png), [`screens/signin/1440-light.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/signin/1440-light.png)
- **What goes wrong:** `AppPalette.textFaint` (`lib/shared/theme/app_theme.dart:394`) measures
  3.46:1 on the dark page (#6E6E68 on #181818), 3.25:1 on cards (#1E1E1E), 2.87:1 on the
  workspace (#282828), 4.18:1 on the light page and 3.49:1 on the light workspace (`tool/contrast.py`).
  Small text needs 4.5:1.
- **Fix:** use `textSecondary` for text a person must read; keep `textFaint` for decoration.
- **Files, size:** call sites, mainly `login_screen.dart:659` (shared). Changing the token itself
  would change Desktop. S.
- **Source:** widget code · fixture.

#### P2 · The viewer page ignores the theme and is hard to read
- **Screenshots:** [`screens/viewer-page/390-light.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/viewer-page/390-light.png), [`screens/viewer-page/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/viewer-page/1440-dark.png)
- **What goes wrong:** the page stays black in light mode. Its message ("This harness has no
  viewer.") is small dark-red monospace text on black.
- **Fix:** draw it on the theme's page colour with the app's empty-state style.
- **Files, size:** `lib/viewer/viewer_page.dart` `_message` (shared, web-reached). S.
- **Source:** widget code · fixture.

#### P3 · "This computer" in a browser
- **What goes wrong:** the naming system defines **This computer** as the local execution machine
  (`docs/naming-system.md`), which a browser is not. The web still says:
  - Settings ▸ Account: "Your Harness sign-in on this computer." (`settings/sections/account_section.dart:61`)
  - Tab invites and Tab Activity: "Harness could not reach this computer." (`tab_invites_section.dart:195`,
    `agent_messages/shared_tabs.dart:368`, `tab_activity.dart:71`)
  - Store product page: "Connecting to this computer…" (`store/store_screen.dart:1485`)
  - The footer's subscription tooltip: "On: This computer" (`widgets/workspace_subscription_usage.dart:152`)

  Also: "1 linked machines" (`swarm_screen.dart:1637`); "Rename this tab" where the action name
  is **Rename Tab**; "Run hn view again" without code formatting.
- **Screenshots:** [`screens/settings-account/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/settings-account/1440-dark.png), [`screens/settings-tab-invites/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/settings-tab-invites/390-dark.png),
  [`screens/store-product/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/store-product/1440-dark.png), [`screens/footer-menu/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/footer-menu/390-dark.png)
- **Fix:** use "this browser" or the computer's name on web, and fix the plural.
- **Files, size:** as listed (shared). Settings sections are outside the workspace: one small
  web-only branch each, with the Desktop wording byte-for-byte the same. The footer tooltip and
  `swarm_screen.dart` are inside the workspace: no `kIsWeb` there. Use wording that is right on
  both, such as the plural fix, or a `WorkspaceChrome` field read with `WorkspaceChrome.of`
  ([Proposed fix groups](#proposed-fix-groups)). S.
- **Source:** widget code · fixture. The Tab invites and Routing pages also show "Sign in to use
  Swarm" while signed in. That comes from fixture data (no account id) and needs a live check.

#### P4 · Store cards on the New tab page break words on phones
- **Screenshots:** [`screens/empty-tab/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/empty-tab/390-dark.png), [`screens/empty-tab/360-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/empty-tab/360-dark.png)
- **What goes wrong:** "Brows e the Harne ss" and "Meet the Harne ss": the card keeps its picture
  width and squeezes the title.
- **Fix:** stack picture over title below 720 px, or drop the picture.
- **Files, size:** `lib/widgets/harness_start_page.dart:285-338` (shared). S.
- **Source:** widget code · fixture.

#### P5 · Swarm with no projects has no button
- **Screenshots:** [`screens/super-tab-empty/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/super-tab-empty/1440-dark.png), [`screens/super-tab-empty/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/super-tab-empty/390-dark.png)
- **What goes wrong:** "Create a project to get started." with the action somewhere else.
- **Fix:** a **New project** button under the sentence.
- **Files, size:** `lib/super_tabs/view.dart` (shared). S.
- **Source:** widget code. The review fixture passes no `onNewProject`, so whether the real
  sidebar shows **New project** needs a live check.

#### P6 · Settings ▸ Usage on web is an empty box
- **Screenshots:** [`screens/settings-usage/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/settings-usage/1440-dark.png), [`screens/settings-usage/390-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/settings-usage/390-dark.png)
- **What goes wrong:** one sentence, and a full-height panel saying "Start your first harness to
  begin tracking." The browser counts only its own activity, so the page is nearly always empty.
- **Fix:** show the account's subscriptions (as the footer does), or hide the section on web
  until it has content.
- **Files, size:** `lib/settings/sections/usage_section.dart` (shared, web branch at line 122). S.
- **Source:** widget code · fixture.

#### P7 · Sign-in hero labels are unreadable on phones
- **Screenshots:** [`screens/signin/360-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/signin/360-dark.png)
- **What goes wrong:** the fleet map's labels ("home · claude, codex", "under the desk") are about 8 px.
- **Fix:** below 480 px, hide the small labels or the map.
- **Files, size:** `lib/widgets/login_fleet_map.dart` (shared). S.
- **Source:** widget code · fixture.

#### P8 · Keyboard focus is hard to see
- **Screenshots:** [`checks/focus-signin.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/checks/focus-signin.png), [`checks/focus-first-machine.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/checks/focus-first-machine.png), [`checks/focus-settings.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/checks/focus-settings.png)
- **What goes wrong:** after four presses of Tab, sign-in and the first-computer page show no
  focus ring. Settings shows only a faint fill on the focused row. The terminal takes Tab, as
  it should.
- **Fix:** a visible focus ring for buttons and rows on web (the design system's accent
  outline).
- **Files, size:** shared button styles in `lib/shared/theme/app_theme.dart` (`buildAppTheme`)
  behind a web flag, or per web component. S.
- **Source:** widget code · fixture. The fixture runs with the accessibility tree on, which
  changes how browsers move focus, so recheck with it off before fixing.

## Cross-cutting checks

From `checks.mjs` (results in `checks.json`, before and after images in `checks/`) and from
reading the captures. The fixture is a release build, so Flutter's debug overflow stripes are
not drawn; clipping was judged from the screenshots.

| Check | Result |
| --- | --- |
| Tap targets under 44 px on phones | **Fail → S1.** Every phone screen has some. Top bar: Menu 31×28, New Tab 23×28, Open Harness 31×28, Notifications 31×28. Pane header: Close Pane 28×28, agent and model 28 tall. App menu rows 32 tall; footer dropdown rows 32; tab switcher rows 40; Machines actions (Rename, Remove, Add machine, History…) 28; picker filter chips 32; Store Back and Forward 32×30; New tab page rows 24; Settings rows 38; New Harness form fields 32. |
| Mouse wheel on every scrolling area (1440, mouse) | **Pass.** The tab row with 16 tabs scrolls with the vertical wheel, Shift+wheel and a sideways trackpad swipe, and its arrows scroll it too. The Store page, picker filter chips, All commands, Appearance panel, Settings ▸ Keyboard shortcuts and the New Harness form all scroll. The first run reported the tab row as stuck: it starts scrolled to its end (the active tab is the last), so the check now wheels backwards. |
| Touch swipe (390) | **Pass.** The app menu, Store, Keyboard shortcuts, All commands, Machines and the first-computer page scroll by finger. The tab switcher (16 tabs), the Settings list and sign-in fit without scrolling. |
| Hover (1440) | **Pass.** All ten controls tried (New Tab, Open Harness, Close Pane, agent label, footer Harnesses, a tab, a menu row, Continue with Google, Download app, a Settings row) change on hover and show a pointer cursor. Tooltips stay up after a click until the mouse moves ([`screens/store/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/store/1440-dark.png), [`screens/harness-monitor/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/harness-monitor/1440-dark.png)). |
| Focus | **Weak → P8.** No visible focus ring on sign-in or the first-computer page after Tab; a faint fill in Settings. |
| Contrast (`tool/contrast.py`) | The standing checks pass in both themes. **Fail → P1** for `textFaint` (2.87–4.18:1), and **P2** for the viewer page. |
| Text clipping and overflow | **Fail → B1, S2, S11, S15, P4, P7.** |
| Panels covering the whole phone screen | **Pass.** Settings, Appearance, the picker, Machines, History and the Store take the whole phone screen with a visible Back or close. The Super Tab drawers leave a veil to tap (PR #1570). The app menu and footer dropdown are popovers. |
| Features reachable only by keyboard | **Fail → B2** (New Swarm) and **S10** (renaming a tab by double-click only at computer widths). Zoom pane, move pane, layouts, reopening a closed tab and the shortcuts sheet are reachable by clicking only through Menu ▸ All commands. That counts as clickable, but it is a long way round. |
| Empty, loading and error states | **Fail → S5, S6, S12, S13, S14, P5, P6.** The first-computer page, the error banner with Retry, Notifications ("No notifications") and the History search are clear. |
| First load of the web bundle | See [First load](#first-load). |
| Copy against `docs/naming-system.md` | **Fail → P3.** "This computer" in a browser, "1 linked machines", "Rename this tab" instead of **Rename Tab**. Swarm, Product Manager, New Harness, New Tab and Connect a computer follow the system. |
| Requests leaving the page | None. `blocked*.json` is empty for every run: the fixture never reached a backend. Only Google's font CDN is let through, as production does for missing glyphs. |

## First load

Release build from this revision (`scripts/build-web-release.sh` flags), served gzip-compressed
at `/harness-web/` with every off-page request blocked, empty cache, three loads per profile,
median shown (`load-time.mjs`; end screens checked, all three ended on the sign-in page).

| Profile | Flutter view in the page | Sign-in page drawn and still | Transferred |
| --- | --- | --- | --- |
| Computer, unthrottled | 1.2 s | 1.2 s | 7.3 MB |
| Phone, fast 4G (9 Mbps, 40 ms, 2× CPU) | 8.0 s | 8.5 s | 7.3 MB |
| Phone, slow 4G (1.6 Mbps, 150 ms, 4× CPU; Lighthouse mobile) | 39.8 s | 40.8 s | 7.3 MB |

Largest files on first load (compressed): `main.dart.js` 3.15 MB, `canvaskit.wasm` 2.08 MB,
**Lucide icon fonts 1.53 MB** (`lucide.ttf` 0.41 MB plus five `LucideVariable-w100…w600`
weights of ~0.22 MB each), Roboto Mono 0.27 MB. Until the Flutter view appears, the page is
an empty dark rectangle: `web/index.html` draws nothing while it loads. The findings this
produces are **S16** and **S17**.

## Unverified

These need a real computer, a real account or a real phone. The fixture cannot show them
faithfully, so they were not judged.

| What | Why it is unverified |
| --- | --- |
| Live terminal behaviour: streaming output, reflow on resize, scrollback, typing latency, P2P against the relay | The fixture writes fixed text into the terminal before layout and has no transport (`tool/web_ux_seed.dart`) |
| How long Connecting and Reconnecting last, and what a real drop looks like | Needs the relay and a machine |
| On-screen keyboard over the composer and bars (`lib/web/shell/web_hidden_under_keyboard.dart`), safe areas (notch, home bar), pinch zoom (`web/index.html` viewport rules) | Headless Chrome has no on-screen keyboard or safe-area insets |
| Add your phone QR | The fixture shows "The computer is offline": the pairing code needs a machine RPC ([`screens/add-phone/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/add-phone/1440-dark.png)) |
| Harness Monitor | Opening it installs and talks to a machine; the fixture shows a "Lost the connection" toast ([`screens/harness-monitor/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/harness-monitor/1440-dark.png)) |
| Models and subscription figures ("Checking usage…", "not signed in on the harness's machine") | Needs `usage_read` from a machine ([`screens/models/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/models/1440-dark.png)) |
| Settings ▸ Experimental, Privacy, Routing, Tab invites with real data | Their errors in the captures come from the fixture having no account id or API |
| Store install, Remove, Install anyway | Need a machine to install on |
| Shared harness `/s/…` beyond the incomplete-link state: private, not invited, owner offline, comments | Need the backend and an owner daemon (`lib/sharing/shared_agent_page.dart`) |
| Viewer page with a running viewer | Needs a harness that serves one |
| Super Tab inside the web workspace (tab row, store bar, footer around it), Group terminals opening, New project in the sidebar | The Super Tab fixture renders `SuperTabView` alone with stub callbacks; embedding it needs a `SuperTabClient` transport seam in `AppNotifier` |
| Browser notification permission prompt | Needs a real browser prompt (Settings ▸ Notifications ▸ Desktop notifications) |
| Device bands other than New device (removal, departed, conflict) and the shared-tab invite band | Not seeded in this pass (`lib/widgets/new_device_notice.dart`, `shared_tab_notice.dart`) |
| Close confirmation for a working harness (Stop / Cancel) | Needs live activity from a machine |
| Password link dialog after a refused trusted dial | The fake refuses at once, so the page shows "Couldn't connect" ([`screens/link-password/1440-dark.png`](https://github.com/autonomous-ai/openharness/blob/a521af922/desktop/design/web-ux-audit/screens/link-password/1440-dark.png)) |
| Hub return (`/hub…`) | Needs the Hub's session handoff |
| Agent Messages and the Tab Activity dock | Need the account experiment and a shared tab |
| First load on a real phone network and the production host's compression | Measured locally with throttling (see [First load](#first-load)) |

## Proposed fix groups

Seven groups, split by responsibility. No two groups own the same file. Every blocks and slows
finding is in exactly one group; polish items ride with the group that owns their file. Each
group says whether it touches shared code (outside `lib/web/`), and the existing Desktop tests
must stay green. The rules for shared code (plan section 9):

- **Inside the workspace**, a widget reads the web's switches with `WorkspaceChrome.of(context)`,
  which works in the workspace's overlays too. The switches are `menuOnEveryTab` (S10),
  `labelsPaneStatus` (S3, S4) and `compactPaneHeader` (S2), plus the existing `compactBelow`
  and `showsKeyHints`. Desktop leaves all three off; `lib/web/shell/web_chrome.dart` turns them
  on. A `kIsWeb` check inside the workspace fails review.
- **Outside the workspace** (sign-in, the viewer page, the viewer-link branch in
  `app_shell.dart`, Settings sections, the theme) there is no chrome. Each may use one small
  web-only branch, with its Desktop path byte-for-byte the same.
- **S3 and S4 are web only.** Turning the labels on for Desktop later is a separate decision.
- `lib/state/workspace_chrome.dart` and `web_chrome.dart` belong to the review tooling (group 0);
  fix groups only read them. Each group adds review fixture scenarios or flows for its own states, and re-captures
them at 360, 390, 768 and 1440.

| Group | Findings | Owns | Shared code? | Size |
| --- | --- | --- | --- | --- |
| 1. Web menus and commands | B2, S1 (web menus), S10, P3 "Rename this tab" | `lib/web/shell/web_app_menu.dart`, `web_menu_items.dart`, `web_dropdown_control.dart`, `lib/web/tabs/*`, `lib/web/footer/web_footer_bar.dart`, `lib/widgets/desktop_workspace_tab.dart` | Yes: `desktop_workspace_tab.dart`, behind `menuOnEveryTab` | M |
| 2. Store on phones | B1, P3 (Store line) | `lib/store/store_screen.dart`, `store_discover.dart`, `store_explore_widgets.dart` | Yes: Store layout below a `compactBelow` passed by web chrome; Desktop default unchanged | M |
| 3. Pane header and states | S2, S3, S4, S1 (pane header hit size), S8 (Take control banner) | `lib/widgets/pane_grid.dart`, `lib/widgets/terminal_panel.dart` | Yes, behind `labelsPaneStatus` and `compactPaneHeader`: web only, Desktop unchanged | M |
| 4. First computer and the offline workspace | S5, S6, S14, P3 "1 linked machines" | `lib/web/onboarding/web_first_machine.dart`, `web_your_computers.dart`, `_needsFirstConnection` in `lib/screens/swarm_screen.dart` | Yes: one condition in `swarm_screen.dart`, behind the existing `firstMachine` seam | S |
| 5. Welcome pages, hints and download buttons | S7, S8 (form, shortcuts page), S9, S15, P1, P4, P7 | `lib/widgets/workspace_welcome.dart`, `harness_start_page.dart`, `new_harness_form.dart`, `lib/shortcuts/shortcuts_browser.dart`, `lib/widgets/web_download_button.dart`, `lib/screens/login_screen.dart`, `lib/widgets/login_fleet_map.dart` | Yes: all behind `showsKeyHints` or web-only branches | M |
| 6. Error states, bands and copy | S11, S12, S13, P2, P3 (the remaining lines), P5, P6, P8 | `lib/widgets/new_device_notice.dart`, `lib/super_tabs/view.dart`, `lib/app_shell.dart` (viewer-link branch), `lib/viewer/viewer_page.dart`, `settings/sections/account_section.dart`, `tab_invites_section.dart`, `usage_section.dart`, `agent_messages/shared_tabs.dart`, `tab_activity.dart`, `widgets/workspace_subscription_usage.dart`, `lib/shared/theme/app_theme.dart` (focus ring, behind a web flag) | Yes: copy, empty states, focus; Desktop wording unchanged where it is right | M |
| 7. First load | S16, S17 | `web/index.html`, `scripts/build-web-release.sh` | Only if the Lucide dependency itself changes (`pubspec.yaml`) | S |

Each P3 line goes to the group that owns its file: the Store line to group 2, "1 linked
machines" (`swarm_screen.dart`) to group 4 and "Rename this tab" to group 1. P1 goes to group
5 because its main call site is `login_screen.dart`. Group 4 and group 5 both touch screens drawn
by `swarm_screen.dart`, but only group 4 edits that file.

**Acceptance checks per group**

1. **Web menus and commands**
   - The app menu has **New Swarm**, and clicking it opens the new Swarm form at 390 and 1440.
   - At 360 and 390, every row of the app menu, tab switcher, tab menu and footer dropdown
     measures at least 44 px tall in `checks.mjs` (`tapTargets`).
   - Right-clicking an ordinary tab at 1440 opens a menu with Rename Tab and Close Tab.
   - The Desktop tab tests (`flutter test test/swarm_screen_test.dart`) still pass.
2. **Store on phones**
   - At 360 and 390, `screens/store` and `store-product` show the catalogue at full width with
     no word broken across lines; the rail is a dropdown or chips.
   - At 1440 the Store matches today's capture.
   - The Store's widget tests pass.
3. **Pane header and states**
   - At 390 the pane header shows the harness name with at least 16 characters, plus a status
     word for connecting, reconnecting, offline, view only and taken over.
   - At 768 there are at most two pane columns.
   - Reconnecting and view-only show a labelled chip at 1440 on web; the Desktop pane header
     tests pass unchanged and show no new label.
   - The Desktop pane tests pass with the chrome seam at its default.
4. **First computer and the offline workspace**
   - `offline-only` keeps the pane, in its Offline state, plus a band naming the computer.
   - `first-machine` still shows the connect page for an account that never connected one.
   - `first-machine-loading` shows a loading state, not the New tab page.
   - Under "Connect a computer", the accessibility tree has no New tab page buttons.
5. **Welcome pages, hints and download buttons**
   - No capture at any width contains a key chord (Alt+, Ctrl+, cmd-, ⏎) outside Settings ▸
     Keyboard shortcuts and All commands.
   - At 390 there is exactly one download action (the store bar).
   - The New tab page has the same buttons whether or not the tab is empty.
   - On `signin-error` at 1440×900, the error and Try again are fully on screen.
   - `tool/contrast.py` gives at least 4.5:1 for the sign-in page's small text.
6. **Error states, bands and copy**
   - `viewer-incomplete` renders a styled message with a working button.
   - `super-tab-offline` shows one error state, not "Loading" at the same time.
   - The new-device band text is fully readable at 360.
   - After Tab on sign-in at 1440, the focused button shows a visible ring.
   - A grep of web-reachable copy finds no "this computer" outside places that mean a
     computer.
7. **First load**
   - With `load-time.mjs` on slow 4G, a logo and "Opening Harness…" show within 3 s.
   - The first load transfers no `lucide.ttf` or `LucideVariable-w1/2/3/5/600` file, and the
     transfer drops by about 1.5 MB.
   - Icons still render in every capture.

## Live pass

The owner offered their own sign-in for a look-only pass against harness.autonomous.ai. It did
not run. Opening the signed-in web app adds the browser to the account's device list by itself
at start-up (`lib/state/app_state.dart:6448`, `log.register()`), before any computer connects.
The owner's other devices would then see a "New device" notice, so even looking would change
the account. The decision went to the owner; the default, applied at 17:00 without an answer,
is no live pass. Every finding is therefore tagged **fixture**, and what needs real data is in
[Unverified](#unverified).

## Pre-existing issues

- `flutter analyze` on `main` (`d763e16d6`) reports one error outside this work:
  `tool/devices_preview.dart:202:16` — "'DevicesReviewApp.showDevicesTerminal' ('Future<void>
  Function(String, String)') isn't a valid override of 'AppNotifier.showDevicesTerminal'
  ('Future<void> Function(String, String, {String? swarmId})')" (`invalid_override`). Left alone.
- `tool/super_tab_mobile_fixture.dart` drew its "light" screens with dark-palette ink, because
  it set the Material theme but not the design tokens (`grid.AppTheme.palette` and
  `brightness`), which default to dark. Adding `?theme=` fixed both themes; light stays the
  default.
