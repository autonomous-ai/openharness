import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_icons.dart';

import 'account_device_detail.dart';
import 'account_device_history.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/account_devices.dart' show DeviceConflict, registerRefusalSentence;
import '../state/app_state.dart';
import '../viewer/device_log_sync.dart' show DeviceDepartedCopy, DeviceRemovalCopy, DeviceRemovalNotice;
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
            child: LayoutBuilder(
              builder: (context, constraints) {
                final icon = Icon(AppIcons.shield, size: 16, color: grid.AppPalette.warn);
                final phone = constraints.maxWidth < _phoneBelow;
                final sentence = Text(
                  '${notice.sentence}${more > 0 ? ' (+$more more)' : ''} Not yours? Remove it.',
                  key: const Key('new-device-notice'),
                  maxLines: phone ? null : 1,
                  overflow: phone ? TextOverflow.clip : TextOverflow.ellipsis,
                  style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                );
                final buttons = [
                  TextButton(
                    key: const Key('new-device-dismiss'),
                    // A fork's suspension is not the banner's to lift (it would be back on the next read):
                    // that device's own page shows it, and lifts it there.
                    onPressed: notice.suspended
                        ? () => unawaited(showAccountDeviceDetail(context, notifier, pub: notice.pub, isNew: true))
                        : () => notifier.dismissNewDevice(notice.pub),
                    child: const Text('It’s mine'),
                  ),
                  OutlinedButton(
                    key: const Key('new-device-review'),
                    // One new device goes straight to its key code; several go to Machines, where each is a row.
                    onPressed: () => more == 0
                        ? unawaited(showAccountDeviceDetail(context, notifier, pub: notice.pub, isNew: true))
                        : openMachines(context, notifier, devicePub: notice.pub),
                    child: Text(more == 0 ? 'Review' : 'Review devices'),
                  ),
                ];
                // A phone has no room for the sentence beside its buttons, and the person must read
                // all of it before saying the device is theirs: it wraps, and the buttons go under it.
                if (phone) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [icon, const SizedBox(width: 10), Expanded(child: sentence)],
                      ),
                      const SizedBox(height: 6),
                      Wrap(alignment: WrapAlignment.end, spacing: 6, runSpacing: 6, children: buttons),
                    ],
                  );
                }
                return Row(
                  children: [
                    icon,
                    const SizedBox(width: 10),
                    Expanded(child: sentence),
                    const SizedBox(width: 12),
                    buttons.first,
                    const SizedBox(width: 6),
                    buttons.last,
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// Below this window width the band stacks its sentence above its buttons: the phone layout's
/// width. A Desktop window is never this narrow (`desktop_window.dart` sets 880), so it keeps one line.
const double _phoneBelow = 720;

/// The same band, for the other things about the account's devices worth a line across the window
/// (a removal, a departed key, a held computer id): [text], and one or two buttons. [red] is for what looks like someone else acting.
class _DeviceBand extends StatelessWidget {
  const _DeviceBand({
    required this.red,
    required this.text,
    required this.textKey,
    required this.actions,
    this.maxLines = 2,
  });

  final bool red;
  final String text;
  final Key textKey;
  final List<Widget> actions;

  /// Lines the text may take before it is cut with an ellipsis; null: as many as it needs.
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final accent = red ? grid.AppPalette.dangerFill : grid.AppPalette.warn;
    final tint = Color.alphaBlend(accent.withValues(alpha: 0.10), grid.AppPalette.windowBg);
    return WindowDragArea(
      child: Material(
        color: Colors.transparent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tint,
            border: Border(bottom: BorderSide(color: accent.withValues(alpha: 0.28))),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(14 + trafficLightClearance, 7, 10, 7),
            child: Row(
              children: [
                Icon(AppIcons.shield, size: 16, color: accent),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    text,
                    key: textKey,
                    maxLines: maxLines,
                    // An ellipsis needs a line cap to mean "wrap, then cut": uncapped text just wraps.
                    overflow: maxLines == null ? TextOverflow.clip : TextOverflow.ellipsis,
                    style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                  ),
                ),
                for (final a in actions) ...[const SizedBox(width: 8), a],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A device was taken out of the account by another device, or signed itself out. Normal for the
/// account's owner doing it; red when the one that did it is itself a new device nobody has looked at.
class DeviceRemovalNoticeBand extends StatelessWidget {
  const DeviceRemovalNoticeBand({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final all = notifier.visibleDeviceRemovals;
    if (all.isEmpty) return const SizedBox.shrink();
    // A red one first: one that looks like someone else acting must not sit behind an older neutral one.
    final DeviceRemovalNotice notice = all.firstWhere((n) => n.red, orElse: () => all.first);
    final more = all.length - 1;
    return _DeviceBand(
      red: notice.red,
      textKey: const Key('device-removal-notice'),
      text: '${notice.title}. ${notice.sentence}${more > 0 ? ' (+$more more)' : ''}',
      actions: [
        TextButton(
          key: const Key('device-removal-dismiss'),
          onPressed: () => notifier.dismissDeviceRemoval(notice.pub),
          child: const Text('Got it'),
        ),
        if (notice.red)
          OutlinedButton(
            key: const Key('device-removal-review'),
            onPressed: () => unawaited(
              showAccountDeviceDetail(context, notifier, pub: notice.signer, isNew: true),
            ),
            child: const Text('Review'),
          ),
      ],
    );
  }
}

/// A device joined the account and was taken out again before anyone looked at it. The log keeps the
/// flag until "Got it": the new-device banner it would have had is gone with the key, and this is what
/// says so. Red when the key that took it out is itself a new device nobody has looked at. With
/// several, a red one is the one shown, "(+N more)" counts the rest, and "Got it" clears them all.
class DeviceDepartedNoticeBand extends StatelessWidget {
  const DeviceDepartedNoticeBand({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final all = notifier.departedDevices;
    if (all.isEmpty) return const SizedBox.shrink();
    // "Got it" clears every one, so the one read is the one that matters most.
    final notice = all.firstWhere(notifier.departedIsRed, orElse: () => all.first);
    final more = all.length - 1;
    final shown = [for (final d in all) d.pub];
    final red = notifier.departedIsRed(notice);
    // A new device that did it is still on the account: its own page is what to look at. Otherwise
    // the History says who did what and when.
    final signerStillNew = red && notifier.newDevices.any((d) => d.pub == notice.removedBy);
    return _DeviceBand(
      red: red,
      textKey: const Key('device-departed-notice'),
      text: '${notice.sentence(red: red)}${more > 0 ? ' (+$more more)' : ''}',
      actions: [
        TextButton(
          key: const Key('device-departed-dismiss'),
          onPressed: () => notifier.dismissDepartedAll(shown),
          child: const Text('Got it'),
        ),
        OutlinedButton(
          key: const Key('device-departed-review'),
          onPressed: () => unawaited(
            signerStillNew
                ? showAccountDeviceDetail(context, notifier, pub: notice.removedBy, isNew: true)
                : showAccountDeviceHistory(context, notifier),
          ),
          child: Text(signerStillNew ? 'Review' : 'History'),
        ),
      ],
    );
  }
}

/// Another key holds this computer's id on the account, so this computer is not registered under its
/// own key. Red when that key was added after this computer joined.
class DeviceConflictNoticeBand extends StatelessWidget {
  const DeviceConflictNoticeBand({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final DeviceConflict? conflict = notifier.deviceConflict;
    if (conflict == null) return const SizedBox.shrink();
    final holder =
        '${conflict.label.trim().isEmpty ? 'A device' : conflict.label.trim()} · ${conflict.fingerprint}';
    return _DeviceBand(
      red: conflict.afterJoin,
      textKey: const Key('device-conflict-notice'),
      // The longest copy of the bands: it wraps rather than being cut, since its second sentence is the advice.
      maxLines: null,
      text: conflict.afterJoin
          ? 'Another key took this computer’s place on your account after it joined: $holder. '
                'If you did not set up Harness here again, remove that key from another device now (Machines).'
          : 'This computer is held by another key on your account: $holder. If that was an earlier '
                'install of this computer, remove it from another device (Machines) — this computer '
                'joins on its own once it is gone.',
      actions: [
        TextButton(
          key: const Key('device-conflict-dismiss'),
          onPressed: notifier.dismissDeviceConflict,
          child: const Text('Got it'),
        ),
        OutlinedButton(
          key: const Key('device-conflict-review'),
          onPressed: () => openMachines(context, notifier, devicePub: conflict.pub),
          child: const Text('Machines'),
        ),
      ],
    );
  }
}

/// Machines, where the account's computers, phones and apps are listed, from anywhere: it steps out
/// of Settings and any dialog over the workspace, and the workspace opens the picker
/// ([AppNotifier.requestMachines]). [devicePub] selects that device there.
void openMachines(
  BuildContext context,
  AppNotifier notifier, {
  String? devicePub,
  bool phones = false,
}) {
  Navigator.of(context, rootNavigator: true).popUntil((route) => route.isFirst);
  notifier.requestMachines(devicePub: devicePub, phones: phones);
}

/// Machines, from a machine that asks for its password while this app's device list is frozen
/// ([AppNotifier.deviceListNeedsReview]): the list pins no machine again until it is reviewed.
void showDeviceListReview(BuildContext context, AppNotifier notifier) =>
    openMachines(context, notifier);

/// The line under a machine's password prompt while this app's device list is frozen — or the backend
/// refused this app a place on the account for having too many devices: the password is one way in,
/// the devices list the other. Nothing while neither holds.
class DeviceListReviewLine extends StatelessWidget {
  const DeviceListReviewLine({super.key, required this.notifier, this.center = false});

  final AppNotifier notifier;
  final bool center;

  // Listens itself: it sits under prompts that do not rebuild when the device list changes.
  @override
  Widget build(BuildContext context) =>
      ListenableBuilder(listenable: notifier, builder: _build);

  Widget _build(BuildContext context, Widget? _) {
    grid.AppTheme.watch(context);
    final review = notifier.deviceListNeedsReview, tooMany = notifier.deviceListTooMany;
    if (!review && !tooMany) return const SizedBox.shrink();
    return Wrap(
      alignment: center ? WrapAlignment.center : WrapAlignment.start,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 4,
      children: [
        for (final line in [
          if (review) 'Your device list needs a review.',
          if (tooMany) registerRefusalSentence('TOO_MANY'),
        ])
          Text(
            line,
            textAlign: center ? TextAlign.center : TextAlign.start,
            style: grid.AppType.body(color: grid.AppPalette.textSecondary),
          ),
        TextButton(
          key: const Key('device-list-review'),
          onPressed: () => showDeviceListReview(context, notifier),
          child: const Text('Machines'),
        ),
      ],
    );
  }
}
