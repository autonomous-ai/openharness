import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../state/app_state.dart';
import 'experimental_features.dart';
import 'sections/about_section.dart';
import 'sections/account_section.dart';
import 'sections/connectors_section.dart';
import 'sections/debug_section.dart';
import 'sections/experimental_section.dart';
import 'sections/notifications_section.dart';
import 'sections/privacy_section.dart';
import 'sections/routing_section.dart';
import 'sections/shortcuts_section.dart';
import 'sections/tab_invites_section.dart';
import 'sections/usage_section.dart';
import 'settings_section.dart';

/// The screen behind a [SettingsSection].
///
/// Switch immediately, disposing the previous section instead of retaining it
/// for a cross-fade while the new section starts its work.
class SettingsBody extends StatelessWidget {
  const SettingsBody({
    super.key,
    required this.section,
    required this.notifier,
    this.experimentalFeatures,
  });

  final SettingsSection section;
  final AppNotifier notifier;
  final ExperimentalFeaturesStore? experimentalFeatures;

  @override
  Widget build(BuildContext context) {
    final screen = switch (section) {
      SettingsSection.account => AccountSection(notifier: notifier),
      SettingsSection.usage => UsageSection(subscriptions: notifier.modelsMenu),
      SettingsSection.connectors => ConnectorsSection(notifier: notifier),
      SettingsSection.customize => throw StateError(
        'Customization opens over the workspace.',
      ),
      SettingsSection.notifications => const NotificationsSection(),
      SettingsSection.privacy when kIsWeb => PrivacySection(notifier: notifier),
      SettingsSection.privacy ||
      SettingsSection.experimental => ExperimentalSection(
        notifier: notifier,
        store: experimentalFeatures ?? notifier.experimentalFeatures,
      ),
      SettingsSection.routing => RoutingSection(notifier: notifier),
      SettingsSection.tabInvites => TabInvitesSection(notifier: notifier),
      SettingsSection.shortcuts => const ShortcutsSection(),
      SettingsSection.debug => const DebugSection(),
      SettingsSection.about => AboutSection(notifier: notifier),
    };
    return KeyedSubtree(key: ValueKey(section), child: screen);
  }
}
