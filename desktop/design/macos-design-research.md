# macOS design research

Sources checked **2026-09-29** for the unmerged `experiment/friendly-desktop`
branch. This note informs the desktop design system; it is research evidence,
not the canonical implementation specification.

The aim is a friendly, coherent Mac interface around the terminal. Preserve
terminal rendering and the established tab, pane, creation, and search
interactions. Improve hierarchy, legibility, consistency, and feedback without
changing the meaning or ownership of commands.

Apple has not reviewed or approved OpenHarness, and no Apple award is claimed.
Award references below describe the named reference apps only.

## What Apple recommends

### Notification menu refinement — 2026-10-01

Apple's [notification guidance](https://developer.apple.com/design/human-interface-guidelines/notifications?changes=_4)
prioritizes a recognizable title or sender and concise, informative content.
The [Mac Notification Center guide](https://support.apple.com/en-euro/guide/mac-help/mchl2fb1258f/mac)
documents opening the associated item, expanding groups and clearing notifications.

Our application of these patterns: a semibold harness name followed directly
by its message; quiet timestamps; secondary tab/machine context on hover;
and one small clear control beside the heading. Working is visible by default
as compact rows. Status marks reuse the tab/pane activity vocabulary, as the
user requested. This is an AppKit menu, not a replica of Notification Center:
the system owns its material, placement, keyboard navigation and dismissal.
Row measurements and the five-item limits are Harness design choices.

### Broader desktop guidance

These are paraphrases of primary sources. The numerical proposals later in this
note are our choices, not Apple requirements.

| Topic | Guidance relevant to OpenHarness | Primary source |
| --- | --- | --- |
| Mac workspaces | Support comfortable information density, flexible windows, keyboard operation, and access to commands through the menu bar. | [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/) |
| Toolbars | Choose frequently useful actions deliberately and group related controls clearly. Standard components help maintain platform consistency. | [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) |
| Typography | Use the system face and semantic hierarchy. Apple's Mac text-style table lists 13-point body text with a 16-point line height. | [Typography, Japanese edition](https://developer.apple.com/jp/design/human-interface-guidelines/typography) |
| Focus | Text and search fields generally use a focus ring; lists use a row highlight. Avoid unexpected focus changes. | [Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/) |
| Color | Custom palettes need light, dark, and increased-contrast variants. Communicate meaningful state through labels or shapes as well as color. | [Color](https://developer.apple.com/design/human-interface-guidelines/color?changes=_2_2) |
| Contrast | Check foreground/background contrast in every appearance. Apple recommends at least 4.5:1 and encourages stronger contrast for custom small text. | [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) |
| Sheets | Use sheets for scoped tasks related to the parent view. Back navigates within a flow; Close or Cancel dismisses it. | [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets?changes=_1_1) |
| Menus | Group related commands, order important actions usefully, and keep submenu hierarchy shallow. Use consistent icon treatment within a group. | [Menus](https://developer.apple.com/design/human-interface-guidelines/menus?changes=_4_1_8) |
| Motion | Use animation to explain feedback or transitions, keep it optional, and avoid distracting motion. | [Motion](https://developer.apple.com/design/human-interface-guidelines/motion?changes=l_9_3) |
| Accessibility | Describe interface elements for VoiceOver and provide non-color indicators for meaningful distinctions. | [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility?changes=latest_maj_6_3&language=objc) |

Two WWDC sessions help translate these principles into a component system:

- [Get to know the new design system, WWDC25](https://developer.apple.com/videos/play/wwdc2025/356/)
  describes shared component anatomy and consistent core interactions. For our
  pickers, this suggests stable positions for checkmarks, labels, and accessories.
- [Meet Liquid Glass, WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/)
  explains the material's functional role. In this Flutter implementation,
  legibility over terminal output takes precedence over imitating that effect.

Our interpretation: native behavior and clear content hierarchy matter more to
this Flutter redesign than simulating every Liquid Glass effect. A visual
refresh should preserve the existing fast input and draft-restoration behavior.

## Product examples and our interpretation

These observations use official product descriptions and examples, not a
hands-on audit. They are design references, not templates to copy.

| Reference | Documented pattern | Useful interpretation for OpenHarness |
| --- | --- | --- |
| **Things** | Its editor keeps optional details secondary, and Quick Find emphasizes immediate results. Things documents its Apple Design Awards in 2009 and 2017. [Features](https://culturedcode.com/things/features/), [award history](https://culturedcode.com/things/blog/2017/06/back-from-wwdc/) | Keep the task editor dominant, configuration calm, and search feedback immediate. For example, changing Model should preserve both the draft and the editor's visual position. |
| **Bear** | Its official presentation emphasizes a minimal native interface and gradually revealed capabilities. Apple named Bear a 2017 Design Award winner. [Product](https://bear.app/), [Apple announcement](https://www.apple.com/newsroom/2017/06/apple-design-awards-celebrate-the-best-in-innovation-and-creativity/) | Put personality in meaningful agent marks and considered color; use typography and spacing for the rest. Avoid decorating every setting with an unrelated symbol. |
| **Ulysses** | Its product page pairs a focused editor with substantial project organization and identifies it as an Apple Design Award winner. [Product](https://ulysses.app/) | Keep secondary power accessible through the existing menus and previews without making every option equally prominent. |
| **Play** | Apple praises approachable access to sophisticated prototyping and an organized interface in its 2025 award description. [Apple Design Awards](https://developer.apple.com/design/awards/2025/) | Judge the redesign by whether a newcomer can understand the next action while experienced users retain efficient controls. |

## Chosen starting measurements

These are proposals to evaluate in rendered fixtures. They are not a claim of
pixel-for-pixel AppKit fidelity. Values use Flutter logical pixels; verify their
appearance at the native window scale and with enlarged text.

| Role | Starting proposal | Example |
| --- | --- | --- |
| Control label | System sans, 13 size / 16 line height, regular or medium | Agent, Repo, Model |
| Body and editor prose | System sans, 14 / 20 | Task text and explanations |
| Secondary metadata | System sans, 12 / 16 | Machine or session context |
| Section heading | System sans, 17 / 22, medium | Resource-management section |
| Spacing | 4, 8, 12, 16, 24 scale | About 8 within a group, 16 between groups, 20–24 at panel edges |
| Controls | 32 regular, 28 compact minimum height; grow for text | Standard selector versus inline setting |
| Icons | Approximately 16, optically aligned to text | Menu chevron or control glyph |
| Shapes | Start from existing 8-point controls and 16-point palette; evaluate nested corners together | Keep Agent/Repo capsules as deliberate selector variants |

Paths, shortcut hints, and terminal content retain their established typography.
Use the semantic role to choose a style rather than shrinking text until it fits.
Long values should preserve useful context through truncation and complete
accessible labels or tooltips.

## Findings in the existing implementation

- [`DesktopChrome.text`](../lib/widgets/desktop_chrome.dart) already uses the
  system body face, but gives all roles the same `1.45` line-height multiplier.
  Separate control, prose, metadata, and heading roles for more consistent density.
- `DesktopPill` currently gives hover and press the same overlay. Its focus fill
  also replaces its selected fill, so focused-selected is not a separately
  designed state. Review this explicitly, especially for scope selectors. Keep
  focus feedback visible without changing bounds or moving neighboring controls.
- The declared `focusRing` token is unused by `DesktopPill`. A quiet fill can
  remain the normal treatment; provide a stronger, distinguishable treatment for
  increased contrast and verify text-field focus separately. Existing opacity
  values alone do not establish an accessibility failure or a passing result.
- Consolidate chooser row anatomy, menu insets, separators, and shadows. For
  example, Open Folder and Clone should align their labels and accessory columns
  even when only one opens a nested step. Do not add decorative cards around
  each group.
- The frameless composer backdrop and search palette are intentional experiment
  decisions. Preserve their established behavior. Do not automatically reuse
  their modal treatment for unrelated settings or small menus.
- Keep new chrome tokens separate from terminal tokens. `AppControl` contains
  historical opinions about exact macOS shapes; they are not universal Apple
  rules. The experiment and validation documents also describe different
  composer iterations and need reconciliation in the canonical specification.
- Current immediate hover, selection, and keyboard feedback is a sound baseline.
  Optional transition polish must not delay typing, focus, results, or dismissal.

## Review checklist

Use synthetic content and the actual system fonts. Record what was exercised;
widget or coverage results do not establish native accessibility behavior.

- [ ] **Light and dark:** inspect controls, metadata, selections, borders,
  shadows, errors, and long values; measure rendered text contrast.
- [ ] **High contrast:** enable Increase Contrast; verify control boundaries and
  focus, selected, disabled, and inactive-window distinctions.
- [ ] **Reduced motion:** enable Reduce Motion; keep all state changes
  understandable without movement. Check Reduce Transparency if materials are used.
- [ ] **Resize and text:** review minimum width, short windows, enlarged text,
  long Unicode names, and live resizing without clipped or displaced actions.
- [ ] **Keyboard and pointer:** traverse both directions, use arrows and existing
  shortcuts, inspect hover and press feedback, and verify focus returns to the
  originating control after chooser acceptance or cancellation.
- [ ] **Accessibility:** use VoiceOver and Accessibility Inspector to check names,
  roles, values, selection, disabled state, reading order, and modal containment.
- [ ] **IME:** exercise native composition, candidate selection, paste, and
  multiline editing; Return during composition must not accidentally launch.
- [ ] **Continuity:** retain drafts, query, selection, and underlying terminals
  through the existing New/Search round trips. No input should leak to terminals.

The existing friendly-desktop validation explicitly leaves physical AppKit IME
and VoiceOver unverified. Keep those limitations visible until native review has
actually been performed.

## Second research pass: relationships before tokens

Rechecked primary sources after the user challenged whether the first system
was exceptional enough. The first document established consistency; that did
not establish exceptional visual quality. There is no defensible objective
ranking of a "best ever" design system, nor evidence that Jony Ive would endorse
this particular interface.

### Evidence examined

- **Apple, Get to know the new design system, WWDC25:** read the transcript,
  especially shape, structure and continuity. Apple explicitly distinguishes
  compact rounded-rectangle controls from larger capsule controls on Mac.
  Its spatial treatment ties secondary surfaces to their source. This supports
  a hierarchy of related shapes, rather than giving every element an identical
  pill. [Primary source](https://developer.apple.com/videos/play/wwdc2025/356/)
- **Apple, Materials:** materials have functional roles. Our choice is a quiet,
  legible floating panel; no claim of implementing native Liquid Glass.
  [Primary source](https://developer.apple.com/design/human-interface-guidelines/materials)
- **Things:** read the official feature account and visually inspected its
  presented editor. A plain writing area is dominant; optional date/tag details
  occupy a secondary edge. This is a product-page visual study, not a hands-on
  usability test. [Primary source](https://culturedcode.com/things/features/)
- **Raycast:** read the May 2026 engineering/design account and visually inspected
  its interface montage. Compact labels, anchored menus and restrained controls
  share a consistent density. Its stated native-quality criteria include
  opening behavior and preventing clipped popovers or flicker. Our hand cursor
  remains an explicit user preference, despite Raycast choosing otherwise.
  [Primary source](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast)
- **Jony Ive's published design principle:** Apple's 2013 announcement quotes
  his emphasis on "bringing order to complexity". Our interpretation is to
  simplify structure, defaults and interaction before adding effects. It is
  not a prediction of his present-day design choices.
  [Primary source](https://www.apple.com/newsroom/2013/06/10Apple-Unveils-iOS-7/)

### Changes this research calls for

The canonical specification now starts with a design brief and explicit visual
relationships before its measurements. Review must compare actual surfaces side
by side. The task is the focal point; controls use a limited shared family;
identity comes from real agent marks; depth explains ownership; behavior carries
continuity. Dense terminal output remains visually independent.

The review should reject an oversized empty search panel, nested decorative
cards, redundant icons, competing selection treatments, inconsistent typography,
weak text contrast, unstable focus or a lost draft even if each local component
passes its tests. Any responsive adjustment must retain stable editor geometry
and the existing controller's query, selection and preview state.


## Settings and supporting-surface review

The next primary-source pass focused on small interaction details rather than
adding decoration. Apple's [VoiceOver evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/voiceover-evaluation-criteria)
and [accessibility design session](https://developer.apple.com/videos/play/wwdc2025/229/)
informed purpose, value and state labels for controls. The implementation now
exposes those separately and avoids merging multiple actions into one setting.
Widget semantics tests establish that metadata; a native VoiceOver pass is still
required to evaluate actual navigation and announcements.

Apple's [writing guidance](https://developer.apple.com/design/human-interface-guidelines/writing)
encouraged clearer action and recovery language. The review found that “Choose a
machine” must lead directly to the existing chooser when a selected machine
vanishes. The creator keeps its prompt and explicit launch choices during that
recovery. Loading is also separated from settled emptiness in search.

[Nova's documented settings](https://help.nova.app/settings/) and
[appearance settings](https://help.nova.app/settings/theme/) were examined as
examples of organizing configuration. Search vocabulary and returning to the last
settings pane remain possible later improvements; they were not silently added
as part of this presentation pass. Measured content height, clear grouping and
consistent control labels were actionable within the current scope.
