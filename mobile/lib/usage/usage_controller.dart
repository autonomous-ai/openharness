import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/test_run.dart';
import 'usage_accounts.dart';
import 'usage_source.dart';
import 'usage_window.dart';

/// What each agent account has spent, kept current for the usage page.
///
/// Polling, because neither vendor pushes, and neither figure moves fast enough
/// to be worth a socket. A minute is also the granularity the countdowns are
/// printed at, so a faster poll would redraw the same minute.
///
/// **The last good reading stays on screen through a failed refresh** — a page
/// that blanked whenever a network hiccup landed would be worse than one that
/// quietly went [stale].
///
/// ⚠️ **Deliberately different from the desktop's controller in ONE way: this
/// one reads no LOCAL sources.** The desktop constructs
/// `[ClaudeUsageSource(), CodexUsageSource()]` by default, because the machine
/// it runs on is also the machine `claude login` and `codex login` wrote their
/// tokens on — the macOS Keychain item `Claude Code-credentials`,
/// `~/.claude/.credentials.json`, `~/.codex/auth.json`. **A phone has none of
/// those**, and never will: no agent CLI ever signs in here, and the sandbox
/// has no `~` in the sense those paths mean. `UsageCredentials` would answer
/// null for every one of them — safely, since it only ever `existsSync`s a file
/// and skips the Keychain off macOS — but the readings it produced would all be
/// [UsageStatus.signedOut], which is the exact wrong sentence: it invites the
/// reader to sign in on a device where signing in is not a thing that exists,
/// and the empty state it drives would hide the real answer, that no machine
/// has been linked yet.
///
/// So on the phone the sources list is EMPTY and every figure comes from
/// `usage_read` over the relay — see [remote] and `AppNotifier.readRemoteUsage`.
/// The seam is kept rather than removed: the parameter still takes sources, so
/// the grouping, the statuses and this file's shape stay identical to the
/// desktop's, and a build that one day has a local account to read needs no new
/// controller.
class UsageController extends ChangeNotifier {
  UsageController({
    List<UsageSource> sources = const [],
    this.remote,
    this.interval = const Duration(seconds: 60),
    bool autoStart = true,
  }) : _sources = List.unmodifiable(sources) {
    for (final source in _sources) {
      _readings[source.provider] = ProviderUsage.loading(source.provider);
    }
    // Never on its own under test: a periodic timer stops `pumpAndSettle` ever
    // settling, and a cycle here opens real sockets over the relay. A test that
    // wants a cycle asks for one with [refresh], or starts the timer itself.
    if (autoStart && !kUnderTest) start();
  }

  /// This device's own accounts. Empty on the phone — see the class comment.
  final List<UsageSource> _sources;

  /// Asks every connected remote machine what ITS accounts have spent
  /// (`AppNotifier.readRemoteUsage`). Null asks nobody, which on the phone
  /// means there is nothing to read at all.
  final Future<List<MachineUsage>> Function()? remote;

  List<MachineUsage> _remote = const [];
  int _remoteRequest = 0;

  /// How often to ask again.
  final Duration interval;

  final Map<UsageProvider, ProviderUsage> _readings = {};

  Timer? _timer;
  bool _disposed = false;
  int _request = 0;

  /// A cycle has been asked for and none has landed yet.
  ///
  /// Both halves matter. It is false before [start], because a controller
  /// nobody has started is not *waiting* for anything — and a page that drew a
  /// skeleton for it would be promising an answer that was never coming. It is
  /// false again after the first cycle lands, so a later refresh keeps the
  /// figures already on screen rather than replacing them with skeletons once a
  /// minute.
  bool get loading => _started && !_landed;

  bool _started = false;
  bool _landed = false;

  /// The last cycle failed for every provider and what is on screen is older
  /// than it looks.
  ///
  /// With no local sources this can only be false — `every` over an empty list
  /// is true, so it is computed from the remote half here instead: a cycle in
  /// which every machine that was asked failed to answer is exactly the same
  /// claim the desktop makes about its two sources.
  bool stale = false;

