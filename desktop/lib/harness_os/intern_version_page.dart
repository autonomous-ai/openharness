import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import 'harness_os.dart';
import 'intern_dialog.dart';
import 'intern_page.dart';

/// A version as a person reads it: the release, without the build pacman names a package by
/// (`0.1.8.r1792577066.g8df82cc2bc-1` is `0.1.8`). Anything else as it is.
String? shortVersion(String? version) =>
    version == null ? null : HarnessOs.releaseOf(version);

/// Manage Intern 3 ▸ Version: what it runs, part by part — its OS, hn and the CLI (CLI osDevice.ts
/// `update.parts`) — and its Update. The phone's Version page (mobile computer_version_page.dart).
///
/// hn and the CLI come as one runtime: updated together, with no restart. A new OS restarts the
/// computer once it is in (`harness update --reboot`); an encrypted one then waits for its password,
/// which [onUnlock] starts.
class InternVersionPage extends InternPage {
  const InternVersionPage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
    this.onUnlock,
  });

  final VoidCallback? onUnlock;

  /// How often a check for updates is followed: the computer answers `update.checking` until done.
  @visibleForTesting
  static Duration checkEvery = const Duration(seconds: 3);

  /// How often an update is followed until nothing waits.
  @visibleForTesting
  static Duration updateEvery = const Duration(seconds: 5);

  /// From going down to its Wi-Fi up at the password: how long the computer's startup takes.
  @visibleForTesting
  static Duration hotspotAfter = const Duration(seconds: 20);

  /// How long a check gets: the computer bounds its own at 6 minutes (CLI osDevice.ts CHECK_TIMEOUT_MS).
  static const checkFor = Duration(minutes: 7);

  /// How long an update gets before the page stops waiting and says so.
  static const updateFor = Duration(minutes: 6);

  @override
  State<InternVersionPage> createState() => _InternVersionPageState();
}

class _InternVersionPageState extends State<InternVersionPage> {
  bool _starting = false, _checking = false, _confirming = false;

  /// Started from here and not finished: what it is doing.
  String _started = '';

  /// A restart is part of it: the computer goes offline, and comes back (or waits to be unlocked).
  bool _restarting = false;

  /// It went offline for its restart.
  bool _wentDown = false;

  /// The update started here carried a new OS: named with the rest once it is in.
  bool _systemUpdate = false;

  /// A new OS on a computer that does not restart itself: done when the update is in, waiting for it.
  bool _manualRestart = false;

  /// How it ended: done, or not ([_finishedWell] false).
  String _finished = '';
  bool _finishedWell = false;
  Timer? _watch;

