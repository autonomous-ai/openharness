import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_dialog.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shared/widgets/skeleton.dart';
import '../../state/account_devices.dart';
import '../../state/app_state.dart';

/// Settings ▸ Your devices — every computer and app signed in to this account. Signing in on one is
/// what makes the others trust it (the device key log), so this list is also the one place to see a
/// device that is not yours, and to take it out.
class AccountDevicesSection extends StatefulWidget {
  const AccountDevicesSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<AccountDevicesSection> createState() => _AccountDevicesSectionState();
}

class _AccountDevicesSectionState extends State<AccountDevicesSection> {
  AccountDevices? _devices;
  bool _loaded = false;
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
    final devices = await _app.loadDevices();
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _loaded = true;
    });
  }

  Future<void> _remove(AccountDevice device) async {
    final name = device.label.isEmpty ? 'this device' : device.label;
    final confirmed = await _confirm(
      'Remove $name?',
      'It stops reaching your machines on every device, and is signed out. '
          'Signing in on it again adds it back as a new device.',
      'Remove',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removing.add(device.pub);
      _error = null;
    });
    final error = await _app.removeDevice(device.pub);
    if (!mounted) return;
    setState(() {
      _removing.remove(device.pub);
      _error = error == null ? null : "Couldn't remove $name ($error). Try again.";
    });
  }

  bool _removingUnused = false;

  Future<void> _removeUnused(List<AccountDevice> unused) async {
    final confirmed = await _confirm(
      'Remove ${unused.length} unused app${unused.length == 1 ? '' : 's'}?',
      [for (final d in unused) '${d.label.isEmpty ? 'Unnamed app' : d.label} — last seen ${_date(d.lastSeen!)}'].join('\n'),
      'Remove',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removingUnused = true;
      _error = null;
    });
    final failed = <String>[];
    for (final d in unused) {
      if (await _app.removeDevice(d.pub) != null) failed.add(d.label.isEmpty ? 'an app' : d.label);
    }
    if (!mounted) return;
    setState(() {
      _removingUnused = false;
      _error = failed.isEmpty ? null : "Couldn't remove ${failed.join(', ')}. Try again.";
    });
  }

  Future<void> _trustAgain() async {
    final preview = await _app.rebaselineDevices(confirm: false);
    if (!mounted) return;
    if (preview == null) {
      setState(() => _error = "Couldn't read a valid device list. Try again later.");
      return;
    }
    final lines = [
      for (final name in preview.added) '+ $name',
      for (final name in preview.removed) '− $name',
    ];
    final confirmed = await _confirm(
      'Trust this device list again?',
      lines.isEmpty
          ? 'It changes no device. Continue only if you expected this.'
          : 'Only if every device added below is yours:\n\n${lines.join('\n')}',
      'Trust again',
    );
    if (!confirmed || !mounted) return;
    await _app.rebaselineDevices(confirm: true);
  }

  Future<bool> _confirm(String title, String detail, String action, {bool destructive = false}) async =>
      await showAppDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: SizedBox(
            width: 360,
            child: Text(detail, style: grid.AppType.body(height: 1.4)),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              style: TextButton.styleFrom(
                foregroundColor: grid.AppPalette.textSecondary,
                overlayColor: grid.AppSurface.hoverFill,
              ),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('account-device-confirm'),
              style: destructive
                  ? FilledButton.styleFrom(
                      backgroundColor: grid.AppPalette.dangerFill,
                      overlayColor: const Color(0x1FFFFFFF),
                    )
                  : null,
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final devices = _devices;
    return SectionScaffold(
      title: 'Your devices',
      subtitle: 'Every computer and app signed in to your account. Each one reaches your machines '
          'end to end encrypted — no password. Remove one you do not recognise.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (devices != null && devices.frozen) _FrozenLine(devices: devices, onTrustAgain: _trustAgain),
            if (_error case final error?)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(error, style: grid.AppType.body(color: grid.AppPalette.warn)),
              ),
            if (devices != null && devices.unused(DateTime.now()).isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SettingRow(
                  key: const Key('account-devices-unused'),
                  title: '${devices.unused(DateTime.now()).length} app${devices.unused(DateTime.now()).length == 1 ? '' : 's'} not used in 90 days',
                  detail: 'Most likely a browser whose data was cleared. Removing them changes nothing you use.',
                  control: OutlinedButton(
                    onPressed: _removingUnused ? null : () => unawaited(_removeUnused(devices.unused(DateTime.now()))),
                    child: Text(_removingUnused ? 'Removing…' : 'Remove them'),
                  ),
                ),
              ),
            if (!_loaded)
              const SkeletonList(rows: 3)
            else if (devices == null)
              Text(
                'The device list is not available here yet.',
                style: grid.AppType.body(color: grid.AppPalette.textSecondary),
              )
            else
              for (final device in devices.devices)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: SettingRow(
                    key: ValueKey('account-device-${device.pub}'),
                    title: '${device.label.isEmpty ? 'Unnamed device' : device.label}${device.self ? '  (this device)' : ''}',
                    detail: '${device.isMachine ? 'Computer' : 'App'} · added ${_date(device.addedAt)}'
                        '${device.lastSeen != null ? ' · last seen ${_date(device.lastSeen!)}' : ''} · ${device.fingerprint}',
                    control: device.self
                        ? const SizedBox.shrink()
                        : OutlinedButton(
                            onPressed: _removing.contains(device.pub) ? null : () => unawaited(_remove(device)),
                            child: Text(_removing.contains(device.pub) ? 'Removing…' : 'Remove'),
                          ),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

class _FrozenLine extends StatelessWidget {
  const _FrozenLine({required this.devices, required this.onTrustAgain});

  final AccountDevices devices;
  final VoidCallback onTrustAgain;

  @override
  Widget build(BuildContext context) {
    final where = devices.frozenReason != null
        ? 'this device'
        : devices.frozenPeers.join(', ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: grid.AppPalette.warn.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: grid.AppPalette.warn.withValues(alpha: 0.28)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'The device list froze on $where: Harness served a list that does not match what '
                  'was verified before. No device is added until you review it.',
                  style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                ),
              ),
              if (devices.frozenReason != null) ...[
                const SizedBox(width: 12),
                OutlinedButton(onPressed: onTrustAgain, child: const Text('Review…')),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

String _date(DateTime at) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${at.year}-${two(at.month)}-${two(at.day)}';
}
