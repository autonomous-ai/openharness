import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/setting_row.dart';
import '../theme/app_theme.dart';
import 'device_app.dart';
import 'device_app_offer.dart';

/// The menu-bar app (the tray app off macOS) on the Devices tab, for a dial on this computer. Unlike the band, `Not now` does not hide it.
class DeviceAppRow extends StatelessWidget {
  const DeviceAppRow({super.key, required this.offer, this.platform});

  final DeviceAppOffer offer;

  /// Whose words it says; null is [defaultTargetPlatform]. The gallery passes each OS so it draws them on any host.
  final TargetPlatform? platform;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: offer,
    builder: (context, _) {
      final state = offer.state;
      if (state == DeviceAppOfferState.hidden) return const SizedBox.shrink();
      final failed = offer.failedStep;
      final copy = deviceAppCopy(platform ?? defaultTargetPlatform);
      void install() => unawaited(offer.install());
      void open() => unawaited(offer.open());
      // Installed but not opened only needs opening: no second download.
      final (label, onPressed) = switch (state) {
        DeviceAppOfferState.installing => ('Installing…', null),
        DeviceAppOfferState.notRunning => ('Open', open),
        _ when failed == DeviceAppInstallStep.open => ('Open', open),
        DeviceAppOfferState.failed => ('Retry', install),
        _ => ('Install', install),
      };
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: SettingRow(
          key: const Key('device-app-row'),
          title: copy.title,
          detail: copy.detail,
          controlSemanticLabel: copy.title,
          control: OutlinedButton(
            key: const Key('device-app-row-action'),
            onPressed: onPressed,
            child: Text(label),
          ),
          footer: failed == null
              ? null
              : Semantics(
                  liveRegion: true,
                  child: Text(
                    failed.failureLine,
                    key: const Key('device-app-row-failure'),
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: AppColors.danger),
                  ),
                ),
        ),
      );
    },
  );
}
