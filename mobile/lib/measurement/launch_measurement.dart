import 'dart:async';

import 'package:flutter/widgets.dart';

import 'product_measurement.dart';

/// Why a launch's computers have not answered yet, each counted at most once per launch beside it as
/// `ui_phone_app_start_<wire>` (backend `PRODUCT_USAGE_PHONE_LAUNCH_MARKS`). On 2026-10-19 21 of 44
/// launches ended in no outcome at all, which could not say whether nothing was there to answer or the
/// app failed to reach what was. Seen while the launch still waits; nothing once a computer answered.
enum LaunchWait {
  /// The account's computer list, read from the backend, has none.
  noComputer('no_computer'),

  /// That list could not be read.
  listFailed('list_failed'),

  /// The backend reports every computer on the account offline.
  offline('offline'),

  /// A computer wants this phone's password (or a scanned code) before it opens.
  locked('locked'),

  /// A dial to a computer the backend reports online ended without its answer.
  connectFailed('connect_failed'),

  /// [LaunchMeasurement.waitedAfter] on screen with no computer answering.
  waited('waited_1m');

  const LaunchWait(this.wire);
  final String wire;
}

/// `app_start` on the phone: a launch that came back signed in, from `startHarness` to the first
/// computer answering — the wait a returning person sits through before there is anything to use.
///
/// The desktop counts its launch to a connected workspace the same way
/// (`desktop/lib/measurement/product_runtime_health.dart`). A launch that signs in first is not one:
/// that is the onboarding, which its own flows measure, and its wait for a computer can run hours.
///
/// Outcomes: `ok` when a computer answered; `unknown` when the app left the screen before one did
/// (whatever the wait took from there was not the launch's). A launch whose computers never answer
/// stays started, which is itself the signal; what it waited on is said beside it ([waiting]).
class LaunchMeasurement {
  /// How long a launch waits on screen before it is said to have waited ([LaunchWait.waited]).
  static const waitedAfter = Duration(minutes: 1);

  static final _launchClock = Stopwatch();

  /// Starts the launch clock. Called once, from `startHarness`, before anything is awaited.
  static void launched() {
    if (!_launchClock.isRunning) _launchClock.start();
  }

  LaunchMeasurement(
    this.measurement, {
    Duration Function()? sinceLaunch,
    bool observeLifecycle = true,
  }) : _sinceLaunch = sinceLaunch ?? (() => _launchClock.elapsed) {
    measurement.addListener(_choiceChanged);
    final left = waitedAfter - _sinceLaunch();
    _waitedTimer = Timer(
      left.isNegative ? Duration.zero : left,
      () => waiting(LaunchWait.waited),
    );
    if (observeLifecycle) {
      final state = WidgetsBinding.instance.lifecycleState;
      if (state != null && !_onScreen(state)) foreground(false);
      _lifecycle = AppLifecycleListener(
        onStateChange: (state) => foreground(_onScreen(state)),
      );
    }
  }

  final ProductMeasurement measurement;
  final Duration Function() _sinceLaunch;
  AppLifecycleListener? _lifecycle;
  bool _disposed = false;

  bool _signedIn = false, _accountSeen = false;

  /// Whether this launch is one `app_start` describes; decided by the first account it sees.
  bool _wanted = false;
  bool _begun = false;

  /// A launch starts on screen.
  bool _foreground = true;

  /// The launch left the screen before a computer answered.
  bool _left = false;
  Duration? _readyAt;
  void Function(ProductOutcome)? _open;
  Timer? _waitedTimer;

  /// What this launch waited on, not yet counted (sharing not read yet), and what has been.
  final _waits = <LaunchWait>{};
  final _counted = <LaunchWait>{};

  static bool _onScreen(AppLifecycleState state) =>
      state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;

  /// Signed in or not. [restored]: the launch came back signed in rather than signing in itself.
  void account({required bool signedIn, bool restored = false}) {
    if (signedIn && !_accountSeen) {
      _accountSeen = true;
      _wanted = restored;
    }
    if (_signedIn == signedIn) return;
    _signedIn = signedIn;
    if (!signedIn) {
      // A sign-out ends the launch's story; its queue goes with the account.
      _wanted = false;
      _open = null;
      _waits.clear();
    }
    _choiceChanged();
  }

  void _choiceChanged() {
    if (_disposed || !_signedIn || !measurement.sharing) return;
    if (!_wanted || _begun) return;
    _begun = true;
    // Sharing is confirmed only once the account's choice is read — often after a computer has
    // already answered: the launch is then counted with the time it really took.
    final readyAt = _readyAt;
    if (_left) {
      measurement.begin(ProductFlow.appStart, elapsed: _sinceLaunch())(
        ProductOutcome.unknown,
      );
    } else if (readyAt != null) {
      measurement.begin(ProductFlow.appStart, elapsed: readyAt)(
        ProductOutcome.ok,
      );
    } else {
      _open = measurement.begin(ProductFlow.appStart, elapsed: _sinceLaunch());
    }
    _countWaits();
  }

  /// The launch is waiting on [why]: counted once, beside the launch, as soon as it is counted itself.
  /// Nothing once a computer answered or the app left the screen, or for a launch `app_start` does not
  /// describe (one that signed in).
  void waiting(LaunchWait why) {
    if (_disposed || _readyAt != null || _left) return;
    if (_accountSeen && !_wanted) return;
    if (_counted.contains(why)) return;
    _waits.add(why);
    _countWaits();
  }

  void _countWaits() {
    if (!_begun || !_wanted || !measurement.sharing) return;
    for (final why in [..._waits]) {
      _waits.remove(why);
      if (_counted.add(why)) measurement.mark(ProductFlow.appStart, why.wire);
    }
  }

  /// A computer answered. Only the first in this process ends the launch.
  void ready() {
    if (_readyAt != null || _left) return;
    _readyAt = _sinceLaunch();
    _waitedTimer?.cancel();
    _open?.call(ProductOutcome.ok);
    _open = null;
  }

  /// The app came on screen ([value]) or left it.
  void foreground(bool value) {
    if (_foreground == value) return;
    _foreground = value;
    if (value || _readyAt != null || _left) return;
    _left = true;
    _waitedTimer?.cancel();
    _open?.call(ProductOutcome.unknown);
    _open = null;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _waitedTimer?.cancel();
    _lifecycle?.dispose();
    measurement.removeListener(_choiceChanged);
    _open = null;
  }
}
