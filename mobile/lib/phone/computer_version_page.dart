import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart';
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';
import 'unlock_computer_page.dart';

/// Computers ▸ a Harness OS computer ▸ Version: what it runs, part by part — its OS, hn and the CLI
/// (CLI osDevice.ts `update.parts`) — with a dot where a new one waits, and its Update.
///
/// hn and the CLI come as one runtime: updated together, with no restart. A new OS restarts the
/// computer once it is in (`harness update --reboot`); an encrypted one then waits for its password,
/// unlocked from here ([UnlockComputerPage]).
class ComputerVersionPage extends StatefulWidget {
  const ComputerVersionPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<ComputerVersionPage> createState() => _ComputerVersionPageState();
}

class _ComputerVersionPageState extends State<ComputerVersionPage> {
  bool _asking = true;
  bool _starting = false;

  /// Started from here: what it said it would do.
  String _started = '';
  bool _restarting = false;

  AppNotifier get _app => widget.notifier;
  String get _id => widget.machineId;
  String get _name => _app.stateOf(_id)?.machine.displayName ?? 'The computer';

  @override
  void initState() {
    super.initState();
    _app.addListener(_changed);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    _app.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _refresh() async {
    setState(() => _asking = true);
    await _app.refreshOsStatus(_id, force: true);
    if (mounted) setState(() => _asking = false);
  }

  Future<void> _update() async {
    final restarts = _app.updateRestarts(_id);
    final encrypted = _app.harnessOsComputers[_id]?.encrypted ?? false;
    final hotspot = _app.harnessOsComputers[_id]?.hotspot ?? 'Harness-…';
    final parts = _app.osParts(_id);
    // A computer that names its parts takes the restart with the update; an older one leaves it to
    // someone at the computer.
    final restartsItself = parts.isNotEmpty;
    if (restarts) {
      final confirmed = await confirmPhoneAction(
        context,
        icon: LucideIcons.rotateCw300,
        title: 'Update and restart $_name?',
        message: [
          restartsItself
              ? 'The new Harness OS needs a restart: $_name restarts by itself once it is in.'
              : 'The new Harness OS needs a restart: restart $_name when it is in.',
          'Harnesses running there stop, and start again after the restart.',
          if (encrypted)
            'After the restart it waits for its password: unlock it from this phone near it, on its Wi-Fi "$hotspot".',
        ].join(' '),
        confirmLabel: 'Update and restart',
      );
      if (!confirmed || !mounted) return;
    }
    setState(() => _starting = true);
    final reply = await _app.osDevice(_id, {
      'action': 'update',
      if (restarts) 'reboot': true,
    });
    if (!mounted) return;
    setState(() => _starting = false);
    if (reply['started'] == true) {
      _app.osStatus.remove(_id);
      setState(() {
        _restarting = restarts && restartsItself;
        _started = !restarts
            ? '$_name is updating hn and the CLI. Its harnesses keep running.'
            : restartsItself
            ? encrypted
                  ? '$_name is updating, then restarts. When it has restarted, unlock it here.'
                  : '$_name is updating, then restarts and comes back by itself.'
            : '$_name is updating. Restart it when it says so, to finish.';
      });
      // Asked again once it is back on the new version.
      Timer(
        const Duration(minutes: 2),
        () => unawaited(_app.refreshOsStatus(_id, force: true)),
      );
    } else {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(
            reply['error'] == 'BUSY'
                ? '$_name is already updating.'
                : 'Could not start the update. Try again.',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final parts = _app.osParts(_id);
    final available = _app.updateAvailable(_id);
    final restartRequired =
        (_app.osStatus[_id]?['update'] as Map?)?['restartRequired'] == true;
    final computer = _app.harnessOsComputers[_id];
    Text say(String text) => Text(text, style: tty.style(color: tty.dim));

    SettingsRow row(String key, String title) {
      final part = parts[key];
      final running = part?['running'] as String?;
      final next = part?['next'] as String?;
      final waiting = part?['available'] == true;
      return SettingsRow(
        key: ValueKey('version-$key'),
        title: title,
        value: waiting ? null : running ?? '—',
        // The dot: a new one waits.
        trailing: waiting
            ? Text(
                '● ${next ?? 'new version'}',
                style: tty.style(color: tty.green, size: TtySize.meta),
              )
            : null,
        detail: waiting && running != null ? 'now $running' : null,
      );
    }

    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    MediaQuery.paddingOf(context).bottom + 24,
                  ),
                  children: [
                    const TtyText(
                      'Version',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 8),
                    say('What $_name runs.'),
                    const SizedBox(height: 12),
                    if (_asking && _app.osStatus[_id] == null)
                      const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else if (parts.isEmpty)
                      say(
                        available
                            ? 'A new version is ready. Update $_name to see each part here next time.'
                            : 'Up to date.',
                      )
                    else
                      SettingsGroup(
                        children: [
                          row('os', 'Harness OS'),
                          row('hn', 'hn'),
                          row('cli', 'CLI'),
                        ],
                      ),
                    const SizedBox(height: 12),
                    if (restartRequired && _started.isEmpty)
                      say(
                        'An update is in. $_name finishes it when it restarts.',
                      ),
                    if (_started.isNotEmpty)
                      Text(
                        _started,
                        key: const Key('version-started'),
                        style: tty.style(color: tty.text),
                      ),
                    const SizedBox(height: 20),
                    if (_started.isEmpty)
                      TtyPrimaryButton(
                        key: const Key('version-update'),
                        label: restartRequired && !available
                            ? 'Restart to finish'
                            : _app.updateRestarts(_id)
                            ? 'Update and restart'
                            : available
                            ? 'Update'
                            : 'Up to date',
                        busy: _starting,
                        busyLabel: 'Starting…',
                        onPressed: available || restartRequired
                            ? () => unawaited(_update())
                            : null,
                      ),
                    if (_restarting && computer != null && computer.encrypted)
                      TtyTextButton(
                        key: const Key('version-unlock'),
                        label: 'Unlock after the restart…',
                        onPressed: () => Navigator.of(context).push(
                          phoneRoute(
                            (_) => UnlockComputerPage(
                              notifier: _app,
                              machineId: _id,
                              hotspotName: computer.hotspot,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
