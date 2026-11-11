# Light and dark themes, plus Match macOS — plan (task #3006)

**Goal:** Four neutral palettes modeled on the two popular chat apps' light and dark looks, under our own names, and a
Light / Dark / Match macOS choice at the top of Appearance > Workspace that picks between a chosen light palette and a
chosen dark one. Match macOS follows the system setting live. Paper and Mist stay; terminal colors keep their own
setting; someone who never opens Appearance keeps today's Graphite.

**Architecture:** Every surface already reads one effective palette (`AppearancePrefs.palette` →
`AppTheme.palette` → tokens, native window). That stays the single source. The store gains the mode and the two
slots, and resolves the effective palette from them and the system brightness, which it follows through a
`WidgetsBindingObserver`. No consumer of `prefs.palette` changes. Palettes gain optional ink overrides (text, muted,
faint) so the new ones carry their own grays, and an optional dark sidebar ("island") for the light palette whose
sidebar is a deep plum with white text; the Swarm sidebar reads its ink from a `SidebarInk` scope so shared row widgets
change only inside it.

**Tech Stack:** Flutter (Desktop, web shares the code), `flutter_test` widget tests with a memory store.

**Spec:** task #3006 brief (Dee's thread in the project chat, 2026-11-05).

## Global Constraints

- Names: Plum (white, plum sidebar), Night (near-black), Cloud (white, gray sidebars), Storm (gray, darker rail). No
  other product's name in the app or its copy.
- Text at least 4.5:1 on every ground it meets; primary text at least 7:1 on the chat ground.
- One accent per palette for links, the unread dot and buttons; red only for counts.
- Don't touch `project_sidebar.dart`, `activity_view.dart`, `thread_panel.dart` beyond color tokens (#2996).
- Compatibility: `app_color_palette` keeps holding the effective palette, so an older build opens in the same look (an
  older build that doesn't know a new id falls back to Graphite, as for any unknown id). A build without a saved mode
  derives it from the saved palette's brightness.
- Desktop tests use a memory store and never sign anything in.

## Review Focus

- The effective palette is the only thing consumers read; mode changes never leave `AppTheme.palette`, the Material
  theme and the native payload disagreeing.
- Match macOS: the observer is added once and removed on dispose; a system flip only changes the palette in Match mode.
- Persistence ordering under rapid choices (the existing coalescing pattern) and tolerant loading of hand-edited ids
  (a dark id in the light slot falls back).
- Sidebar island: every ink in the Swarm sidebar reads `SidebarInk`, and nothing outside the sidebar changes.

## Design

- growth: four enum values and three small keys in the existing preferences file; nothing accumulates.
- concurrency: one ValueNotifier on the UI isolate; writes coalesce as today's palette write does.
- read cost: the system brightness is pushed by the engine on change; nothing polls.
- scale: N/A because it is one local preference per computer.
- compatibility: older builds read `app_color_palette` (still written with the effective palette); newer builds
  without a saved mode derive it.
- migration + rollback: no migration; rolling back leaves the effective palette in the old key.
- audience: N/A because it is a local preference with no server.
- identity: N/A because nothing is sent.
- failure: a failed write keeps the choice for the run, as today.
- platforms: macOS, Windows, Linux and web; the third choice reads "Match macOS" on macOS and "Match system"
  elsewhere.

## Task 1: Four palettes and their inks

**Files:** `desktop/lib/shared/theme/color_palette.dart`, `desktop/lib/shared/theme/app_theme.dart`,
`desktop/test/theme_palettes_test.dart`

**Interfaces:** `HarnessPalette.plum|night|cloud|storm`; optional `text`, `muted`, `faint`, `sidebar`, `sidebarInk`;
`AppPalette.textPrimary/textSecondary/textFaint` read the palette's overrides when set; `AppPalette.swarmSidebar`.

- [ ] Failing test: the four exist with the brief's grounds (#FFFFFF chat and #1D1C1D text; #1A1D21 and #19171D;
      #FFFFFF, #F2F3F5, #E3E5E8 and #313338; #313338, #2B2D31, #1E1F22), contrast floors hold for every text step
      on every ground, and the tokens read each palette's grays.
- [ ] Code: the four palettes, the overrides and the token reads.

## Task 2: Light / Dark / Match macOS in the store

**Files:** `desktop/lib/shared/theme/appearance_prefs_store.dart`, `desktop/lib/app_shell.dart`,
`desktop/test/theme_mode_test.dart`

**Interfaces:** `enum AppearanceMode { light, dark, system }`; `AppearancePrefs.mode/lightPalette/darkPalette`;
`AppearancePrefsStore.setMode`, `setPalette` (fills the slot of the palette's brightness; in Light or Dark it also
moves the mode to that brightness), `followSystemBrightness()`.

- [ ] Failing tests: default is Dark + Graphite; Light/Dark pick their slot; Match follows a system flip live
      (`platformBrightnessTestValue`) and only in Match; choices persist and reload; a saved palette without a mode
      derives it; a hand-edited dark id in the light slot falls back.
- [ ] Code.

## Task 3: Appearance > Workspace

**Files:** `desktop/lib/settings/appearance/palette_section.dart`, `desktop/test/theme_mode_test.dart`

- [ ] Failing widget tests: the three-way choice sits at the top of Workspace; Light and Dark switch the app; Match
      macOS with a system flip switches it live; the light and dark palettes are chosen in their own groups below.
- [ ] Code.

## Task 4: The plum sidebar

**Files:** `desktop/lib/shared/theme/app_theme.dart` (`SidebarInk`), `desktop/lib/super_tabs/project_sidebar.dart`
(color tokens only), the sidebar's shared rows, `desktop/test/theme_palettes_test.dart`

- [ ] Failing test: in Plum the Swarm sidebar is #3F0E40 and its row text is white at 4.5:1 or better, while the same
      rows outside the sidebar keep the page's ink.
- [ ] Code.

## Task 5: Screenshots

**Files:** `desktop/test/theme_palettes_shots_test.dart`

- [ ] Env-gated capture of the Swarm chat with its sidebar, a thread, and Decisions in each new palette, plus the
      Appearance pane; sent to Dee in the task.