  HarnessOs get _os => widget.app.harnessOs;
  String get _id => widget.machineId;
  String get _name => widget.name;
  Map<String, dynamic>? get _status => _os.status[_id];

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_changed);
    // A check already under way there (asked before this page opened): followed to its end.
    if (_checkingThere()) _followCheck();
  }

  @override
  void dispose() {
    _watch?.cancel();
    widget.app.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  bool _checkingThere() => _os.update(_id)['checking'] == true;
  bool get _restartRequired => _os.update(_id)['restartRequired'] == true;

  /// Online as the account and this window's line to it say.
  bool _isOnline() => widget.app.machineStates[_id]?.isOffline == false;

  /// Every [every], at most for [within]: [tick] says true once it is done.
  void _every(
    Duration every,
    Duration within,
    Future<bool> Function() tick,
    VoidCallback timedOut,
  ) {
    _watch?.cancel();
    var left = (within.inMilliseconds / every.inMilliseconds).ceil();
    var asking = false;
    _watch = Timer.periodic(every, (timer) async {
      if (asking || !mounted) return;
      asking = true;
      try {
        if (await tick() || !mounted) {
          // This one: a tick may have set [_watch] to what comes next.
          timer.cancel();
          return;
        }
        if (--left <= 0) {
          timer.cancel();
          timedOut();
        }
      } finally {
        asking = false;
      }
    });
  }

  String _versionsNow() {
    final parts = _os.parts(_id);
    String? of(String key) => shortVersion(parts[key]?['running'] as String?);
    // A daemon that does not name its parts (released before them) still says which CLI it runs.
    final cli = of('cli') ?? _os.update(_id)['runtime'] as String?;
    final named = [
      if (of('os') != null && _systemUpdate) 'Harness OS ${of('os')}',
      if (of('hn') != null) 'hn ${of('hn')}',
      if (cli != null) 'CLI $cli',
    ];
    return named.isEmpty ? '' : ': ${named.join(', ')}';
  }

  void _finish(String text, {required bool well}) => setState(() {
    _started = '';
    _checking = false;
    _finishedWell = well;
    _finished = text;
  });

  /// Check for updates now instead of at the computer's next check (every 15 minutes, a new Harness
  /// OS once a day). Answered at once; followed until the computer is done.
  Future<void> _check() async {
    setState(() {
      _checking = true;
      _finished = '';
    });
    final reply = await widget.app.osDevice(_id, {'action': 'check_update'});
    if (!mounted) return;
    if (reply['started'] != true) {
      _finish('Could not ask $_name to check. Try again.', well: false);
      return;
    }
    _followCheck();
  }

  void _followCheck() {
    _checking = true;
    _every(InternVersionPage.checkEvery, InternVersionPage.checkFor, () async {
      final before = _status;
      await _os.refresh(_id, force: true);
      if (!mounted) return true;
      // Its own fresh answer, saying the check is over.
      if (identical(before, _status) || _checkingThere()) return false;
      final error = _os.update(_id)['checkError'] as String?;
      _finish(
        error ??
            (_os.updateAvailable(_id) || _os.updateRestarts(_id)
                ? 'A new version is ready.'
                : '$_name is up to date.'),
        well: error == null,
      );
      return true;
    }, () => _finish('$_name has not said the check is done.', well: false));
  }

  Future<void> _update({bool confirmed = false}) async {
    final restarts = _os.updateRestarts(_id);
    if (restarts && !confirmed) {
      setState(() => _confirming = true);
      return;
    }
    // A computer that names its parts takes the restart with the update; an older one leaves it to
    // someone at the computer.
    final restartsItself = _os.parts(_id).isNotEmpty;
    setState(() {
      _confirming = false;
      _starting = true;
      _finished = '';
    });
    final reply = await widget.app.osDevice(_id, {
      'action': 'update',
      if (restarts) 'reboot': true,
    });
    if (!mounted) return;
    setState(() => _starting = false);
    if (reply['started'] != true) {
      _finish(
        reply['error'] == 'BUSY'
            ? '$_name is already updating.'
            : 'Could not start the update. Try again.',
        well: false,
      );
      return;
    }
    setState(() {
      _restarting = restarts && restartsItself;
      _systemUpdate = restarts;
      _manualRestart = restarts && !restartsItself;
      _wentDown = false;
      _started = !restarts
          ? 'Updating hn and the CLI… Its harnesses keep running.'
          : restartsItself
          ? 'Updating Harness OS… $_name restarts once it is in.'
          : 'Updating… Restart $_name when it says so, to finish.';
    });
    _follow(encrypted: _os.encrypted(_id));
  }

  /// Asked every few seconds until the update is in: the computer answers again with nothing
  /// waiting. With a restart, it first goes offline; an encrypted one then waits to be unlocked.
  void _follow({required bool encrypted}) => _every(
    InternVersionPage.updateEvery,
    InternVersionPage.updateFor,
    () async {
      if (_restarting) {
        // The account's word, asked afresh: the list held here is not, while this page waits.
        try {
          await widget.app.refreshMachines();
        } catch (_) {
          // Asked again in a moment.
        }
        if (!mounted) return true;
        if (!_isOnline()) {
          _wentDown = true;
          if (encrypted) {
            _awaitHotspot();
            return true;
          }
        }
      }
      final before = _status;
      await _os.refresh(_id, force: true);
      if (!mounted) return true;
      final answered = !identical(before, _status);
      if (answered && _manualRestart && _restartRequired) {
        // An older computer does not restart itself: the update is in, the restart is someone's.
        _finish('The update is in. Restart $_name to finish it.', well: true);
        return true;
      }
      final settled =
          answered &&
          !_os.updateAvailable(_id) &&
          !_os.updateRestarts(_id) &&
          (!_restarting || _wentDown);
      if (!settled) return false;
      _finish('Updated${_versionsNow()}.', well: true);
      return true;
    },
    () => _finish('$_name has not said the update is in.', well: false),
  );

  /// Down for its restart: its startup opens its Wi-Fi some 20 seconds later, waiting for its
  /// password. The rest is Unlock's.
  void _awaitHotspot() {
    final hotspot = _os.hotspot(_id) ?? 'Harness-…';
    setState(
      () => _started =
          '$_name is restarting. Its Wi-Fi "$hotspot" opens in about '
          '${InternVersionPage.hotspotAfter.inSeconds} s…',
    );
    _watch?.cancel();
    _watch = Timer(InternVersionPage.hotspotAfter, () {
      if (!mounted) return;
      _finish(
        '$_name updated and restarted. It waits for its password on "$hotspot".',
        well: true,
      );
    });
  }

  void _unlock() {
    final onUnlock = widget.onUnlock;
    Navigator.of(context).pop();
    onUnlock?.call();
  }

  Widget _part(String key, String title) {
    final part = _os.parts(_id)[key];
    final runningFull = part?['running'] as String?;
    final nextFull = part?['next'] as String?;
    final running = shortVersion(runningFull);
    // hn and the CLI come as one runtime: one of them new marks both waiting, so a part whose
    // waiting version is the one it runs has nothing new. The OS only for a newer release.
    final waiting = key == 'os'
        ? _os.newRelease(_id)
        : part?['available'] == true &&
              (nextFull == null || nextFull != runningFull);
    final next = shortVersion(nextFull) ?? 'new version';
    return InternRow(
      key: Key('intern-version:$key'),
      title: title,
      value: waiting
          ? (running == null ? next : '$running → $next')
          : running ?? '—',
      valueColor: waiting ? DesktopChrome.accent : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final hotspot = _os.hotspot(_id) ?? 'Harness-…';
    if (_confirming) {
      final restartsItself = _os.parts(_id).isNotEmpty;
      return InternDialogFrame(
        title: 'Update and restart $_name?',
        actions: [
          internButton('Cancel', () => setState(() => _confirming = false)),
          internButton(
            'Update',
            () => unawaited(_update(confirmed: true)),
            key: const Key('intern-version-confirm'),
            primary: true,
          ),
        ],
        children: [
          InternText(
            [
              restartsItself
                  ? 'The new Harness OS needs a restart: $_name restarts by itself once it is in.'
                  : 'The new Harness OS needs a restart: restart $_name when it is in.',
              'Harnesses running there stop, and start again after the restart.',
              'Do not turn $_name off until the update is done.',
              if (_os.encrypted(_id))
                'After the restart it waits for its password, on its Wi-Fi "$hotspot".',
            ].join(' '),
          ),
        ],
      );
    }
    final parts = _os.parts(_id);
    final available = _os.updateAvailable(_id);
    final restartRequired = _restartRequired;
    // Gone down for its restart, or offline: what it last said, nothing to start.
    final online = !(_restarting && _wentDown) && _isOnline();
    final idle = _started.isEmpty;
    final canCheck =
        online &&
        idle &&
        !available &&
        !restartRequired &&
        _os.feature(_id, 'check_update');
    final canUpdate = online && idle && (available || restartRequired);
    final unlock =
        !online && idle && _os.encrypted(_id) && widget.onUnlock != null;
    final message = idle ? (_finished.isEmpty ? null : _finished) : _started;
    return InternDialogFrame(
      title: 'Version',
      message: message,
      error: idle && _finished.isNotEmpty && !_finishedWell,
      actions: [
        internButton('Back', widget.onBack, key: const Key('intern-back')),
        if (canCheck)
          internButton(
            _checking ? 'Checking…' : 'Check now',
            _checking ? null : () => unawaited(_check()),
            key: const Key('intern-version-check'),
            primary: true,
          )
        else if (canUpdate)
          internButton(
            _starting
                ? 'Starting…'
                : restartRequired && !available
                ? 'Restart'
                : 'Update',
            _starting ? null : () => unawaited(_update()),
            key: const Key('intern-version-update'),
            primary: true,
          ),
        if (unlock)
          internButton(
            'Unlock',
            _unlock,
            key: const Key('intern-version-unlock'),
            primary: true,
          ),
      ],
      children: [
        if (_status == null)
          InternText('Asking $_name…')
        else if (parts.isEmpty)
          InternText(
            available
                ? 'A new version is ready.'
                : 'Up to date. This version of $_name does not name each part.',
          )
        else ...[
          _part('os', 'Harness OS'),
          _part('hn', 'hn'),
          _part('cli', 'CLI'),
          const SizedBox(height: 8),
        ],
        if (restartRequired && idle && _finished.isEmpty)
          InternText('An update is in. $_name finishes it when it restarts.'),
        if (canUpdate && _os.updateRestarts(_id))
          InternText('The new Harness OS restarts $_name.'),
        // Cut off mid-update, a computer can be left half old and half new.
        if (!idle)
          Text(
            'Do not turn $_name off until the update is done.',
            key: const Key('intern-version-keep-on'),
            style: DesktopChrome.text(
              color: Theme.of(context).colorScheme.error,
            ),
          ),
      ],
    );
  }
}
