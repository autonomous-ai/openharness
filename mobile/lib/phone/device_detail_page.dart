import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'fingerprint_text.dart';
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// One device in full: its facts, its whole key code to compare on that device, and what to do about
/// it. [isNew] offers "It’s mine"; [onMine] tells the page that opened this one it was used.
class DeviceDetailPage extends StatefulWidget {
  const DeviceDetailPage({
    super.key,
    required this.notifier,
    required this.row,
    this.lastSeen,
    this.isNew = false,
    this.onMine,
  });

  final AppNotifier notifier;
  final DeviceLogRow row;

  /// When this key last opened a session (ms since the epoch), when the backend said.
  final int? lastSeen;
  final bool isNew;
  final VoidCallback? onMine;

  @override
  State<DeviceDetailPage> createState() => _DeviceDetailPageState();
}

class _DeviceDetailPageState extends State<DeviceDetailPage> {
  bool _removing = false;
  String? _error;

  DeviceLogRow get _row => widget.row;
  String get _name =>
      _row.member.label.trim().isEmpty ? 'Unnamed device' : _row.member.label;

  Future<void> _remove() async {
    final name = _row.member.label.isEmpty ? 'this device' : _row.member.label;
    final confirmed = await confirmPhoneAction(
      context,
      title: 'Remove $name?',
      message:
          'It stops reaching your machines on every device, and is signed out. '
          'Signing in on it again adds it back as a new device.',
      confirmLabel: 'Remove',
      icon: LucideIcons.shieldOff300,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removing = true;
      _error = null;
    });
    final error = await widget.notifier.removeDevice(_row.member.pub);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _removing = false;
      _error = 'Couldn’t remove $name. Try again.';
    });
  }

  void _mine() {
    // The suspension is lifted only when this page says there is one: "It's mine" is the person
    // vouching for what is on screen.
    widget.notifier.dismissNewDevice(
      _row.member.pub,
      liftSuspension: _row.suspended,
    );
    widget.onMine?.call();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final member = _row.member;
    final isMachine = member.kind == 'machine';
    final lastSeen = widget.lastSeen;
    final now = DateTime.now();
    final fp = _row.fingerprint;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.fromLTRB(
            Tty.origin,
            12,
            Tty.origin,
            MediaQuery.paddingOf(context).bottom + 24,
          ),
          children: [
            TtyText(_name, size: TtySize.title, weight: FontWeight.w600),
            const SizedBox(height: 12),
            SettingsGroup(
              children: [
                SettingsRow(
                  title: 'Kind',
                  value: isMachine ? 'Computer' : 'App',
                ),
                SettingsRow(
                  title: 'Added',
                  value: fullDateTime(
                    DateTime.fromMillisecondsSinceEpoch(member.addedAt),
                  ),
                ),
                if (lastSeen != null)
                  SettingsRow(
                    title: 'Last active',
                    value: relativeAgo(
                      DateTime.fromMillisecondsSinceEpoch(lastSeen),
                      now,
                    ),
                  ),
                if (isMachine && member.machineId.isNotEmpty)
                  SettingsRow(
                    title: 'Machine',
                    value: member.machineId.substring(
                      0,
                      member.machineId.length < 8 ? member.machineId.length : 8,
                    ),
                  ),
              ],
            ),
            if (fp.isNotEmpty) ...[
              const SizedBox(height: 16),
              FingerprintBlock(
                fp,
                large: true,
                copyKey: const Key('device-detail-copy'),
              ),
              const SizedBox(height: 8),
              // Wraps: the explanation is a sentence, not a terminal line.
              Text(
                fingerprintHowToCompare(computer: isMachine),
                style: tty.style(color: tty.dim),
              ),
            ],
            if (_row.suspended) ...[
              const SizedBox(height: 12),
              Text(
                'Not trusted here: added after this device’s list and another’s split. '
                'Review the list to trust it again.',
                style: tty.style(color: tty.red),
              ),
            ],
            if (_error case final error?) ...[
              const SizedBox(height: 12),
              Text(error, style: tty.style(color: tty.red)),
            ],
            if (widget.isNew || !_row.self) ...[
              const SizedBox(height: 16),
              SettingsGroup(
                children: [
                  if (widget.isNew)
                    SettingsRow(
                      key: const Key('device-detail-mine'),
                      title: 'It’s mine',
                      onTap: _removing ? null : _mine,
                    ),
                  if (!_row.self)
                    SettingsRow(
                      key: const Key('device-detail-remove'),
                      title: _removing ? 'Removing…' : 'Remove this device',
                      destructive: true,
                      onTap: _removing ? null : () => unawaited(_remove()),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
