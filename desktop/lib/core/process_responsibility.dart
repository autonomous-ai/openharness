// The libSystem probe needs dart:ffi, which a browser build cannot compile.
export 'mac_responsibility_probe_native.dart'
    if (dart.library.js_interop) 'mac_responsibility_probe_web.dart';

/// Who macOS holds responsible for a process — the identity its Local Network permission is judged by.
///
/// A daemon this app spawns inherits the app as its responsible process, so it inherits the app's
/// Local Network grant (Info.plist declares `NSLocalNetworkUsageDescription` and the Bonjour type). A
/// daemon started anywhere else does not: `harness start` from a tmux or ssh shell leaves the bare
/// `node` binary responsible for itself, and macOS then refuses it every LAN address without ever
/// asking — robot discovery fails with `LOCAL_NETWORK_BLOCKED` and terminal P2P loses its LAN path.
abstract interface class ResponsibilityProbe {
  /// The responsible process of [pid], or null when it cannot be asked.
  int? responsiblePid(int pid);

  /// [pid]'s executable, or null when the process is gone.
  String? executablePath(int pid);
}

enum DaemonOwnerAction {
  keep,
  restart,

  /// The owner alone cannot settle it: ask the daemon to reach the LAN, restart only if refused.
  testLan,
}

/// What to do about the daemon, and why — the why goes to the log.
class DaemonOwnerVerdict {
  final DaemonOwnerAction action;
  final String reason;

  const DaemonOwnerVerdict._(this.action, this.reason);
  const DaemonOwnerVerdict.keep(String reason)
    : this._(DaemonOwnerAction.keep, reason);
  const DaemonOwnerVerdict.restart(String reason)
    : this._(DaemonOwnerAction.restart, reason);
  const DaemonOwnerVerdict.testLan(String reason)
    : this._(DaemonOwnerAction.testLan, reason);

  bool get restart => action == DaemonOwnerAction.restart;
}

/// Restart only on proof. Every answer that cannot be established keeps the daemon: a restart
/// interrupts every terminal the app has open, and a guess is not worth that.
DaemonOwnerVerdict judgeDaemonOwner({
  required int daemonPid,
  required int ownPid,
  required ResponsibilityProbe probe,
}) {
  final mine = probe.responsiblePid(ownPid);
  final theirs = probe.responsiblePid(daemonPid);
  if (mine == null || theirs == null) {
    return const DaemonOwnerVerdict.keep('owner unknown');
  }
  if (theirs == mine) return const DaemonOwnerVerdict.keep('owned by this app');
  // Ambiguous, measured: a daemon started from a tmux/ssh shell answers this (and is refused the
  // LAN), but so does one whose app has since QUIT — and that one keeps the app's grant. Only
  // asking the daemon to use the network tells the two apart.
  if (theirs == daemonPid) {
    return DaemonOwnerVerdict.testLan(
      'macOS names it its own owner (${probe.executablePath(daemonPid) ?? 'pid $daemonPid'})',
    );
  }
  final theirPath = probe.executablePath(theirs);
  // Gone: most often an earlier launch of this app, which macOS still counts as the owner.
  if (theirPath == null) {
    return DaemonOwnerVerdict.keep('owner pid $theirs has exited');
  }
  final myPath = probe.executablePath(mine);
  if (myPath != null && theirPath == myPath) {
    return const DaemonOwnerVerdict.keep('owned by another launch of this app');
  }
  return DaemonOwnerVerdict.restart('owned by $theirPath');
}

/// Checks each daemon pid once and restarts the ones this app does not own — at boot and from the
/// supervisor's interval check alike, so a daemon replaced from a terminal while the app is open is
/// caught within one tick.
class DaemonOwnerGuard {
  DaemonOwnerGuard({
    required this.probe,
    required this.ownPid,
    required this.restart,
    required this.lanBlocked,
    required this.log,
    this.paused,
  });

  final ResponsibilityProbe probe;
  final int ownPid;

  /// Stops the daemon and brings one back through this app; the new daemon's pid once it is ready,
  /// or null when none came back.
  final Future<int?> Function() restart;

  /// Asks the running daemon to reach the LAN: true when macOS refused it, false when it got
  /// through, null when the daemon could not say.
  final Future<bool?> Function() lanBlocked;
  final void Function(String line) log;

  /// True while the daemon must not be touched (a firmware flash holds its port).
  final bool Function()? paused;

  final _judged = <int>{};
  Future<bool>? _inFlight;
  bool _gaveUp = false;

  /// Judge [daemonPid] again, as if it were new: something now needs the LAN (a person looking for
  /// their first robot) that did not when it was first kept.
  Future<bool> recheck(int daemonPid) async {
    // A check already running may have skipped the LAN test the caller now
    // needs; judge again once it is done, rather than taking its answer.
    final pending = _inFlight;
    if (pending != null) await pending;
    _judged.remove(daemonPid);
    return check(daemonPid);
  }

  /// Judges [daemonPid] if it is new, restarting it when needed. True when a restart happened.
  Future<bool> check(int daemonPid) {
    // A restart in progress is the answer for every caller, whichever pid they saw.
    final inFlight = _inFlight;
    if (inFlight != null) return inFlight;
    if (_gaveUp || _judged.contains(daemonPid)) return Future.value(false);
    if (paused?.call() ?? false) return Future.value(false);
    return _inFlight ??= _check(daemonPid).whenComplete(() => _inFlight = null);
  }

  Future<bool> _check(int daemonPid) async {
    _judged.add(daemonPid);
    final verdict = judgeDaemonOwner(
      daemonPid: daemonPid,
      ownPid: ownPid,
      probe: probe,
    );
    var reason = verdict.reason;
    if (verdict.action == DaemonOwnerAction.testLan) {
      final blocked = await lanBlocked();
      if (blocked != true) {
        log(
          'daemon pid $daemonPid kept: $reason, but it '
          '${blocked == false ? 'reaches the local network' : 'could not test the local network'}',
        );
        return false;
      }
      reason = '$reason, and macOS refuses it the local network';
    } else if (!verdict.restart) {
      log('daemon pid $daemonPid kept: $reason');
      return false;
    }
    log('restarting daemon pid $daemonPid through the app: $reason');
    final next = await restart();
    if (next == null) {
      log('restart: no daemon came back ready');
      return true;
    }
    _judged.add(next);
    final again = judgeDaemonOwner(
      daemonPid: next,
      ownPid: ownPid,
      probe: probe,
    );
    if (again.action != DaemonOwnerAction.keep) {
      // Restarting again would give the same answer: stop rather than loop.
      _gaveUp = true;
      log(
        'restart did not change the owner of pid $next (${again.reason}); not retrying this session',
      );
    } else {
      log('daemon pid $next: ${again.reason}');
    }
    return true;
  }
}
