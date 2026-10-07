import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/relative_time.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/fingerprint_text.dart';
import '../../shared/widgets/section_heading.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shared/widgets/skeleton.dart';
import '../../state/account_devices.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import 'account_device_detail.dart';
import 'account_device_history.dart';

/// What "Trust again" says when the list it would trust is another account's than the one signed in to.
const otherAccountMessage =
    'The device list now belongs to a different account than the one you signed in with. '
    'Sign in again to switch accounts.';

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

  /// The error is a state to review again (another account, a list that changed), not a failure: amber.
  /// Every other error is red.
  bool _errorIsNotice = false;

  /// The devices that were new when this list opened: they keep their `New` badge for the visit, though
  /// opening the list clears the banner that announced them.
  late final Set<String> _newPubs;

  /// "Got it" was pressed on the baseline panel: hidden at once, whatever the write takes.
  bool _baselineDone = false;

  AppNotifier get _app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _app.addListener(_changed);
    _newPubs = {for (final d in _app.newDevices) d.pub};
    unawaited(_load());
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
    final first = !_loaded;
    List<String>? banner;
    final devices = await _app.loadDevices(onListed: (b) => banner = b);
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _loaded = true;
      // What the log kept as new (it outlives the banner and a restart) badges alongside the banner's —
      // on every read, so a device that turns up while the list is open is badged too (it stays pending:
      // only the first read of a visit is marked seen below).
      if (devices != null) _newPubs.addAll(devices.pending);
      if (!first) _newPubs.addAll(_app.newDevices.map((d) => d.pub));
    });
    // Looking at the list IS reviewing the new devices: the banner that pointed here is done. After
    // the first read, so the pending keys are in [_newPubs] before they are marked seen.
    if (first) {
      _app.seenNewDevices(
        pending: devices?.pending ?? const [],
        shown: banner,
        departed: devices?.departed ?? const [],
      );
    }
  }

  Future<void> _gotIt() async {
    setState(() => _baselineDone = true);
    await _app.seeDeviceBaseline();
  }

  Future<void> _remove(AccountDevice device) async {
    final name = device.label.isEmpty ? 'this device' : device.label;
    final confirmed = await confirmDeviceAction(
      context,
      'Remove $name?',
      removeDeviceDetail,
      'Remove',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removing.add(device.pub);
      _error = null;
      _errorIsNotice = false;
    });
    final error = await _app.removeDevice(device.pub);
    if (!mounted) return;
    setState(() {
      _removing.remove(device.pub);
      _error = error == null ? null : 'Couldn’t remove $name ($error). Try again.';
      _errorIsNotice = false;
    });
  }

  bool _removingUnused = false;

  Future<void> _removeUnused(List<AccountDevice> unused) async {
    final confirmed = await confirmDeviceAction(
      context,
      'Remove ${unused.length} unused app${unused.length == 1 ? '' : 's'}?',
      [for (final d in unused) '${d.label.isEmpty ? 'Unnamed app' : d.label} — last active ${relativeAgo(d.lastSeen!, DateTime.now())}'].join('\n'),
      'Remove',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() {
      _removingUnused = true;
      _error = null;
      _errorIsNotice = false;
    });
    final failed = <String>[];
    for (final d in unused) {
      if (await _app.removeDevice(d.pub) != null) failed.add(d.label.isEmpty ? 'an app' : d.label);
    }
    if (!mounted) return;
    setState(() {
      _removingUnused = false;
      _error = failed.isEmpty ? null : 'Couldn’t remove ${failed.join(', ')}. Try again.';
      _errorIsNotice = false;
    });
  }

  Future<void> _trustAgain() async {
    final preview = await _app.rebaselineDevices(confirm: false);
    if (!mounted) return;
    if (preview == null) {
      setState(() {
        _error = 'Couldn’t read a valid device list. Try again later.';
        _errorIsNotice = false;
      });
      return;
    }
    if (preview.otherAccount) {
      setState(() {
        _error = otherAccountMessage;
        _errorIsNotice = true;
      });
      return;
    }
    final lines = [
      for (final name in preview.added) '+ $name',
      for (final name in preview.removed) '− $name',
    ];
    final confirmed = await confirmDeviceAction(
      context,
      'Trust this device list again?',
      lines.isEmpty
          ? 'It changes no device. Continue only if you expected this.'
          : 'Only if every device added below is yours:\n\n${lines.join('\n')}',
      'Trust again',
      // Trusting a list the backend served is the cautionary action: the same red as Remove.
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    final done = await _app.rebaselineDevices(confirm: true, head: preview.head);
    if (!mounted) return;
    if (done == null) {
      setState(() {
        _error = 'Couldn’t trust the device list again. Try again later.';
        _errorIsNotice = false;
      });
    } else if (done.otherAccount) {
      setState(() {
        _error = otherAccountMessage;
        _errorIsNotice = true;
      });
    } else if (!done.logChanged) {
      setState(() {
        _error = null;
        _errorIsNotice = false;
      });
    } else {
      // What was reviewed is no longer what the backend serves: nothing was trusted. Show it again.
      setState(() {
        _error = 'The device list changed while you were reviewing it. Review it again.';
        _errorIsNotice = true;
      });
      unawaited(_trustAgain());
    }
  }

  void _open(AccountDevice device) => unawaited(
    showAccountDeviceDetail(
      context,
      _app,
      pub: device.pub,
      device: device,
      isNew: _newPubs.contains(device.pub),
      onMine: () => setState(() => _newPubs.remove(device.pub)),
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final devices = _devices;
    return SectionScaffold(
      title: 'Your devices',
      subtitle: 'Every computer and app signed in to your account. Each one reaches your machines '
          'end to end encrypted. Remove one you do not recognise.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (devices != null && devices.frozen) _FrozenLine(devices: devices, onTrustAgain: _trustAgain),
            if (devices?.registerError case final code?) _RefusedLine(code: code),
            if (devices != null && !devices.baselineSeen && !_baselineDone && !_app.baselineSeenLocally && devices.baseline.isNotEmpty)
              _BaselinePanel(devices: devices.baseline, onGotIt: () => unawaited(_gotIt())),
            if (_error case final error?)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  error,
                  key: const Key('account-devices-error'),
                  style: grid.AppType.body(color: _errorIsNotice ? AppColors.warning : AppColors.danger),
                ),
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
            else ...[
              if (devices.self case final self?) ...[
                const SectionHeading('This device'),
                const SizedBox(height: 8),
                SettingRow(
                  key: const Key('account-device-this'),
                  title: self.label.trim().isEmpty ? 'Unnamed device' : self.label,
                  detail: 'This is the code your other devices show for this device.',
                  control: const SizedBox.shrink(),
                  footer: FingerprintText(self.fingerprint, large: false, copyKey: const Key('this-device-copy')),
                ),
                const SizedBox(height: 16),
              ],
              for (final device in devices.listed(_newPubs))
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: MouseRegion(
                    cursor: SystemMouseCursors.click,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => _open(device),
                      child: SettingRow(
                        key: ValueKey('account-device-${device.pub}'),
                        title: device.label.trim().isEmpty ? 'Unnamed device' : device.label,
                        badge: device.suspended
                            ? 'Suspended'
                            : _newPubs.contains(device.pub)
                            ? 'New'
                            : null,
                        detail: deviceDetailLine(
                          device,
                          now: DateTime.now(),
                          sameName: devices.sharedNames.contains(device.label.trim()),
                        ),
                        control: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            TextButton(
                              key: ValueKey('account-device-details-${device.pub}'),
                              onPressed: () => _open(device),
                              child: const Text('Details'),
                            ),
                            const SizedBox(width: 6),
                            OutlinedButton(
                              onPressed: _removing.contains(device.pub) ? null : () => unawaited(_remove(device)),
                              child: Text(_removing.contains(device.pub) ? 'Removing…' : 'Remove'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: devices.historyAvailable
                    ? Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton(
                          key: const Key('account-devices-history'),
                          onPressed: () => unawaited(showAccountDeviceHistory(context, _app)),
                          child: const Text('History…'),
                        ),
                      )
                    : Text(
                        'Update Harness on this computer to see history.',
                        key: const Key('account-devices-history-hint'),
                        style: grid.AppType.body(color: grid.AppPalette.textSecondary),
                      ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The devices that were already on the account when this one joined: never announced, so said once.
class _BaselinePanel extends StatelessWidget {
  const _BaselinePanel({required this.devices, required this.onGotIt});

  final List<AccountDevice> devices;
  final VoidCallback onGotIt;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DecoratedBox(
      key: const Key('account-devices-baseline'),
      decoration: BoxDecoration(
        color: grid.AppPalette.warn.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: grid.AppPalette.warn.withValues(alpha: 0.28)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Already on your account', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              'These were on your account before this device joined. If one isn’t yours, remove it.',
              style: grid.AppType.body(color: grid.AppPalette.textPrimary),
            ),
            const SizedBox(height: 8),
            for (final d in devices)
              Text(
                '${d.label.trim().isEmpty ? 'A device' : d.label.trim()} · ${d.isMachine ? 'Computer' : 'App'} · ${d.fingerprint}',
                style: grid.AppType.caption(color: grid.AppPalette.textSecondary),
              ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: OutlinedButton(
                key: const Key('account-devices-baseline-gotit'),
                onPressed: onGotIt,
                child: const Text('Got it'),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// The backend refused this device a place on the account ([AccountDevices.registerError]).
class _RefusedLine extends StatelessWidget {
  const _RefusedLine({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: grid.AppPalette.warn.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: grid.AppPalette.warn.withValues(alpha: 0.28)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Text(
          registerRefusalSentence(code),
          key: const Key('account-devices-refused'),
          style: grid.AppType.body(color: grid.AppPalette.textPrimary),
        ),
      ),
    ),
  );
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
