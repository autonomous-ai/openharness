import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart';
import 'phone_status.dart';
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';
import 'unlock_computer_page.dart';

/// A version as a person reads it: the release, without the build pacman names a package by
/// (`0.1.8.r1792577066.g8df82cc2bc-1` is `0.1.8`). Anything else as it is.
String? shortVersion(String? version) {
  if (version == null) return null;
  return RegExp(r'^\d+\.\d+\.\d+').firstMatch(version)?.group(0) ?? version;
}

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

  /// Started from here and not finished: what it is doing, said under a spinner.
  String _started = '';

  /// A restart is part of it: the computer goes offline, and comes back (or waits to be unlocked).
  bool _restarting = false;

  /// It went offline for its restart.
  bool _wentDown = false;

  /// The update started here carried a new OS: named with the rest once it is in.
  bool _systemUpdate = false;

  /// A new OS on a computer that does not restart itself: done when the update is in, waiting for it.
  bool _manualRestart = false;

  /// How it ended: done (green) or not confirmed (red).
  String _finished = '';
  bool _finishedWell = false;
  Timer? _watch;

  /// How long an update gets before the page stops waiting and says so.
  static const _updateFor = Duration(minutes: 6);

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
    _watch?.cancel();
    _app.removeListener(_changed);
    super.dispose();
  }

  /// Unlocked and online again after the restart: the rest of the update. hn and the CLI waiting
  /// with it are activated by the first check after a restart, a few minutes in; asked for now,
  /// under the same spinner, until each part says its new version.
  Future<void> _unlock(String hotspot) async {
    await Navigator.of(context).push(
      phoneRoute(
        (_) => UnlockComputerPage(
          notifier: _app,
          machineId: _id,
          hotspotName: hotspot,
        ),
      ),
    );
    // Back without it online (the person left the Unlock page): nothing to finish yet.
    if (!mounted || !_isOnline()) return;
    setState(() {
      _restarting = false;
      _wentDown = false;
      _finished = '';
      _started = 'Finishing the update…';
    });
    // Its own answer, not the one from before the restart: the phone's line to the restarted daemon
    // comes back a little after the account says it is online.
    final stale = _app.osStatus[_id];
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    while (mounted && DateTime.now().isBefore(deadline)) {
      await _app.refreshOsStatus(_id, force: true);
      if (!identical(stale, _app.osStatus[_id])) break;
      await Future<void>.delayed(const Duration(seconds: 4));
    }
    if (!mounted) return;
    if (_app.updateAvailable(_id) && !_app.updateRestarts(_id)) {
      await _app.osDevice(_id, {'action': 'update'});
      if (!mounted) return;
      setState(() => _started = 'Finishing the update: hn and the CLI…');
    }
    _follow(encrypted: true);
  }

  /// From going down to its Wi-Fi up at the password: how long the computer's startup takes.
  static const _hotspotAfter = Duration(seconds: 20);

  /// Counted down under the spinner once it went down, then Unlock.
  void _awaitHotspot() {
    final hotspot = _app.harnessOsComputers[_id]?.hotspot ?? 'Harness-…';
    var left = _hotspotAfter.inSeconds;
    void say() => setState(
      () => _started =
          '$_name is restarting. Its Wi-Fi "$hotspot" opens in about ${left}s…',
    );
    say();
    _watch = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      left--;
      if (left > 0) {
        say();
        return;
      }
      _watch?.cancel();
      setState(() {
        _started = '';
        _finishedWell = true;
        _finished =
            '$_name updated and restarted. It waits for its password on "$hotspot": unlock it here.';
      });
    });
  }

  /// Online both ways: the account says it runs, and this phone's own line to it is not down — the
  /// first to know when it restarts (a clean restart tells the relay at once; the account's list
  /// is only as fresh as its last read).
  bool _isOnline() {
    final state = _app.stateOf(_id);
    if (state != null &&
        phoneMachineStatusOf(state) == PhoneMachineStatus.offline) {
      return false;
    }
    return _app.machines.where((m) => m.machineId == _id).firstOrNull?.status ==
        'running';
  }

  String _versionsNow() {
    final parts = _app.osParts(_id);
    String? of(String key) => shortVersion(parts[key]?['running'] as String?);
    // A daemon that does not name its parts (released before them) still says which CLI it runs.
    final update = _app.osStatus[_id]?['update'];
    final cli =
        of('cli') ?? (update is Map ? update['runtime'] as String? : null);
    final named = [
      if (of('os') != null && _systemUpdate) 'Harness OS ${of('os')}',
      if (of('hn') != null) 'hn ${of('hn')}',
      if (cli != null) 'CLI $cli',
    ];
    return named.isEmpty ? '' : ': ${named.join(', ')}';
  }

  /// Asked every few seconds until the update is in: the computer answers again with nothing
  /// waiting. With a restart, it first goes offline; an encrypted one then waits to be unlocked.
  void _follow({required bool encrypted}) {
    final deadline = DateTime.now().add(_updateFor);
    var asking = false;
    _watch?.cancel();
    _watch = Timer.periodic(const Duration(seconds: 5), (_) async {
      if (asking || !mounted || _started.isEmpty) return;
      asking = true;
      try {
        if (_restarting) {
          // The account's word, asked afresh: the list held here is not, while this page waits.
          try {
            await _app.refreshMachines();
          } catch (_) {
            // Asked again in a moment.
          }
          if (!mounted || _started.isEmpty) return;
        }
        if (_restarting && !_isOnline()) {
          _wentDown = true;
          if (encrypted) {
            // Down for its restart: its startup opens its Wi-Fi some 20 seconds later, waiting
            // for its password. The rest is the Unlock page's.
            _watch?.cancel();
            _awaitHotspot();
            return;
          }
        }
        final before = _app.osStatus[_id];
        await _app.refreshOsStatus(_id, force: true);
        if (!mounted || _started.isEmpty) return;
        final answered = !identical(before, _app.osStatus[_id]);
        final restartRequired =
            (_app.osStatus[_id]?['update'] as Map?)?['restartRequired'] == true;
        if (answered && _manualRestart && restartRequired) {
          // An older computer does not restart itself: the update is in, the restart is someone's.
          _watch?.cancel();
          setState(() {
            _started = '';
            _finishedWell = true;
            _finished = 'The update is in. Restart $_name to finish it.';
          });
          return;
        }
        final settled =
            answered &&
            !_app.updateAvailable(_id) &&
            !_app.updateRestarts(_id) &&
            (!_restarting || _wentDown);
        if (settled) {
          _watch?.cancel();
          setState(() {
            _started = '';
            _finishedWell = true;
            _finished = 'Updated${_versionsNow()}.';
          });
          return;
        }
        if (DateTime.now().isAfter(deadline)) {
          _watch?.cancel();
          setState(() {
            _started = '';
            _finishedWell = false;
            _finished =
                '$_name has not said the update is in. Pull down to ask it again.';
          });
        }
      } finally {
        asking = false;
      }
    });
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _refresh() async {
    if (_started.isEmpty) _finished = '';
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
        confirmLabel: 'Update',
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
      setState(() {
        _restarting = restarts && restartsItself;
        _systemUpdate = restarts;
        _manualRestart = restarts && !restartsItself;
        _wentDown = false;
        _finished = '';
        _started = !restarts
            ? 'Updating hn and the CLI… Its harnesses keep running.'
            : restartsItself
            ? 'Updating Harness OS… $_name restarts once it is in.'
            : 'Updating… Restart $_name when it says so, to finish.';
      });
      _follow(encrypted: encrypted);
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
    // Gone down for its restart, or offline: what it last said, nothing to start.
    final online = !(_restarting && _wentDown) && _isOnline();
    Text say(String text) => Text(text, style: tty.style(color: tty.dim));

    SettingsRow row(String key, String title) {
      final part = parts[key];
      final runningFull = part?['running'] as String?;
      final nextFull = part?['next'] as String?;
      final running = shortVersion(runningFull);
      // hn and the CLI come as one runtime: one of them new marks both waiting, so a part whose
      // waiting version is the one it runs has nothing new.
      // The OS only for a newer release, never a later build of the one it runs.
      final waiting = key == 'os'
          ? _app.osNewRelease(_id)
          : part?['available'] == true &&
                (nextFull == null || nextFull != runningFull);
      final next = shortVersion(nextFull);
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
                            ? 'A new version is ready.'
                            : 'Up to date. This version of $_name does not name each part.',
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
                    if (restartRequired &&
                        _started.isEmpty &&
                        _finished.isEmpty)
                      say(
                        'An update is in. $_name finishes it when it restarts.',
                      ),
                    if (_started.isNotEmpty)
                      Row(
                        children: [
                          const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              _started,
                              key: const Key('version-started'),
                              style: tty.style(color: tty.text),
                            ),
                          ),
                        ],
                      ),
                    if (_finished.isNotEmpty)
                      Text(
                        _finished,
                        key: const Key('version-finished'),
                        style: tty.style(
                          color: _finishedWell ? tty.green : tty.red,
                        ),
                      ),
                    const SizedBox(height: 20),
                    // Restarted and locked, or offline: nothing to update until it is back. An
                    // encrypted one is unlocked from here.
                    if (online && _started.isEmpty)
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
                    if (!online &&
                        _started.isEmpty &&
                        computer != null &&
                        computer.encrypted)
                      TtyPrimaryButton(
                        key: const Key('version-unlock'),
                        label: 'Unlock…',
                        onPressed: () => unawaited(_unlock(computer.hotspot)),
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
