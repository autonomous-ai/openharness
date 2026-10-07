# Harness icon system

This is the icon contract for the desktop app on macOS, Linux and Windows,
and the web UI built from `desktop/lib`. It applies to every screen, dialog,
menu, picker, toolbar and workspace control. Use it with the
[desktop design system](desktop-design-system.md).

## Character

Quiet, precise, rounded outlines. Symbols support the content and remain
recognizable when repeated across many panes. Use one stroke weight, rounded
ends and joins, and an optically centered drawing. Never stretch an icon or
change its weight on hover. Rounding should soften a shape without losing its
meaning: a warning triangle remains a triangle, a chevron remains a chevron.

## Source of truth

- `lib/shared/theme/app_icons.dart` names the regular **400** Lucide symbols.
  Import `AppIcons`; never import Lucide directly from a screen, use raw
  Material/Cupertino icons, or substitute a text character for a control.
- `AppPaneIcon` supplies the approved small split, zoom and restore outlines.
  They use a **24-unit grid, 2-unit stroke, 4-unit corners**, with round caps
  and joins. Use the same drawings in pane headers, menus and search preview
  controls. `reload` and `close` delegate to the canonical Lucide glyphs.
- `AgentActionIcons.create` is plus; `.open` is the diagonal arrow. A search
  lens means searching, not creating. Close always resolves to `AppIcons.close`.
- AppKit controls use `HarnessControlSymbols`: regular monochrome SF Symbols
  at the shared 16-point size. Native menu items and the title bar share this
  factory. Native tab close is the optically matched 8-point regular `xmark`.

Add a missing semantic symbol to the catalogue, then reuse it. Do not create
a local font alias or duplicate a drawing. A new optical variant belongs in
the shared implementation and must be reviewed beside the existing family.

## Size and targets

| Role | Drawing size | Target |
| --- | --- | --- |
| Workspace close | 12 pt | Existing 28 pt pane / native tab target |
| Dense pane actions and metadata | 14 pt | 28 pt for pane actions |
| Inline actions, compact menus, ordinary selectors | 16 pt | 32 pt when independently clickable |
| Roomy picker rows, labeled buttons, dialog dismiss | 18 pt | Shared control/row target |
| Global toolbar or standalone navigation | 20 pt | At least 32 pt |
| Feature/empty-state mark | 24 pt | Inert unless explicitly an action |

Choose a role, not an arbitrary 13, 15, 17 or 19-point size. A small glyph does
not mean a small click target. Keep the target fixed on hover, focus, selection
and disablement. Platform text scaling may grow the containing control; terminal
font size never changes the surrounding app icons. Identity artwork and
illustrations have their own layout dimensions.

The pane close target has a 4-point trailing inset. Tabs retain their 8-point
inset. Glyphs stay centered inside the target; do not move the drawing itself
to compensate for excess container padding.

## Ink and state

- Use semantic theme ink or `IconTheme`. An ordinary icon is monochrome and
  follows its label. Active menu rows use the selected row's foreground.
- Pane controls rest at 45% foreground, or 70% with Increase Contrast.
  Hover and keyboard focus restore full ink. Disabled controls use 22%, or
  45% with Increase Contrast. They have no extra fill, border or movement.
- Other icon buttons use `AppIconButton` and its shared rounded hover/focus
  treatment. Do not reproduce a slightly different button in each panel.
- Keep a selected state legible without color: checkmarks, labels and shape
  changes carry meaning. Zoom becomes Restore; loading can animate only while
  work is actually pending, respecting Reduce Motion.
- Subscription allowance values use `usageLow` at 6–20% remaining and
  `usageCritical` at 5% or less; healthy and unknown figures stay neutral.
  Provider artwork retains its identity colors. Values and tooltip status text
  carry the meaning alongside color. Flutter and AppKit share contrast-adjusted
  ink with at least 4.5:1 text contrast on the selected workspace surface.

## Deliberate exceptions

These are content or identities, not a second action-icon library:

- Agent/provider/product marks retain their authentic artwork and color.
  Codex and Claude should be distinguishable at a glance. Use `EngineMark`
  and the existing model identity renderer; keep letters only as the existing
  unknown-identity fallback.
