library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../notify/alert_sounds.dart';
import '../../notify/system_notifications.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/setting_row.dart';

/// Settings ▸ Notifications: how an agent gets your attention.
///
/// One switch per CHANNEL, because people differ about them — a banner is
/// welcome in a quiet office where a sound is not, and a notification from the
/// system reaches somebody the window cannot. "Finished" and
/// "needs you" are not split the same way: those are two triggers of one thing,
/// and somebody who wants to know about a stuck agent wants to know about a
/// finished one.
class AlertsCard extends StatelessWidget {
  const AlertsCard({
    super.key,
    this.store,
    this.screenStore,
    this.notifications,
  });

  /// Injected by tests; the app reads the ones the window loaded at start-up.
  final AlertSoundStore? store;
  final ScreenAlertStore? screenStore;
  final SystemNotifications? notifications;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final sound = store ?? alertSoundStore;
    final screen = screenStore ?? screenAlertStore;
    final system = notifications ?? systemNotifications;
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
        // Only where there is a notifier to switch: a row on Windows would be a
        // switch connected to nothing.
        if (system.supported) ...[
          const SizedBox(height: 10),
          ListenableBuilder(
            listenable: Listenable.merge([system.store, system.permission]),
            builder: (context, _) => SettingRow(
              title: 'Desktop notifications',
              detail: _systemDetail(
                clickOpensAgent: system.notifier.clickOpensAgent,
                on: system.store.value,
                permission: system.permission.value,
              ),
              control: Align(
                alignment: Alignment.centerLeft,
                child: Switch(
                  key: const Key('settings-desktop-notifications'),
                  value: system.store.value,
                  onChanged: (next) => unawaited(system.setEnabled(next)),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// What the notifications row says under its title. A switch that is on and
/// can do nothing has to say why, or it reads as broken.
String _systemDetail({
  required bool clickOpensAgent,
  required bool on,
  required NotificationPermission permission,
}) {
  final base =
      'Let the system tell you at the same two moments while Harness is not '
      'in front.${clickOpensAgent ? ' Click one to go to that agent.' : ''}';
  if (!on) return base;
  return switch (permission) {
    NotificationPermission.denied =>
      'Harness is not allowed to post notifications. Allow it in System '
          'Settings ▸ Notifications ▸ Harness.',
    NotificationPermission.unavailable =>
      'Notifications cannot be posted from this build or this computer. The '
          'on-screen banner still works.',
    _ => base,
  };
}
