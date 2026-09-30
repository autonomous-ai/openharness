import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_icons.dart';

import '../settings/settings_screen.dart';
import '../settings/settings_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'window_chrome.dart';

/// The band across the top of the window when a device this end had never trusted joined the
/// account ("New device: X"). Signing in is what makes a device trusted, so this is how a device
/// signed in by someone else — or added by whoever runs the backend — is seen. One notice at a
/// time, newest last; each stays until it is looked at or dismissed.
class NewDeviceNotice extends StatelessWidget {
  const NewDeviceNotice({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (notifier.newDevices.isEmpty) return const SizedBox.shrink();
    final notice = notifier.newDevices.first;
    final more = notifier.newDevices.length - 1;
    final tint = Color.alphaBlend(grid.AppPalette.warn.withValues(alpha: 0.10), grid.AppPalette.windowBg);
    return WindowDragArea(
      child: Material(
        color: Colors.transparent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tint,
            border: Border(bottom: BorderSide(color: grid.AppPalette.warn.withValues(alpha: 0.28))),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(14 + trafficLightClearance, 7, 10, 7),
            child: Row(
              children: [
                Icon(AppIcons.shield, size: 16, color: grid.AppPalette.warn),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${notice.sentence}${more > 0 ? ' (+$more more)' : ''} Not yours? Remove it.',
                    key: const Key('new-device-notice'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(
                  key: const Key('new-device-dismiss'),
                  onPressed: () => notifier.dismissNewDevice(notice.pub),
                  child: const Text('It’s mine'),
                ),
                const SizedBox(width: 6),
                OutlinedButton(
                  key: const Key('new-device-review'),
                  onPressed: () => unawaited(
                    showSettingsScreen(
                      context,
                      notifier,
                      initialSection: SettingsSection.accountDevices,
                      source: 'new-device-notice',
                    ),
                  ),
                  child: const Text('Review devices'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
