import 'package:flutter/widgets.dart';

import 'product_measurement.dart';

/// `app_start` on the phone: a launch that came back signed in, from `startHarness` to the first
/// computer answering — the wait a returning person sits through before there is anything to use.
///
/// The desktop counts its launch to a connected workspace the same way
/// (`desktop/lib/measurement/product_runtime_health.dart`). A launch that signs in first is not one:
/// that is the onboarding, which its own flows measure, and its wait for a computer can run hours.
///
/// Outcomes: `ok` when a computer answered; `unknown` when the app left the screen before one did
/// (whatever the wait took from there was not the launch's). A launch whose computers never answer
/// stays started, which is itself the signal.
class LaunchMeasurement {
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
  }

  /// A computer answered. Only the first in this process ends the launch.
  void ready() {
    if (_readyAt != null || _left) return;
    _readyAt = _sinceLaunch();
    _open?.call(ProductOutcome.ok);
    _open = null;
  }

  /// The app came on screen ([value]) or left it.
  void foreground(bool value) {
    if (_foreground == value) return;
    _foreground = value;
    if (value || _readyAt != null || _left) return;
    _left = true;
    _open?.call(ProductOutcome.unknown);
    _open = null;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _lifecycle?.dispose();
    measurement.removeListener(_choiceChanged);
    _open = null;
  }
}
