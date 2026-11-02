import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../logging/debug_surface.dart';

/// A Settings navigation entry. Appearance ([customize]) returns to the workspace and opens its
/// side panel, also called Appearance; the other entries select a Settings page.
///
/// Settings holds settings only. What is a thing rather than a setting lives where the thing is:
/// the Autonomous robots in the Devices tab, the account's computers, phones and apps — and which
/// of them this window shows — in Machines.
///
/// Declared once, like [ShortcutAction] in `shortcuts/app_shortcuts.dart`: the
/// rail, the search filter and the pane all read this list, so a section cannot
/// be listed without a screen behind it or reachable without a row.
enum SettingsSection {
  account(AppIcons.user, 'Account'),
  // Named `customize` still: the command palette remembers `settings:customize`. Its panel's
  // tabs and its old name find it too.
  customize(
    AppIcons.palette,
    'Appearance',
    keywords: [
      'customize',
      'status',
      'workspace',
      'wallpaper',
      'terminal',
      'theme',
      'colors',
      'palette',
      'font',
    ],
  ),
  notifications(AppIcons.bell, 'Notifications'),
  privacy(AppIcons.shieldCheck, 'Privacy'),
  shortcuts(AppIcons.keyboard, 'Keyboard shortcuts'),
  connectors(AppIcons.plug, 'Connectors'),
  usage(AppIcons.chartNoAxesColumn, 'Usage'),
  tabInvites(
    AppIcons.users,
    'Tab invites',
    keywords: ['invite', 'shared tab', 'trust'],
  ),
  experimental(
    AppIcons.flaskConical,
    'Experimental',
    keywords: kIsWeb ? [] : ['privacy', 'sharing', 'product usage data'],
  ),
  about(AppIcons.info, 'About'),
  debug(AppIcons.bug, 'Debug');

  const SettingsSection(this.icon, this.label, {this.keywords = const []});

  /// The rail glyph — Lucide's 300 weight, the one the machine rail's rows use,
  /// so the app's two nav columns draw at the same line weight.
  final IconData icon;
  final String label;

  /// Other words the rail's filter and ⌘P find this row by, lowercase: what is inside a row
  /// whose label does not say it, and a name it had before.
  final List<String> keywords;

  /// Whether [query] (trimmed, lowercase) finds this row: in its label or one of its [keywords].
  bool matches(String query) =>
      label.toLowerCase().contains(query) ||
      keywords.any((keyword) => keyword.contains(query));
}

/// One labelled run of rows in the settings rail.
///
/// The grouping is presentation only — [settingsGroups] flattens back to every
/// section — but it says something true: who is signed in, how the app behaves,
/// what agents may do, what is still taking shape, and what to consult.
class SettingsGroup {
  const SettingsGroup(this.title, this.sections);

  /// The caption over the run. A caption, not a sentence; empty for a run that needs none
  /// (Account, alone at the top).
  final String title;
  final List<SettingsSection> sections;
}

/// What Settings lists, in order.
///
/// A getter rather than a `const`, for the row that is not always there:
/// [SettingsSection.debug] is developer furniture and ships only where
/// [kDebugSurfaceEnabled] says so. Everything
/// that draws or searches the rail reads this, so a hidden section cannot be
/// reached by a stale copy of the list — while the enum values themselves
/// always exist, so the screens behind them need no gate of their own.
List<SettingsGroup> get settingsGroups =>
    settingsGroupsFor(debugSurface: kDebugSurfaceEnabled);

/// [settingsGroups] with the gate passed in rather than read off the build.
///
/// The flag is a compile-time const, so the shape a SHIPPED build has — no
/// Debug — is otherwise unreachable from a test, which by
/// definition runs with it switched on. This seam is the only way to assert
/// the thing the gate exists to do.
@visibleForTesting
List<SettingsGroup> settingsGroupsFor({required bool debugSurface}) {
  bool visible(SettingsSection section) =>
      // This computer's own: the services its agents use.
      (!kIsWeb || section != SettingsSection.connectors) &&
      (kIsWeb || section != SettingsSection.privacy) &&
      (debugSurface || !_kDeveloperSections.contains(section));
  return [
    for (final group in _kSettingsGroups)
      if (group.sections.any(visible))
        SettingsGroup(group.title, [
          for (final section in group.sections)
            if (visible(section)) section,
        ]),
  ];
}

/// The developer sections, named once: worth nothing in a build that cannot
/// open them, and a second list of "which ones are hidden" would drift.
const _kDeveloperSections = {SettingsSection.debug};

const _kSettingsGroups = [
  // Who is signed in, first and alone: Settings opens on it.
  SettingsGroup('', [SettingsSection.account]),
  SettingsGroup('General', [
    SettingsSection.customize,
    // Beside Appearance because it is the same kind of decision — how this Mac behaves while you
    // work — and NOT inside it, which is where the alert switch started. A sound is not a look,
    // and somebody turning one off does not think to look under Appearance for it.
    SettingsSection.notifications,
    SettingsSection.privacy,
    SettingsSection.shortcuts,
  ]),
  // What agents may do with Harness is the account's: Labs ▸ Experimental (owner, 2026-10-12).
  SettingsGroup('Agents', [
    // The services this computer's agents use (Linear, Notion, GitHub…), connected once for all of them.
    SettingsSection.connectors,
    // What the agents on this machine have spent. It carries the switches that decide which logs
    // are read at all — the pane is off until somebody sets it.
    SettingsSection.usage,
  ]),
  SettingsGroup('Labs', [
    SettingsSection.tabInvites,
    SettingsSection.experimental,
  ]),
  // Debug, in builds that have it, beside the version a report has to name.
  SettingsGroup('Help', [SettingsSection.about, SettingsSection.debug]),
];

/// The section Settings opens on — the first row of the first group, so the
/// screen never opens on a pane its rail doesn't show as selected.
///
/// Derived rather than named, so a reordered or gated first group cannot open
/// Settings on a pane with no row lit in the rail beside it.
SettingsSection get kDefaultSettingsSection =>
    settingsGroups.first.sections.first;
