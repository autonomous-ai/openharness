import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_history.dart';

import 'devices_page.dart' show openDeviceFromLog;
import 'tty.dart';
import 'tty_controls.dart';

/// Settings ▸ Your devices ▸ History — every device added to or removed from the account, newest
/// first, as this phone verified it. An active device opens its page.
class DeviceHistoryPage extends StatefulWidget {
  const DeviceHistoryPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<DeviceHistoryPage> createState() => _DeviceHistoryPageState();
}

class _DeviceHistoryPageState extends State<DeviceHistoryPage> {
  DeviceLogHistory? _history;
  bool _failed = false;

  /// [AppNotifier.devicesRevision] as of the last read, and the read in flight: the page re-reads when
  /// the log changes under it (a "Got it" on a banner clears a flag, a device joins), and only the
  /// newest read is shown.
  int _revision = 0;
  int _loads = 0;

  AppNotifier get _app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _app.addListener(_changed);
    unawaited(_load());
  }

  @override
  void dispose() {
    _app.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (_app.devicesRevision != _revision) unawaited(_load(quiet: true));
  }

  /// [quiet]: a refresh keeps what is on screen until the new read lands (and keeps it if that fails).
  Future<void> _load({bool quiet = false}) async {
    _revision = _app.devicesRevision;
    final load = ++_loads;
    if (!quiet) setState(() => _failed = false);
    try {
      final history = await _app.deviceHistory();
      if (!mounted || load != _loads) return;
      setState(() {
        _history = history;
        _failed = false;
      });
    } catch (_) {
      // A refresh that fails keeps what is on screen; with nothing on screen yet, it says so.
      if (mounted && load == _loads && (!quiet || _history == null)) {
        setState(() => _failed = true);
      }
    }
  }

  void _open(DevLogHistoryRow r) =>
      unawaited(openDeviceFromLog(Navigator.of(context), _app, r.pub));

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final history = _history;
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
              'Device history',
              size: TtySize.title,
              weight: FontWeight.w600,
            ),
            const SizedBox(height: 8),
            Text(
              'Every device added to or removed from your account, newest first, as this device verified it.',
              style: tty.style(color: tty.dim),
            ),
            const SizedBox(height: 12),
            if (_failed)
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Couldn’t load the history. Try again.',
                      key: const Key('device-history-failed'),
                      style: tty.style(color: tty.red),
                    ),
                  ),
                  TextButton(
                    onPressed: () => unawaited(_load()),
                    child: const Text('Try again'),
                  ),
                ],
              )
            else if (history != null) ...[
              for (final r in history.rows)
                _HistoryRow(
                  key: ValueKey('device-history-${r.seq}'),
                  sentence: historySentence(r),
                  when: fullDateTime(DateTime.fromMillisecondsSinceEpoch(r.at)),
                  fingerprint: r.fingerprint,
                  // Still new: a flag. A key that left before anyone looked stays flagged (on both its
                  // rows) until "Got it" on the banner.
                  flag: r.pending
                      ? (r.active ? 'New' : 'Left before you looked')
                      : null,
                  thisDevice: r.thisDevice,
                  onTap: r.active && !r.thisDevice ? () => _open(r) : null,
                ),
              if (history.rows.isEmpty && history.complete)
                Text(
                  'No history yet.',
                  key: const Key('device-history-empty'),
                  style: tty.style(),
                ),
              if (!history.complete) ...[
                const SizedBox(height: 8),
                Text(
                  'Older history needs a connection.',
                  key: const Key('device-history-incomplete'),
                  style: tty.style(color: tty.dim),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({
    super.key,
    required this.sentence,
    required this.when,
    required this.fingerprint,
    required this.flag,
    required this.thisDevice,
    this.onTap,
  });

  final String sentence;
  final String when;
  final String fingerprint;
  final String? flag;
  final bool thisDevice;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        // The flag sits under the date, not beside the sentence: a long one ("Left before you looked")
        // would squeeze the sentence into a column.
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              thisDevice ? '$sentence (this device)' : sentence,
              style: tty.style(),
            ),
            const SizedBox(height: 2),
            Text(
              fingerprint.isEmpty ? when : '$when · $fingerprint',
              style: tty.style(color: tty.dim),
            ),
            if (flag != null) ...[
              const SizedBox(height: 2),
              Text(
                flag!,
                key: const Key('device-history-flag'),
                style: tty.style(color: tty.yellow),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
