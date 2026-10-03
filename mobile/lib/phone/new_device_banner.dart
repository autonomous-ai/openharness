import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'device_history_page.dart';
import 'devices_page.dart';
import 'phone_navigation.dart' show phoneRoute;
import 'tty.dart';

/// "New device: X" across the top of the phone: a device this phone had never trusted joined the
/// account. Signing in is what makes a device trusted, so this is how one signed in by someone else
/// is seen. It stays until it is looked at or dismissed.
///
/// Above it, stacked under one status-bar inset with a hairline between them: a device removed or
/// signed out by someone else, and a device that joined and left before anyone looked. Each band shows
/// one item and counts the rest as "(+N more)".
class NewDeviceBanner extends StatelessWidget {
  const NewDeviceBanner({
    super.key,
    required this.notifier,
    required this.navigator,
  });

  final AppNotifier notifier;
  final GlobalKey<NavigatorState> navigator;

  /// Whether any band is on screen. The bands take the status-bar inset, so what is under them must
  /// not take it again.
  static bool showing(AppNotifier notifier) =>
      notifier.deviceRemovals.isNotEmpty ||
      notifier.departedDevices.isNotEmpty ||
      notifier.newDevices.isNotEmpty;

  /// The removal notices that get a band. A device that signed itself out and is ALSO held as having
  /// "joined and left before you looked" is one ghost, not two: only the departed band says so (its
  /// "Got it" is the one dismissal), so a "signed out" band for the same key is left out — suppressed,
  /// not dismissed, as dismissing it would not touch the departed mark.
  static List<DeviceRemovalNotice> removalsShown(AppNotifier notifier) {
    final gone = {for (final d in notifier.departedDevices) d.pub};
    return [
      for (final r in notifier.deviceRemovals)
        if (!(r.selfRemoved && gone.contains(r.pub))) r,
    ];
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final removed = removalsShown(notifier);
    // The departed mark and a removal notice for another device are separate things, each cleared by
    // its own "Got it" — dismissing the notice never erases the mark.
    final departed = notifier.departedDevices;
    if (!showing(notifier)) return const SizedBox.shrink();
    // The alarming one first, in each band: a removal by a new device nobody looked at, a departed key
    // removed by one. Behind a neutral one it would be dismissed (or just overlooked) unseen.
    final removal = removed.isEmpty
        ? null
        : removed.firstWhere((r) => r.red, orElse: () => removed.first);
    final departedShown = departed.isEmpty
        ? null
        : departed.firstWhere(
            notifier.departedRed,
            orElse: () => departed.first,
          );
    // What this build counts: "Got it" clears exactly these. A key that arrives after this build was
    // never drawn, so it is not cleared.
    final shown = [for (final d in departed) d.pub];
    final bands = <Widget>[
      // Same order as the desktop: a removal, then a device that left unseen, then a new device.
      if (removal != null)
        _RemovalBand(
          notice: removal,
          more: removed.length - 1,
          onGotIt: () => notifier.dismissDeviceRemoval(removal.pub),
          onReview: removal.red ? () => _reviewSigner(removal) : null,
        ),
      if (departedShown != null)
        _DepartedBand(
          departed: departedShown,
          more: departed.length - 1,
          red: notifier.departedRed(departedShown),
          // The band counts every one of them ("(+N more)"), so "Got it" is for all it counts — each
          // dismissal saved on its own, as one "Got it" per device would.
          onGotIt: () {
            for (final pub in shown) {
              notifier.dismissDeparted(pub);
            }
          },
          onReview: () => unawaited(
            navigator.currentState?.push(
                  phoneRoute((_) => DeviceHistoryPage(notifier: notifier)),
                ) ??
                Future<void>.value(),
          ),
        ),
      if (notifier.newDevices.isNotEmpty) _newDevice(context),
    ];
    final tty = Tty.of(context);
    // One SafeArea around every band: the status-bar inset is taken once, at the top. A SafeArea per
    // band would also push the lower band down by the notch. A hairline between stacked bands keeps
    // two of the same tint apart.
    return SafeArea(
      bottom: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < bands.length; i++) ...[
            if (i > 0)
              Container(height: 1, color: tty.dim.withValues(alpha: 0.25)),
            bands[i],
          ],
        ],
      ),
    );
  }

  /// "Review" on a removal by a new device: that signer's page when it is still new, else the list.
  void _reviewSigner(DeviceRemovalNotice n) {
    notifier.dismissDeviceRemoval(n.pub);
    unawaited(_open(n.signer, onlyWhileNew: true));
  }

  /// [openDeviceFromLog] on the app's navigator, when it has one.
  Future<void> _open(String pub, {bool onlyWhileNew = false}) async {
    final nav = navigator.currentState;
    if (nav == null) return;
    await openDeviceFromLog(nav, notifier, pub, onlyWhileNew: onlyWhileNew);
  }

  Widget _newDevice(BuildContext context) {
    final tty = Tty.of(context);
    final m = notifier.newDevices.first;
    final name = m.label.isEmpty ? 'A device' : m.label;
    final more = notifier.newDevices.length - 1;
    return Material(
      color: Color.alphaBlend(tty.red.withValues(alpha: 0.12), tty.ground),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 8, 8, 8),
        child: Row(
          children: [
            Expanded(
              // Wraps: "(+N more)" is the part that must not be clipped.
              child: Text(
                'New device: $name${more > 0 ? ' (+$more more)' : ''}',
                key: const Key('new-device-banner'),
                style: tty.style(),
              ),
            ),
            TextButton(
              // A key a fork suspended stays suspended however often the banner is dismissed (the next
              // read of the log would bring it back), so "Mine" opens its page, which says why and
              // is where the person can vouch for it.
              onPressed: () => notifier.newDeviceSuspended(m.pub)
                  ? unawaited(_open(m.pub))
                  : notifier.dismissNewDevice(m.pub),
              child: const Text('Mine'),
            ),
            TextButton(
              // One new device goes straight to its key code; several go to the list, where each is a row.
              onPressed: () => unawaited(
                more == 0
                    ? _open(m.pub)
                    : navigator.currentState?.push(
                        phoneRoute((_) => DevicesPage(notifier: notifier)),
                      ),
              ),
              child: const Text('Review'),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Device removed" / "Device signed out" / "Removed by a new device": a device left the account
/// without this phone doing it. Red when the removal came from a new device nobody has looked at.
class _RemovalBand extends StatelessWidget {
  const _RemovalBand({
    required this.notice,
    required this.more,
    required this.onGotIt,
    this.onReview,
  });

  final DeviceRemovalNotice notice;
  final int more;
  final VoidCallback onGotIt;
  final VoidCallback? onReview;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final red = notice.red;
    final title = notice.title;
    final body = notice.sentence;
    return Material(
      color: Color.alphaBlend(
        (red ? tty.red : tty.dim).withValues(alpha: 0.12),
        tty.ground,
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 8, 8, 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                key: const Key('device-removed-banner'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    more > 0 ? '$title (+$more more)' : title,
                    style: tty.style(weight: FontWeight.w600),
                  ),
                  Text(body, style: tty.style()),
                ],
              ),
            ),
            TextButton(onPressed: onGotIt, child: const Text('Got it')),
            if (onReview != null)
              TextButton(onPressed: onReview, child: const Text('Review')),
          ],
        ),
      ),
    );
  }
}

