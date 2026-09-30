import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'devices_page.dart';
import 'phone_navigation.dart' show phoneRoute;
import 'tty.dart';

/// "New device: X" across the top of the phone: a device this phone had never trusted joined the
/// account. Signing in is what makes a device trusted, so this is how one signed in by someone else
/// is seen. It stays until it is looked at or dismissed.
class NewDeviceBanner extends StatelessWidget {
  const NewDeviceBanner({
    super.key,
    required this.notifier,
    required this.navigator,
  });

  final AppNotifier notifier;
  final GlobalKey<NavigatorState> navigator;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (notifier.newDevices.isEmpty) return const SizedBox.shrink();
    final tty = Tty.of(context);
    final m = notifier.newDevices.first;
    final name = m.label.isEmpty ? 'A device' : m.label;
    final more = notifier.newDevices.length - 1;
    return SafeArea(
      bottom: false,
      child: Material(
        color: Color.alphaBlend(tty.red.withValues(alpha: 0.12), tty.ground),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 8, 8, 8),
          child: Row(
            children: [
              Expanded(
                child: TtyText(
                  'New device: $name${more > 0 ? ' +$more' : ''}',
                  key: const Key('new-device-banner'),
                ),
              ),
              TextButton(
                onPressed: () => notifier.dismissNewDevice(m.pub),
                child: const Text('Mine'),
              ),
              TextButton(
                onPressed: () => unawaited(
                  navigator.currentState?.push(
                    phoneRoute((_) => DevicesPage(notifier: notifier)),
                  ),
                ),
                child: const Text('Review'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
