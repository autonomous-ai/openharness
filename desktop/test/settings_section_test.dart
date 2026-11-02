// Debug is developer furniture, so a shipped build hides it. The flag behind that
// is a compile-time const and a test run has it ON — which is the whole difficulty, since the
// shape worth guarding is the one no test build has. `settingsGroupsFor` takes the gate as an
// argument for exactly this.
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import 'package:harness/logging/debug_surface.dart';
import 'package:harness/settings/settings_section.dart';

void main() {
  List<SettingsSection> sectionsOf(List<SettingsGroup> groups) => [
    for (final group in groups) ...group.sections,
  ];

  test('a test build lists the developer sections', () {
    expect(kDebugSurfaceEnabled, isTrue, reason: 'tests run in debug mode');
    expect(sectionsOf(settingsGroups), contains(SettingsSection.debug));
  });

  test('Settings opens on a row the rail actually shows', () {
    expect(sectionsOf(settingsGroups), contains(kDefaultSettingsSection));
    final shipped = settingsGroupsFor(debugSurface: false);
    expect(shipped.first.sections.first, SettingsSection.account);
    expect(kDefaultSettingsSection, SettingsSection.account);
  });

  test('everything outside the gate is always listed', () {
    expect(sectionsOf(settingsGroupsFor(debugSurface: false)), [
      SettingsSection.account,
      SettingsSection.customize,
      SettingsSection.notifications,
      if (kIsWeb) SettingsSection.privacy,
      SettingsSection.shortcuts,
      // What agents may do is the account's, under Experimental (owner, 2026-10-12).
      if (!kIsWeb) SettingsSection.connectors,
      // Usage carries no gate of its own: it reads only this machine's own
      // files, and it reads nothing at all until a provider is switched on, so
      // there is nothing here for a shipped build to hide.
      SettingsSection.usage,
      SettingsSection.tabInvites,
      SettingsSection.experimental,
      SettingsSection.about,
    ]);
  });

  test('the rail: Account alone, then General, Agents, Labs and Help', () {
    final groups = settingsGroupsFor(debugSurface: true);
    expect(groups.map((g) => g.title), [
      '',
      'General',
      'Agents',
      'Labs',
      'Help',
    ]);
    expect(groups.map((g) => g.sections), [
      [SettingsSection.account],
      [
        SettingsSection.customize,
        SettingsSection.notifications,
        if (kIsWeb) SettingsSection.privacy,
        SettingsSection.shortcuts,
      ],
      [if (!kIsWeb) SettingsSection.connectors, SettingsSection.usage],
      [SettingsSection.tabInvites, SettingsSection.experimental],
      [SettingsSection.about, SettingsSection.debug],
    ]);
    // Customize keeps its name in the palette's memory; the rail calls it Appearance.
    expect(SettingsSection.customize.label, 'Appearance');
  });

  test('Appearance is found by its old name and by what its panel holds', () {
    for (final query in [
      'appear',
      'customize',
      'workspace',
      'wallpaper',
      'theme',
      'palette',
      'font',
    ]) {
      expect(SettingsSection.customize.matches(query), isTrue, reason: query);
    }
    expect(SettingsSection.customize.matches('notif'), isFalse);
    // A row with no keywords is found by its label alone.
    expect(SettingsSection.notifications.matches('notif'), isTrue);
    expect(SettingsSection.notifications.matches('customize'), isFalse);
  });

  test('nothing in Settings is a thing that lives elsewhere', () {
    expect(
      SettingsSection.values.map((s) => s.name),
      isNot(
        anyOf(
          contains('accountDevices'),
          contains('profiles'),
          contains('devices'),
        ),
      ),
    );
  });
}
