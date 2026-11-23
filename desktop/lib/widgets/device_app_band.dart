import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_icons.dart';

import '../devices/device_app.dart';
import '../devices/device_app_offer.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'window_chrome.dart';

/// The band across the top of the window offering the Harness menu-bar app (the tray app off macOS) while a dial is attached and the app is
/// not installed: `Not now`, then `Install`, then `Installing…`, then the app opens or the failure line and `Retry`.
class DeviceAppBand extends StatelessWidget {
  const DeviceAppBand({
    super.key,
    required this.offer,
    this.leadingClearance,
    this.platform,
  });

  final DeviceAppOffer offer;

  /// Whose words it says; null is [defaultTargetPlatform]. The gallery passes each OS so it draws them on any host.
  final TargetPlatform? platform;

  /// The room left for the traffic lights; null is [trafficLightClearance]. The gallery passes 0 so its image is the
  /// same on every host.
  final double? leadingClearance;

  // Listens itself, so the shell need not rebuild when only the offer changes.
  @override
  Widget build(BuildContext context) =>
      ListenableBuilder(listenable: offer, builder: _build);

  Widget _build(BuildContext context, Widget? _) {
    grid.AppTheme.watch(context);
    if (!offer.bandVisible) return const SizedBox.shrink();
    final installing = offer.state == DeviceAppOfferState.installing;
    final failedStep = offer.failedStep;
    final accent = grid.AppPalette.warn;
    final tint = Color.alphaBlend(
      accent.withValues(alpha: 0.10),
      grid.AppPalette.windowBg,
    );
    return WindowDragArea(
      child: Material(
        color: Colors.transparent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tint,
            border: Border(
              bottom: BorderSide(color: accent.withValues(alpha: 0.28)),
            ),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              14 + (leadingClearance ?? trafficLightClearance),
              7,
              10,
              7,
            ),
            child: Row(
              children: [
                Icon(
                  failedStep == null
                      ? AppIcons.arrowDownToLine
                      : AppIcons.triangleAlert,
                  size: 16,
                  color: accent,
                ),
                const SizedBox(width: 10),
                Expanded(
                  // Announced when it turns into a failure line: the person pressed Install and is waiting on it.
                  child: Semantics(
                    container: true,
                    liveRegion: failedStep != null,
                    child: Text(
                      failedStep?.failureLine ??
                          deviceAppCopy(platform ?? defaultTargetPlatform).band,
                      key: const Key('device-app-band'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.body(
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(
                  key: const Key('device-app-band-dismiss'),
                  // Disabled while an install runs, as the update band's Skip is.
                  onPressed: installing
                      ? null
                      : () => unawaited(offer.dismiss()),
                  child: const Text('Not now'),
                ),
                const SizedBox(width: 6),
                OutlinedButton(
                  key: const Key('device-app-band-install'),
                  // Installed but not opened: Retry only opens it, with no second download.
                  onPressed: installing
                      ? null
                      : failedStep == DeviceAppInstallStep.open
                      ? () => unawaited(offer.open())
                      : () => unawaited(offer.install()),
                  child: Text(
                    installing
                        ? 'Installing…'
                        : failedStep == null
                        ? 'Install'
                        : 'Retry',
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