- GitHub PR state marks retain the shared Primer assets and state silhouettes
  (open, draft, closed, merged), along with status text. The GitHub logo is a
  brand mark. Neither is a substitute for generic action glyphs.
- `AppRatingStar` uses a rounded outline and proportional fill to encode a
  number. Layout thumbnails use the real pane geometry. Connection dots,
  progress indicators and activity marks encode state.
- Harness activity has one vocabulary in `harness_activity.dart`: `?`, `✗`,
  `✓`, the ten-frame Braille spinner, `◌`, `■`, `⊘`, and unmarked idle. Native
  tabs and menu notifications share `HarnessNativeActivity`; Dart pane headers
  share `ActivityMark`. Bridge payloads use `nativeActivityPayload` and the
  same `activityColor`, including the monochrome preference. Do not substitute
  SF Symbols or add status pills to a different Harness surface. A notification
  mark describes its unread receipt; a tab/pane mark describes current activity.
- QR codes, companion artwork, explanatory diagrams, wallpaper, terminal
  output and user-selected status/Powerline artwork are content. Keep their
  function and authorship; do not round QR modules or replace terminal glyphs.

## Accessibility

Every icon-only action has a descriptive tooltip and accessible name. Keep
the label on the enclosing button and exclude duplicate decorative semantics.
Keyboard activation, disabled state and focus remain owned by the existing
control. Icons embedded in text do not create additional Tab stops. Show full
tooltip text when the associated label truncates.

## Review and prevention

Run from the repository root:

```sh
python3 desktop/scripts/audit-icons.py --output /tmp/harness-icons.json
```

This scans **all first-party Dart files**, including the web UI and Linux
menus, and reports every catalogue reference and source location. It fails
on direct Material/Cupertino/Lucide references and non-regular catalogue
weights. The icon catalogue widget test also checks this source contract.

Render the full catalogue from `desktop/`:

```sh
HARNESS_ICON_CAPTURE_DIR=/tmp/harness-icon-review \
  flutter test --no-pub test/icon_catalog_render_test.dart
```

The renderer reads every catalogue entry, including unused entries, from the
actual installed icon font. It includes all pane variants, in light and dark
appearances, at 14/16/20/24 points. Inspect every page at actual size. Review
changed symbols in their real screens too: dense grids, menus, long labels,
hover/focus/disabled states, Increase Contrast and text scaling. A contact
sheet does not replace interaction checks.

## Audit record — 2026-09-30

Reviewed the complete catalogue, all custom painters and SVG call sites,
native menu/title-bar symbols and every icon-bearing desktop/web surface.
The source inventory covers 492 Dart files and 143 shared symbols, alongside
native SF Symbols. Rendered every catalogue entry and native symbol in light
and dark; checked pane grids, Companions and Settings in context.

Corrected Material icons in Companions, wallpaper settings and the web tab
menu; 300/default-weight Lucide references in Linux menus, compact Settings,
web navigation and tab close; incidental odd-sized control glyphs; the old
SVG toolbar renderer; and the separate viewer toolbar treatment. Native
application-menu icons now use the same regular-symbol configuration as other
native menus. Brand, PR, quantitative and content exceptions above were
reviewed and retained deliberately.

Validation: 241 targeted widget tests pass, including keyboard/mouse menu
behavior, pane creation/zoom/close, viewer controls, companion memories,
enlarged Settings text, attachment handling, sharing/header placement,
notification grouping, tab scrolling and
subscription contrast across workspace palettes. Linux window controls,
web share badges and tab scroller arrows also use the shared catalogue.
First-party app code and the changed tests pass static analysis.

Review captures use synthetic fixtures: [repeated pane controls](review/2026-09-30-pane-icons.png),
[subscription allowance](review/2026-09-30-usage-ink.png) and
[companion engine selection](review/2026-09-30-companion-engine.png).

The historical toolbar SVG assets are still bundled for existing identity
references; app toolbar controls now render catalogue symbols. New UI must
not use those legacy assets as action icons.

Activity whose live evidence expired uses the existing neutral `◌` mark with the
accessible label “Status unavailable” in desktop and TUI. It is neither Working
nor a new Ready result; no notification is generated by this state change.
