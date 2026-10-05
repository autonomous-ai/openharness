import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'device_detail_page.dart';
import 'device_history_page.dart';
import 'device_rows.dart';
import 'fingerprint_text.dart';
import 'phone_navigation.dart' show phoneRoute;
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// [pub]'s page, from what the log itself lists: the row carries the log's own `suspended` and
/// `pending` flags, so the page says what the log says (a row made up from a notice would not — and
/// its "It's mine" would vouch for a key the page never showed as suspended). A device the log no
/// longer lists opens the list, which says so by not showing it; so does one that is not news when
/// [onlyWhileNew] (a removal's signer is only worth a page while nobody has looked at it).
///
/// Never throws: a listing that cannot be read opens the list, and a navigator that went away while
/// the log was being read (the app was signed out, the screen closed) is left alone.
Future<void> openDeviceFromLog(
  NavigatorState navigator,
  AppNotifier notifier,
  String pub, {
  bool onlyWhileNew = false,
}) async {
  try {
    DeviceLogListing listing;
    try {
      listing = await notifier.deviceListing();
    } catch (_) {
      listing = DeviceLogListing.empty;
    }
    if (!navigator.mounted) return;
    DeviceLogRow? found;
    for (final row in listing.members) {
      if (row.member.pub == pub) found = row;
    }
    final isNew =
        found != null &&
        (found.pending || notifier.newDevices.any((d) => d.pub == pub));
    final row = found != null && (isNew || !onlyWhileNew) ? found : null;
    await navigator.push(
      phoneRoute(
        (_) => row == null
            ? DevicesPage(notifier: notifier)
            : DeviceDetailPage(notifier: notifier, row: row, isNew: isNew),
      ),
    );
  } catch (error) {
    debugPrint('devices: could not open the device: $error');
  }
}