/// A device that came and went while nobody here was looking ([DeviceDepartedCopy] words it), kept
/// until "Got it". "History" opens the History, where it is flagged. Red when the key that removed it
/// is itself a device nobody looked at.
class _DepartedBand extends StatelessWidget {
  const _DepartedBand({
    required this.departed,
    required this.more,
    required this.red,
    required this.onGotIt,
    required this.onReview,
  });

  final DeviceLogDeparted departed;
  final int more;
  final bool red;
  final VoidCallback onGotIt;
  final VoidCallback onReview;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Material(
      color: Color.alphaBlend(
        (red ? tty.red : tty.dim).withValues(alpha: 0.12),
        tty.ground,
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 8, 8, 8),
        child: Row(
          children: [
            Expanded(
              child: Text(
                more > 0
                    ? '${departed.sentence(red: red)} (+$more more)'
                    : departed.sentence(red: red),
                key: const Key('device-departed-banner'),
                style: tty.style(),
              ),
            ),
            TextButton(
              key: const Key('device-departed-got-it'),
              onPressed: onGotIt,
              child: const Text('Got it'),
            ),
            TextButton(
              key: const Key('device-departed-review'),
              onPressed: onReview,
              child: const Text('History'),
            ),
          ],
        ),
      ),
    );
  }
}
