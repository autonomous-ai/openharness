import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../logging/debug_surface.dart';

/// A Settings navigation entry. Customize returns to the workspace and opens
/// its side panel; the other entries select a Settings page.
///
/// Declared once, like [ShortcutAction] in `shortcuts/app_shortcuts.dart`: the
/// rail, the search filter and the pane all read this list, so a section cannot
/// be listed without a screen behind it or reachable without a row.
enum SettingsSection {
  account(AppIcons.user, 'Account'),
  accountDevices(AppIcons.shieldCheck, 'Your devices'),
  profiles(AppIcons.monitor, 'Profiles'),
  usage(AppIcons.chartNoAxesColumn, 'Usage'),
  connectors(AppIcons.plug, 'Connectors'),
  customize(AppIcons.palette, 'Customize'),
  notifications(AppIcons.bell, 'Notifications'),
  experimental(AppIcons.flaskConical, 'Experimental'),
  devices(AppIcons.zap, 'Autonomous robots'),
  shortcuts(AppIcons.keyboard, 'Keyboard shortcuts'),
  debug(AppIcons.bug, 'Debug'),
  about(AppIcons.info, 'About');

  const SettingsSection(this.icon, this.label);

  /// The rail glyph — Lucide's 300 weight, the one the machine rail's rows use,
  /// so the app's two nav columns draw at the same line weight.
  final IconData icon;
  final String label;
}

/// One labelled run of rows in the settings rail.
///
/// The grouping is presentation only — [settingsGroups] flattens back to every
/// section — but it says something true: the first run is what you *change*,
/// the second is what you *consult*.
class SettingsGroup {
  const SettingsGroup(this.title, this.sections);

  /// The caption over the run. A caption, not a sentence.
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
      // This computer's own: the Autonomous robots and the services its agents use.
      (!kIsWeb || (section != SettingsSection.devices && section != SettingsSection.connectors)) &&
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
  // Usage sits with the preferences rather than with Debug, which it
  // otherwise resembles: that is developer furniture a shipped build
  // hides, and this is a screen anybody is meant to open. It earns its place in
  // a run titled "what you change" by carrying the three switches that decide
  // which logs are read at all — the pane is off until somebody sets it.
  SettingsGroup('Preferences', [
    SettingsSection.usage,
    SettingsSection.customize,
    // Beside Customize because it is the same kind of decision — how this Mac behaves while you
    // work — and NOT inside it, which is where the alert switch started. Customize is about how
    // the app looks; a sound is not a look, and somebody turning one off does not think to look
    // under Appearance for it.
    SettingsSection.notifications,
    SettingsSection.experimental,
    SettingsSection.devices,
    // The services this computer's agents use (Linear, Notion, GitHub…), connected once for all of them.
    SettingsSection.connectors,
    SettingsSection.account,
    // Beside Account: the devices signed in to it, each trusted by the others because of that.
    SettingsSection.accountDevices,
    SettingsSection.profiles,
  ]),
  // Debug sits between the two things it is most often reached from: the keys
  // that open it, and the version a report has to name.
  SettingsGroup('Help', [
    SettingsSection.shortcuts,
    SettingsSection.debug,
    SettingsSection.about,
  ]),
];

/// The section Settings opens on — the first row of the first group, so the
/// screen never opens on a pane its rail doesn't show as selected.
///
/// Derived rather than named, so a reordered or gated first group cannot open
/// Settings on a pane with no row lit in the rail beside it.
SettingsSection get kDefaultSettingsSection =>
    settingsGroups.first.sections.first;
