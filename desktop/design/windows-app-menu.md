# Windows app menu

Status: implemented with the tab-strip app menu; custom caption deferred.

## The problem

A Windows window drew two bars stacked: the OS caption (minimise, maximise, close)
and, under it, a 36px strip of menus — **Harness, File, Edit, View, History,
Window, Help** — that `widgets/in_window_menu_bar.dart` draws. The strip exists
because macOS hands its commands to AppKit's menu bar and Linux has no menu bar
either, so the same widget serves Linux and Windows.

Two stacked bars is the legacy Win32 shape. It is what Visual Studio and old MFC
tools do, and almost nothing shipped in the last decade does it:

| Pattern | How it looks | Examples |
| --- | --- | --- |
| Classic caption + menu bar | caption, then a File/Edit/View row | Visual Studio, old Win32 tools |
| Caption + command bar/ribbon | caption, then one commands row | File Explorer, Office |
| Extended title bar, **system caption buttons** | app content in the caption row; DWM draws min/max/close | Windows Terminal, Settings, Notepad, Photos, Outlook |
| Fully custom caption | app draws its own buttons | Chrome, Edge, VS Code, Slack, Discord, Spotify (Electron `titleBarOverlay`), Figma |

Modern Windows apps keep **one** row for window-level things (tabs, title, search,
account) and put the command list behind a button or a command palette:
Chrome's ⋮, VS Code's ☰ plus its palette, Slack's ☰, Windows Terminal's tabs in
the title bar. A menu row of its own under the caption is the thing this change
removes.

## What we do

Windows keeps its **native caption** — snapped windows, eight-way resize,
Alt+Space, DPI, accessibility and Snap Layouts stay the OS's job — and the strip
is gone. Its commands open from one **☰ at the left of the workspace tab strip**,
which is the row the window's own controls already sit in (search,
notifications, Store, account at the right).

- One panel, grouped in the same seven sections in the same order and with the
  same rows as the strip, so nothing becomes unreachable: About, Settings,
  Update, Export Logs, Quick Start, New Tab, Close Tab, Edit's clipboard rows,
  Layout, font sizes, full screen, notifications, machines, models, monitor,
  viewer/composer toggles, history, window rows, Help.
- The rows are **the same widgets** the strip uses: same enabled/disabled
  gating from `SwarmMenuState`, same accelerator hints beside a row, same Edit
  targeting of the focused field or terminal, and View still reads full-screen
  state when the panel opens.
- Keyboard is unchanged: every action keeps the shortcut the keymap gives it
  (that is the point of the hints), so the button is a discovery surface, not the
  only way in.
- macOS is untouched: its commands stay in AppKit's menu bar. Linux is
  untouched: it keeps the strip, because on GNOME that strip *is* the title bar.

## Not doing (yet)

A custom title bar (the "tabs in the caption row" look of Windows Terminal) is
deferred. `window_manager` 0.5.2 does not hide a Windows caption —
`SetTitleBarStyle` only zeroes the DWM frame margins there — so it needs runner
work (`WM_NCCALCSIZE`, hit-testing for drag and eight-way resize, `HTMAXBUTTON`
so Snap Layouts still opens, Alt+Space, DPI, UIA names). That is its own spec and
its own test matrix on Windows 10/11 x64 and arm64; the menu change above is the
visible win without that risk.

## Design notes

- **Reachability:** the compact panel is built from the strip's own
  `_build*Menu()` methods — one source of rows, not a second list to drift.
- **Identity of the dispatcher:** the tab strip is built by the workspace screen,
  which has no handle on the shell's action switch. The shell installs it in
  `appMenuActionSink` at startup (the same seam shape as `swarmMenuBus`), and the
  compact bar falls back to it when no handler is passed. Rows that talk to the
  swarm bus keep dispatching through `swarmMenuBus`, as the strip did.
- **Where the strip went:** `InWindowMenuBar`'s default visibility is now Linux
  only. `visible:` remains as the test seam it already was.
- **Tests on other hosts:** the button is gated by `RuntimePlatform.isWindows`,
  which a widget test cannot fake, so the screen takes `appMenuButton:` the way
  it already takes `chrome:`; the compact widget itself is exercised directly.
- **Failure:** nothing in the panel is new behaviour — every row is the row the
  strip drew. If the shell's sink were missing, the button would open a panel
  whose app rows do nothing; the swarm rows would still work and every shortcut
  still fires. The sink is installed in `initState` before the first frame.

## Validation

- `flutter analyze`.
- `desktop/test/in_window_menu_bar_test.dart` (strip, unchanged) and the new
  compact-mode tests: button renders, panel opens, all seven sections appear, a
  row dispatches its action, Escape and a second press close it.
- `desktop/test/windows_app_menu_test.dart`.
- On a real Windows machine: the strip is gone, one ☰ sits in the tab row, every
  section opens, and `File ▸ New Tab`, `Edit ▸ Copy` and `View ▸ Enter Full
  Screen` still act.