  /// Every LOCAL provider's reading, in the order the sources were given. Empty
  /// on the phone, which is what makes [accounts] entirely remote.
  List<ProviderUsage> get readings => [
    for (final source in _sources) _readings[source.provider]!,
  ];

  /// The providers with figures worth printing.
  List<ProviderUsage> get answered => [
    for (final reading in readings)
      if (reading.hasFigures) reading,
  ];

  /// One figure per ACCOUNT, this device's first — see [groupUsageAccounts].
  ///
  /// [readings] stays this device's alone; this is the grouped view. On the
  /// phone every entry comes from a machine across the relay, so every entry
  /// carries the machine label that names it.
  List<UsageAccount> get accounts => groupUsageAccounts(readings, _remote);

  /// The machines that answered the last cycle, in the order they answered.
  /// Empty is a real answer here rather than a blank: it is what "no machine
  /// has anything to say" looks like once [hasAnswer] is true.
  List<MachineUsage> get machines => _remote;

  /// Whether the page has anything at all to say — figures, or a reason there
  /// are none. False only before the first cycle resolves.
  ///
  /// The remote half is what decides it here, since there are no local
  /// readings to move out of [UsageStatus.loading].
  bool get hasAnswer =>
      _landed || readings.any((r) => r.status != UsageStatus.loading);

  void start() {
    if (_disposed || _timer != null) return;
    _started = true;
    unawaited(refresh());
    _timer = Timer.periodic(interval, (_) => unawaited(refresh()));
  }

  /// This device's accounts and every remote machine's, asked at once — and
  /// landing apart. A remote machine is a relay round trip away and may never
  /// answer at all (see `AppNotifier.readRemoteUsage`), so it must not hold up
  /// figures this device already has. Each half notifies when it lands; the
  /// future completes when both have.
  Future<void> refresh() async {
    await Future.wait([_refreshLocal(), _refreshRemote()]);
  }

  Future<void> _refreshRemote() async {
    final ask = remote;
    if (ask == null) {
      // Nothing to ask, and nothing to wait for: the first cycle has still
      // RESOLVED, so the page shows its empty state rather than a skeleton
      // that would sit there for the life of the screen.
      if (_disposed) return;
      _started = true;
      _landed = true;
      notifyListeners();
      return;
    }
    final request = ++_remoteRequest;
    _started = true;
    final List<MachineUsage> answers;
    try {
      answers = await ask();
    } catch (_) {
      // Keep the last good answer, the same rule the local half follows — but
      // the cycle has still resolved, so a first refresh that threw shows the
      // empty state instead of loading forever. What is on screen, if anything,
      // is now older than it looks.
      if (_disposed || request != _remoteRequest) return;
      _landed = true;
      stale = _remote.isNotEmpty;
      notifyListeners();
      return;
    }
    // A slower, older answer must not overwrite a newer one.
    if (_disposed || request != _remoteRequest) return;
    // ⚠️ A cycle that came back EMPTY while figures are on screen does not
    // overwrite them — it marks them stale. `readRemoteUsage` drops a machine
    // that timed out rather than reporting it, so "no machine answered" and
    // "every machine answered with nothing" arrive identically, and blanking a
    // whole page on one bad relay round trip is the failure this rule exists to
    // prevent. An app with nothing linked lands here too, with `_remote` empty
    // both before and after, and is not stale — it has nothing, not something
    // old.
    if (answers.isEmpty && _remote.isNotEmpty) {
      _landed = true;
      stale = true;
      notifyListeners();
      return;
    }
    _remote = answers;
    _landed = true;
    stale = false;
    notifyListeners();
  }

  Future<void> _refreshLocal() async {
    if (_sources.isEmpty) return;
    _started = true;
    final request = ++_request;
    final results = await Future.wait(_sources.map((s) => s.read()));
    // A refresh that finished after a newer one started is thrown away: its
    // figures are the older truth, and writing them would make the page count
    // backwards.
    if (_disposed || request != _request) return;
    for (final result in results) {
      _readings[result.provider] = result;
    }
    _landed = true;
    stale = results.every((r) => r.status == UsageStatus.failed);
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
