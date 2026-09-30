import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Settings ▸ Your devices — every computer and app signed in to this account. Signing in on one is
/// what makes the others trust it (the device key log, `viewer/device_log_sync.dart`), so this is also
/// where a device that is not yours is seen, and taken out.
class DevicesPage extends StatefulWidget {
  const DevicesPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  DeviceLogListing? _listing;
  Map<String, int> _seen = const {};
  bool _removingUnused = false;
  int _revision = -1;
  final Set<String> _removing = {};
  String? _error;

  AppNotifier get _app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _app.addListener(_changed);
    unawaited(_load());
    // Looking at the list IS reviewing the new devices: the banner that pointed here is done.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _app.seenNewDevices();
    });
  }

  @override
  void dispose() {
    _app.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (_app.devicesRevision != _revision) unawaited(_load());
  }

  Future<void> _load() async {
    _revision = _app.devicesRevision;
    final listing = await _app.deviceLog?.list();
    final seen = await _app.devicesLastSeen();
    if (!mounted) return;
    setState(() {
      _listing = listing ?? DeviceLogListing.empty;
      _seen = seen;
    });
  }

  Future<void> _remove(DeviceLogRow row) async {
    final name = row.member.label.isEmpty ? 'this device' : row.member.label;
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
      _removing.add(row.member.pub);
      _error = null;
    });
    final error = await _app.removeDevice(row.member.pub);
    if (!mounted) return;
    setState(() {
      _removing.remove(row.member.pub);
      _error = error == null ? null : "Couldn't remove $name. Try again.";
    });
  }

  /// Apps not seen in 90 days: most likely a browser whose data was cleared, which never signs its
  /// own removal. Never this phone, never a computer, never one the backend has no record of.
  List<DeviceLogRow> _unused(DeviceLogListing listing) {
    final cutoff = DateTime.now()
        .subtract(const Duration(days: 90))
        .millisecondsSinceEpoch;
    return [
      for (final row in listing.members)
        if (!row.self &&
            row.member.kind == 'viewer' &&
            (_seen[row.member.pub] ?? cutoff) < cutoff)
          row,
    ];
  }

  Future<void> _removeUnused(List<DeviceLogRow> rows) async {
    final confirmed = await confirmPhoneAction(
      context,
      title: 'Remove ${rows.length} unused app${rows.length == 1 ? '' : 's'}?',
      message:
          'Not used in 90 days — most likely a browser whose data was cleared. '
          'Removing them changes nothing you use.',
      confirmLabel: 'Remove',
      icon: LucideIcons.shieldOff300,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removingUnused = true;
      _error = null;
    });
    var failed = 0;
    for (final row in rows) {
      if (await _app.removeDevice(row.member.pub) != null) failed++;
    }
    if (!mounted) return;
    setState(() {
      _removingUnused = false;
      _error = failed == 0
          ? null
          : "Couldn't remove $failed of them. Try again.";
    });
  }

  Future<void> _trustAgain() async {
    final log = _app.deviceLog;
    if (log == null) return;
    final preview = await log.rebaseline(confirm: false);
    if (!mounted) return;
    if (preview == null) {
      setState(
        () => _error = "Couldn't read a valid device list. Try again later.",
      );
      return;
    }
    final lines = [
      for (final m in preview.added)
        '+ ${m.label.isEmpty ? 'A device' : m.label}',
      for (final m in preview.removed)
        '− ${m.label.isEmpty ? 'A device' : m.label}',
    ];
    final confirmed = await confirmPhoneAction(
      context,
      title: 'Trust this device list again?',
      message: lines.isEmpty
          ? 'It changes no device. Continue only if you expected this.'
          : 'Only if every device added is yours:\n${lines.join('\n')}',
      confirmLabel: 'Trust again',
      icon: LucideIcons.shieldAlert300,
    );
    if (!confirmed || !mounted) return;
    await log.rebaseline(confirm: true);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final listing = _listing;
    final frozen =
        listing != null &&
        (listing.frozen != null || listing.frozenPeers.isNotEmpty);
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
            const TtyText(
              'Your devices',
              size: TtySize.title,
              weight: FontWeight.w600,
            ),
            const SizedBox(height: 8),
            TtyText(
              'Every computer and app signed in to your account. Each reaches your machines '
              'end to end encrypted, with no password. Remove one you do not recognise.',
              color: tty.dim,
            ),
            if (frozen) ...[
              const SizedBox(height: 12),
              SettingsGroup(
                children: [
                  SettingsRow(
                    title: 'The device list froze',
                    detail: listing.frozen != null
                        ? 'Harness served a list that does not match what this phone verified. '
                              'No device is added until you review it.'
                        : 'Frozen on ${listing.frozenPeers.join(', ')}. Review it on that computer.',
                    destructive: true,
                    onTap: listing.frozen != null
                        ? () => unawaited(_trustAgain())
                        : null,
                    value: listing.frozen != null ? 'Review' : null,
                  ),
                ],
              ),
            ],
            if (_error case final error?) ...[
              const SizedBox(height: 12),
              TtyText(error, color: tty.red),
            ],
            if (listing != null && _unused(listing).isNotEmpty) ...[
              const SizedBox(height: 12),
              SettingsGroup(
                children: [
                  SettingsRow(
                    key: const Key('account-devices-unused'),
                    title:
                        '${_unused(listing).length} app${_unused(listing).length == 1 ? '' : 's'} not used in 90 days',
                    detail: 'Most likely a browser whose data was cleared.',
                    value: _removingUnused ? 'Removing…' : 'Remove',
                    destructive: true,
                    onTap: _removingUnused
                        ? null
                        : () => unawaited(_removeUnused(_unused(listing))),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 12),
            if (listing == null)
              const SizedBox.shrink()
            else
              SettingsGroup(
                children: [
                  for (final row in listing.members)
                    SettingsRow(
                      key: ValueKey('account-device-${row.member.pub}'),
                      title:
                          '${row.member.label.isEmpty ? 'Unnamed device' : row.member.label}'
                          '${row.self ? ' (this phone)' : ''}',
                      detail:
                          '${row.member.kind == 'machine' ? 'Computer' : 'App'}'
                          '${_seen[row.member.pub] != null ? ' · last seen ${_date(_seen[row.member.pub]!)}' : ''}'
                          ' · ${row.fingerprint}',
                      destructive: !row.self,
                      value: row.self
                          ? null
                          : (_removing.contains(row.member.pub)
                                ? 'Removing…'
                                : 'Remove'),
                      onTap: row.self || _removing.contains(row.member.pub)
                          ? null
                          : () => unawaited(_remove(row)),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

String _date(int ms) {
  final at = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${at.year}-${two(at.month)}-${two(at.day)}';
}
