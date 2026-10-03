import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../daemons/illustrated_art.dart';
import '../daemons/zoo.dart';
import '../daemons/zoo_controller.dart';
import '../shared/theme/app_type.dart';
import '../state/dial_status.dart';
import '../theme/app_theme.dart';
import 'companion_story.dart';

/// Device choices use the existing zoo pair operation and addressed settings
/// patch. Only a device acknowledgement earns the "on your dial" state.
class CompanionDial extends StatelessWidget {
  const CompanionDial({
    super.key,
    required this.dial,
    required this.zoo,
    required this.daemon,
    required this.setDeviceSettings,
  });

  final DialState dial;
  final ZooController zoo;
  final ZooDaemon daemon;
  final void Function(String, Map<String, Object?>) setDeviceSettings;

  TextStyle _style(double size, Color color) => TextStyle(
    fontFamily: AppType.sansFamily,
    fontFamilyFallback: AppType.sansFallback,
    fontSize: size,
    height: 1.5,
    color: color,
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: dial,
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (dial.devices.isEmpty)
          _card(
            title: 'A little company on your desk',
            detail: 'Connect your dial to bring your companion along. It follows your chosen companion, including their growth and appearance.',
          ),
        for (final device in dial.devices) _device(device),
      ],
    ),
  );

  Widget _device(DialStatus device) {
    final name = companionName(daemon);
    final settings = device.settings;
    final art = IllustratedArt.daemon(daemon.id, traits: zoo.traitsOf(daemon));
    final shown = settings?.companionDetails;
    final modern = settings?.companionProtocol == 2;
    final paired = zoo.zoo.pair == daemon.uid;
    final matches =
        settings?.followCompanion == true &&
        settings?.companion == daemon.id &&
        (!modern ||
            (shown?.id == daemon.id &&
                shown?.uid == daemon.uid &&
                shown?.version == daemon.version &&
                shown?.seed == daemon.seed &&
                shown?.colour == art.colour &&
                shown?.mark == art.mark));
    final supported = settings?.followCompanion != null;
    final available =
        device.attached &&
        device.updating == null &&
        supported &&
        device.id != null &&
        !zoo.isPreview;
    final syncing = paired && settings?.followCompanion == true && !matches;
    final title = !device.attached
        ? 'Your dial is unplugged'
        : device.updating != null
        ? 'Your dial is updating'
        : settings == null
        ? 'Connecting to your dial…'
        : !supported
        ? 'Your dial needs a companion update'
        : paired && matches
        ? '$name is on your dial'
        : syncing
        ? 'Bringing $name to your dial…'
        : 'Bring $name to your dial';
    final detail = !device.attached
        ? 'Plug it back in. Your companion will catch up when it reconnects.'
        : device.updating != null
        ? 'Your companion will reconnect when the update finishes.'
        : settings == null
        ? 'Waiting for the device to report its settings.'
        : !supported
        ? 'Update its firmware in Settings → Devices to enable companions.'
        : !paired
        ? 'Choose $name for your desktop and dial together.'
        : settings.followCompanion == false
        ? 'Your dial is using its own character. Let it follow your companion here.'
        : syncing
        ? 'Waiting for the dial to confirm the change.'
        : !modern
        ? 'Your companion is connected. Update the dial firmware to sync growth and appearance too.'
        : 'Same companion, same little details. Changes here follow you to your dial.';
    return _card(
      key: ValueKey('companion-dial:${device.id}'),
      title: title,
      detail: detail,
      footnote: dial.devices.length > 1 ? device.mac ?? device.id : null,
      action: available && (!paired || !matches)
          ? OutlinedButton.icon(
              key: ValueKey('companion-dial-switch:${device.id}'),
              onPressed: () {
                zoo.pair(daemon.uid);
                setDeviceSettings(device.id!, {'followCompanion': true});
              },
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.text,
                padding: const EdgeInsets.symmetric(
                  horizontal: 15,
                  vertical: 12,
                ),
                side: BorderSide(color: AppColors.border),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              icon: Icon(
                syncing ? AppIcons.refreshCw : AppIcons.heart,
                size: 16,
              ),
              label: Text(
                syncing ? 'Try sync again' : 'Show $name on dial',
                style: _style(13, AppColors.text),
              ),
            )
          : null,
    );
  }

  Widget _card({
    Key? key,
    required String title,
    required String detail,
    String? footnote,
    Widget? action,
  }) => Container(
    key: key,
    margin: const EdgeInsets.only(top: 14),
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: AppColors.text.withValues(alpha: .025),
      border: Border.all(color: AppColors.border),
      borderRadius: BorderRadius.circular(18),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(AppIcons.circleDot, size: 20, color: AppColors.textSoft),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                title,
                style: _style(
                  15,
                  AppColors.text,
                ).copyWith(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        const SizedBox(height: 7),
        Text(detail, style: _style(13, AppColors.textSoft)),
        if (footnote != null)
          Text(footnote, style: _style(11, AppColors.muted)),
        if (action != null) ...[const SizedBox(height: 12), action],
      ],
    ),
  );
}