/// What "Trust again" says when the list it would trust is another account's than the one signed in to.
const otherAccountMessage =
    'The device list now belongs to a different account than the one you signed in with. '
    'Sign in again to switch accounts.';

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
  String? _error;

  /// [_error] is advice rather than a failure (amber, not red).
  bool _errorWarns = false;

  /// The devices that were new when this page opened: they keep their `New` badge for the visit,
  /// though opening the page clears the banner that announced them.
  late final Set<String> _newPubs;

  /// The visit's devices were marked seen (once, after the first read of the list).
  bool _seenMarked = false;

  /// "Already on your account" was dismissed on this visit, saved or not.
  bool _baselineHidden = false;

  AppNotifier get _app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _app.addListener(_changed);
    _newPubs = {for (final m in _app.newDevices) m.pub};
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
    final listing = await _app.deviceListing();
    // The banner as it is while the list is read: what the visit reviews. A device announced during the
    // awaits below was never shown, and must stay.
    final banner = [for (final d in _app.newDevices) d.pub];
    final seen = await _app.devicesLastSeen();
    if (!mounted) return;
    setState(() {
      _listing = listing;
      _seen = seen;
      // What was pending when the list loaded keeps its badge for the visit, though the visit clears it.
      _newPubs.addAll(listing.pending);
    });
    // Looking at the list IS reviewing the new devices: the banner that pointed here is done. Only
    // once the list has been read, so the badges above were taken first.
    if (!_seenMarked) {
      _seenMarked = true;
      // A key that joined and left before anyone looked is cleared by its own "Got it" only. At startup
      // the app may not have read it as departed yet (a replayed notice put it on the banner); this
      // list did.
      final gone = {for (final d in listing.departed) d.pub};
      _app.seenNewDevices(
        pending: listing.pending,
        shown: [
          for (final p in banner)
            if (!gone.contains(p)) p,
        ],
      );
    }
  }

  Future<void> _gotIt() async {
    // Hidden here whether or not it could be saved: it was read.
    if (mounted) setState(() => _baselineHidden = true);
    await _app.seeDeviceBaseline();
    if (!mounted) return;
    unawaited(_load());
  }

  void _openHistory() => unawaited(
    Navigator.of(context)
        .push(phoneRoute((_) => DeviceHistoryPage(notifier: _app))),
  );

  void _open(DeviceLogRow row) => unawaited(
    Navigator.of(context).push(
      phoneRoute(
        (_) => DeviceDetailPage(
          notifier: _app,
          row: row,
          lastSeen: _seen[row.member.pub],
          isNew: _newPubs.contains(row.member.pub),
          onMine: () => setState(() => _newPubs.remove(row.member.pub)),
        ),
      ),
    ),
  );

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
      _errorWarns = false;
    });
    var failed = 0;
    for (final row in rows) {
      if (await _app.removeDevice(row.member.pub) != null) failed++;
    }
    if (!mounted) return;
    setState(() {
      _removingUnused = false;
      _errorWarns = false;
      _error = failed == 0
          ? null
          : 'Couldn’t remove $failed of them. Try again.';
    });
  }

  /// What was on the account before this device joined, apart from this device.
  List<DeviceLogRow> _baseline(DeviceLogListing listing) {
    // The log names the set (it also holds keys that were on the account before a re-trusted list);
    // without it, the keys at or before the seq this device joined at.
    final named = listing.baseline.toSet();
    return [
      for (final row in listing.members)
        if (!row.self &&
            (named.isNotEmpty
                ? named.contains(row.member.pub)
                : row.member.seq <= listing.joinedSeq))
          row,
    ];
  }

  Future<void> _trustAgain() async {
    final log = _app.deviceLog;
    if (log == null) return;
    final preview = await log.rebaseline(confirm: false);
    if (!mounted) return;
    if (preview == null) {
      setState(() {
        _error = 'Couldn’t read a valid device list. Try again later.';
        _errorWarns = false;
      });
      return;
    }
    if (preview.otherAccount) {
      setState(() {
        _error = otherAccountMessage;
        _errorWarns = true;
      });
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
          : 'Only if every device added below is yours:\n\n${lines.join('\n')}',
      confirmLabel: 'Trust again',
      icon: LucideIcons.shieldAlert300,
    );
    if (!confirmed || !mounted) return;
    // Confirm the list that was shown, not whatever the backend serves now.
    final result = await log.rebaseline(
      confirm: true,
      expectedHead: preview.head,
    );
    if (!mounted) return;
    if (result == null) {
      setState(() {
        _error = 'Couldn’t trust the device list again. Try again later.';
        _errorWarns = false;
      });
      return;
    }
    if (result.otherAccount) {
      setState(() {
        _error = otherAccountMessage;
        _errorWarns = true;
      });
    } else if (result.logChanged) {
      // The list moved between the preview and the confirm: show it again.
      setState(() {
        _error = 'The device list changed while you were reviewing it. Review it again.';
        _errorWarns = true;
      });
      unawaited(_trustAgain());
    } else if (_error != null) {
      // Trusted: an error from an earlier try no longer applies.
      setState(() {
        _error = null;
        _errorWarns = false;
      });
    }
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
            Text(
              'Every computer and app signed in to your account. Each reaches your machines '
              'end to end encrypted. Remove one you do not recognise.',
              style: tty.style(color: tty.dim),
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
                    detailLines: null,
                    onTap: listing.frozen != null
                        ? () => unawaited(_trustAgain())
                        : null,
                    value: listing.frozen != null ? 'Review' : null,
                  ),
                ],
              ),
            ],
            if (listing != null &&
                !listing.baselineSeen &&
                !_baselineHidden) ...[
              if (_baseline(listing) case final baseline
                  when baseline.isNotEmpty) ...[
                const SizedBox(height: 12),
                _BaselinePanel(
                  key: const Key('account-devices-baseline'),
                  rows: baseline,
                  onGotIt: () => unawaited(_gotIt()),
                ),
              ],
            ],
            if (_error case final error?) ...[
              const SizedBox(height: 12),
              Text(
                error,
                key: const Key('account-devices-error'),
                // Amber when the person has something to act on (another account, a list that moved):
                // the same severity as the desktop. A failure is red.
                style: tty.style(color: _errorWarns ? tty.yellow : tty.red),
              ),
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
            else ...[
              if (selfRow(listing.members) case final self?) ...[
                SettingsGroup(
                  children: [
                    _ThisDeviceCard(
                      key: const Key('account-device-this'),
                      row: self,
                    ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              SettingsGroup(
                children: [
                  for (final row in orderDeviceRows(
                    listing.members,
                    _seen,
                    _newPubs,
                  ))
                    SettingsRow(
                      key: ValueKey('account-device-${row.member.pub}'),
                      title: row.member.label.trim().isEmpty
                          ? 'Unnamed device'
                          : row.member.label,
                      detail: deviceDetailLine(
                        row,
                        _seen[row.member.pub],
                        DateTime.now(),
                        sameName: sharedNames(listing.members)
                            .contains(row.member.label.trim()),
                      ),
                      value: row.suspended
                          ? 'Suspended'
                          : _newPubs.contains(row.member.pub)
                          ? 'New'
                          : null,
                      onTap: () => _open(row),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              SettingsGroup(
                children: [
                  SettingsRow(
                    key: const Key('account-devices-history'),
                    title: 'History',
                    onTap: _openHistory,
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

/// This phone's own name and key code, copyable, with what it is for: the code the other devices
/// show for this one.
class _ThisDeviceCard extends StatelessWidget {
  const _ThisDeviceCard({super.key, required this.row});

  final DeviceLogRow row;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final name = row.member.label.trim().isEmpty
        ? 'Unnamed device'
        : row.member.label;
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'This device · $name',
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 8),
          FingerprintBlock(
            row.fingerprint,
            large: false,
            copyKey: const Key('this-device-copy'),
          ),
          const SizedBox(height: 4),
          Text(
            'This is the code your other devices show for this device.',
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 12.5,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

/// "Already on your account": the devices this one found when it joined, shown once so a stranger
/// among them is seen. Nothing to confirm — "Got it" only stops showing it.
class _BaselinePanel extends StatelessWidget {
  const _BaselinePanel({super.key, required this.rows, required this.onGotIt});

  final List<DeviceLogRow> rows;
  final VoidCallback onGotIt;

  static String _line(DeviceLogRow row) {
    final label = row.member.label.trim();
    final kind = row.member.kind == 'machine' ? 'Computer' : 'App';
    return '${label.isEmpty ? 'A device' : label} · $kind · ${row.fingerprint}';
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return SettingsGroup(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const TtyText('Already on your account', weight: FontWeight.w600),
              const SizedBox(height: 4),
              Text(
                'These were on your account before this device joined. If one isn’t yours, remove it.',
                style: tty.style(color: tty.dim),
              ),
              const SizedBox(height: 8),
              for (final row in rows)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(_line(row), style: tty.style()),
                ),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  key: const Key('account-devices-baseline-got-it'),
                  onPressed: onGotIt,
                  child: const Text('Got it'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
