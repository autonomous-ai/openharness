library;

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/section_scaffold.dart';
import 'alerts_card.dart';

/// Settings ▸ Notifications: how this Mac gets your attention.
///
/// Its own row in the rail rather than a card inside Customize, which is where
/// the alert switch started. Customize is about how the app LOOKS, and a sound
/// is not a look — somebody who wants to silence one does not go looking under
/// Appearance for it, which is exactly how it went the first time.
///
/// One switch today. The row exists because this is where the next ones belong
/// — a desktop notification, a single agent muted, a choice of sound — and each
/// of those would otherwise find the same wrong home for the same reason.
class NotificationsSection extends StatelessWidget {
  const NotificationsSection({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return const SectionScaffold(
      title: 'Notifications',
      subtitle: 'How Harness gets your attention while you work.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AlertsCard(),
            // Room under the last control so a scrolled-to-bottom pane does not
            // end flush against the window edge.
            SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
