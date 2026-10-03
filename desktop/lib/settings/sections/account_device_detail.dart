import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/relative_time.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_dialog.dart';
import '../../shared/widgets/fingerprint_text.dart';
import '../../state/account_devices.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';

/// What removing a device does, said in the confirm and nowhere else so the two entry points (the list
/// row and the detail) cannot word it differently.
const removeDeviceDetail =
    'It stops reaching your machines on every device, and is signed out. '
    'Signing in on it again adds it back as a new device.';

/// A yes/no question in the app's dialog. True only on the confirming button.
Future<bool> confirmDeviceAction(
  BuildContext context,
  String title,
  String detail,
  String action, {
  bool destructive = false,
}) async =>
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

/// One device in full: its facts, its whole key code to compare on that device, and what to do about
/// it. [device] is the row the list already holds; without it (the banner and the notification only
/// know the key) the account's list is read, and until then — or when it cannot be — the new-device
/// notice for [pub] stands in. [isNew] offers "It’s mine"; [onMine] tells the caller it was used.
Future<void> showAccountDeviceDetail(
  BuildContext context,
  AppNotifier app, {
  required String pub,
  AccountDevice? device,
  bool isNew = false,
  VoidCallback? onMine,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => _AccountDeviceDetail(
    app: app,
    pub: pub,
    device: device,
    isNew: isNew,
    onMine: onMine,
  ),
);

class _AccountDeviceDetail extends StatefulWidget {
  const _AccountDeviceDetail({
    required this.app,
    required this.pub,
    required this.device,
    required this.isNew,
    required this.onMine,
  });

  final AppNotifier app;
  final String pub;
  final AccountDevice? device;
  final bool isNew;
  final VoidCallback? onMine;

  @override
  State<_AccountDeviceDetail> createState() => _AccountDeviceDetailState();
}

class _AccountDeviceDetailState extends State<_AccountDeviceDetail> {
  AccountDevice? _device;
  bool _loading = false;
  bool _removing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _device = widget.device;
    if (_device == null) {
      _loading = true;
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    // A list that cannot be read leaves the notice standing in (or "no longer on your account"),
    // never a dialog stuck on Loading….
    AccountDevices? devices;
    try {
      devices = await widget.app.loadDevices();
    } catch (_) {
      devices = null;
    }
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (devices != null) {
        for (final d in devices.devices) {
          if (d.pub == widget.pub) _device = d;
        }
      }
    });
  }

  NewDeviceNotice? get _notice {
    for (final n in widget.app.newDevices) {
      if (n.pub == widget.pub) return n;
    }
    return null;
  }

  Future<void> _remove(String name) async {
    final confirmed = await confirmDeviceAction(
      context,
      'Remove $name?',
      removeDeviceDetail,
      'Remove',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removing = true;
      _error = null;
    });
    final error = await widget.app.removeDevice(widget.pub);
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _removing = false;
      _error = 'Couldn’t remove $name ($error). Try again.';
    });
  }

  void _mine() {
    // Only a suspension this dialog SHOWS is lifted. Before the device has loaded (opened from the
    // banner or a notification) it dismisses the way the banner's own button does, which keeps it.
    widget.app.dismissNewDevice(
      widget.pub,
      liftSuspension: _device?.suspended == true,
    );
    widget.onMine?.call();
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final device = _device;
    final notice = _notice;
    final closeButton = TextButton(
      key: const Key('device-detail-close'),
      onPressed: () => Navigator.pop(context),
      style: TextButton.styleFrom(
        foregroundColor: grid.AppPalette.textSecondary,
        overlayColor: grid.AppSurface.hoverFill,
      ),
      child: const Text('Close'),
    );
    if (device == null && notice == null) {
      return AlertDialog(
        title: const Text('Device'),
        content: SizedBox(
          width: 420,
          child: Text(
            _loading ? 'Loading…' : 'This device is no longer on your account.',
            key: const Key('device-detail-gone'),
            style: grid.AppType.body(color: grid.AppPalette.textSecondary),
          ),
        ),
        actions: [closeButton],
      );
    }
    // The list's row when there is one; the notice when the list could not say (it has no times).
    final label = (device?.label ?? notice!.label).trim();
    final name = label.isEmpty ? 'Unnamed device' : label;
    final isMachine = device?.isMachine ?? notice!.kind == 'machine';
    final fp = device?.fingerprint ?? notice!.fingerprint;
    final machineId = device?.machineId ?? '';
    final lastSeen = device?.lastSeen;
    final now = DateTime.now();
    final self = device?.self ?? false;
    return AlertDialog(
      title: Text(name),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Fact('Kind', isMachine ? 'Computer' : 'App'),
              if (device != null) _Fact('Added', fullDateTime(device.addedAt)),
              if (lastSeen != null)
                _Fact('Last active', relativeAgo(lastSeen, now)),
              if (isMachine && machineId.isNotEmpty)
                _Fact(
                  'Machine',
                  machineId.substring(
                    0,
                    machineId.length < 8 ? machineId.length : 8,
                  ),
                ),
              const SizedBox(height: 14),
              if (fp.isNotEmpty) ...[
                FingerprintText(
                  fp,
                  large: true,
                  copyKey: const Key('device-detail-copy'),
                ),
                const SizedBox(height: 8),
                Text(
                  fingerprintHowToCompare(computer: isMachine),
                  style: grid.AppType.body(
                    color: grid.AppPalette.textSecondary,
                    height: 1.4,
                  ),
                ),
              ],
              if (device?.suspended ?? false) ...[
                const SizedBox(height: 12),
                Text(
                  'Not trusted here: added after this device’s list and another’s split. '
                  'Review the list to trust it again.',
                  key: const Key('device-detail-suspended'),
                  style: grid.AppType.body(
                    color: grid.AppPalette.warn,
                    height: 1.4,
                  ),
                ),
              ],
              if (_error case final error?) ...[
                const SizedBox(height: 12),
                Text(
                  error,
                  key: const Key('device-detail-error'),
                  // A failure to remove is red; only a state to review again is amber.
                  style: grid.AppType.body(color: AppColors.danger),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        closeButton,
        // New by the caller's word, or by the list's own once it has loaded (a notification's click can
        // land before the banner has been rebuilt from the log).
        if (widget.isNew || device?.pending == true)
          TextButton(
            key: const Key('device-detail-mine'),
            onPressed: _removing ? null : _mine,
            child: const Text('It’s mine'),
          ),
        if (!self)
          FilledButton(
            key: const Key('device-detail-remove'),
            style: FilledButton.styleFrom(
              backgroundColor: grid.AppPalette.dangerFill,
              overlayColor: const Color(0x1FFFFFFF),
            ),
            onPressed: _removing ? null : () => unawaited(_remove(name)),
            child: Text(_removing ? 'Removing…' : 'Remove'),
          ),
      ],
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);

  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        SizedBox(
          width: 96,
          child: Text(
            label,
            style: grid.AppType.caption(color: grid.AppPalette.textSecondary),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: grid.AppType.body(color: grid.AppPalette.textPrimary),
          ),
        ),
      ],
    ),
  );
}
