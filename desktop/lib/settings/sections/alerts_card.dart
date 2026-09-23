library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../notify/alert_sounds.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/setting_row.dart';

/// Settings ▸ Notifications: how an agent gets your attention.
///
/// Two switches, because there are two CHANNELS and people differ about them —
/// a banner is welcome in a quiet office where a sound is not. "Finished" and
/// "needs you" are not split the same way: those are two triggers of one thing,
/// and somebody who wants to know about a stuck agent wants to know about a
/// finished one.
class AlertsCard extends StatelessWidget {
  const AlertsCard({super.key, this.store, this.screenStore});

  /// Injected by tests; the app reads the ones the window loaded at start-up.
  final AlertSoundStore? store;
  final ScreenAlertStore? screenStore;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final sound = store ?? alertSoundStore;
    final screen = screenStore ?? screenAlertStore;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ValueListenableBuilder<bool>(
          valueListenable: screen,
          builder: (context, on, _) => SettingRow(
            title: 'On-screen alerts',
            detail:
                'Show a banner when an agent finishes, or stops to ask you '
                'something. Click it to go to that agent.',
            control: Align(
              alignment: Alignment.centerLeft,
              child: Switch(
                key: const Key('settings-screen-alerts'),
                value: on,
                onChanged: (next) => unawaited(screen.set(next)),
              ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        ValueListenableBuilder<bool>(
          valueListenable: sound,
          builder: (context, on, _) => SettingRow(
            title: 'Alert sounds',
            detail: 'Play a sound at the same two moments.',
            control: Align(
              alignment: Alignment.centerLeft,
              child: Switch(
                key: const Key('settings-alert-sounds'),
                value: on,
                onChanged: (next) => unawaited(sound.set(next)),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
