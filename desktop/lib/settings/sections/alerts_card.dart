library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../notify/alert_sounds.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/setting_row.dart';

/// Customize Harness ▸ Appearance: whether this Mac makes a noise for you.
///
/// One switch, because there is one decision. Splitting "finished" and "needs
/// you" into two was considered and dropped: somebody who wants to hear about
/// an agent that got stuck wants to hear about one that finished, and a second
/// switch buys a combination nobody asked for at the cost of a screen that
/// reads as configuration rather than as a preference.
class AlertsCard extends StatelessWidget {
  const AlertsCard({super.key, this.store});

  /// Injected by tests; the app reads the one the window loaded at start-up.
  final AlertSoundStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final store = this.store ?? alertSoundStore;
    return ValueListenableBuilder<bool>(
      valueListenable: store,
      builder: (context, on, _) => SettingRow(
        title: 'Alert sounds',
        detail:
            'Play a sound when an agent finishes, or stops to ask you '
            'something.',
        control: Align(
          alignment: Alignment.centerLeft,
          child: Switch(
            key: const Key('settings-alert-sounds'),
            value: on,
            onChanged: (next) => unawaited(store.set(next)),
          ),
        ),
      ),
    );
  }
}
