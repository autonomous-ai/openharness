import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'device_app.dart';

enum DeviceAppOfferState { hidden, offer, installing, failed, notRunning }

/// The menu-bar app's offer, one for the band and the Devices row, so an install started from one shows on both.
class DeviceAppOffer extends ChangeNotifier {
  DeviceAppOffer({
    required this._supported,
    required this._probe,
    required this._install,
    required this._open,
    this._store,
    this._log,
  }) {
    _restored = _restore();
  }

  static const dismissedKey = 'device_app.offer_dismissed';

  final bool _supported;
  final DeviceAppProbe _probe;
  final Future<DeviceAppInstallResult> Function() _install;
  final DeviceAppOpen _open;
  final LocalKeyValueStore? _store;
  final void Function(String line)? _log;

  late final Future<void> _restored;
  bool _restoredDone = false;
  bool _dismissed = false;
  bool _attached = false;
  bool _disposed = false;
  DeviceAppPresence? _presence;
  DeviceAppInstallStep? _failedStep;

  /// The failure came from an install, its open step and that open's Retry included; the band shows only these, a
  /// refused Open from the row of an installed app stays on the row.
  bool _installFailed = false;
  Future<void>? _installing;
  Future<void>? _lookup;
  int _installsEnded = 0;

  /// The bundle an install of this run put in place; [open] opens it rather than whichever copy LaunchServices picks.
  String? _installedAt;

  /// LaunchServices registers a freshly renamed bundle late, so after an install put one in place "not installed" is
  /// not believed until a lookup says installed.
  bool _awaitingRegistration = false;

  DeviceAppOfferState get state {
    if (!_supported || !_attached) return DeviceAppOfferState.hidden;
    if (_installing != null) return DeviceAppOfferState.installing;
    if (_failedStep != null) return DeviceAppOfferState.failed;
    final presence = _presence;
    if (presence == null) return DeviceAppOfferState.hidden;
    if (!presence.installed) return DeviceAppOfferState.offer;
    if (!presence.running) return DeviceAppOfferState.notRunning;
    return DeviceAppOfferState.hidden;
  }

  /// Set while [state] is failed.
  DeviceAppInstallStep? get failedStep =>
      state == DeviceAppOfferState.failed ? _failedStep : null;

  bool get bandVisible {
    if (!_restoredDone || _dismissed) return false;
    final state = this.state;
    return state == DeviceAppOfferState.offer ||
        state == DeviceAppOfferState.installing ||
        (state == DeviceAppOfferState.failed && _installFailed);
  }

  /// Completes once the stored answer was read.
  Future<void> get restored => _restored;

  void dialChanged(bool attached) {
    if (attached == _attached) return;
    _attached = attached;
    _notify();
    if (attached) unawaited(_look());
  }

  void windowFronted() => unawaited(_look());

  Future<void> refresh() => _look();

  /// Joins a running install.
  Future<void> install() {
    final running = _installing;
    if (running != null) return running;
    _log?.call('device app: install started');
    final run = _installing = _runInstall();
    _notify();
    return run;
  }

  /// The bundle this run installed, else by bundle id.
  Future<void> open() async {
    bool opened;
    try {
      opened = await _open(path: _installedAt);
    } catch (_) {
      // The real opener throws when `open` cannot start or runs out of time: the same refusal to the person.
      opened = false;
    }
    if (opened) {
      _presence = const DeviceAppPresence(installed: true, running: true);
      _failedStep = null;
      _installFailed = false;
    } else {
      _failedStep = DeviceAppInstallStep.open;
      _log?.call('device app: open failed');
    }
    _notify();
  }

  /// Not now: the band goes at once, and stays gone on this computer once the answer is stored.
  Future<void> dismiss() async {
    _dismissed = true;
    _notify();
    try {
      await _store?.write(dismissedKey, 'true');
    } catch (_) {
      // Hidden for this run all the same; the next run offers it again.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  Future<void> _restore() async {
    try {
      if ((await _store?.read(dismissedKey)) == 'true') _dismissed = true;
    } catch (_) {
      // A state file that cannot be read is a first run: the band shows.
    }
    _restoredDone = true;
    _notify();
  }

  Future<void> _runInstall() async {
    DeviceAppInstallResult result;
    try {
      result = await _install();
    } catch (_) {
      result = const DeviceAppInstallResult.failed(
        DeviceAppInstallStep.install,
      );
    }
    _installing = null;
    _installsEnded++;
    final installedAt = result.installedAt;
    if (installedAt != null) {
      _installedAt = installedAt;
      _awaitingRegistration = true;
    }
    final failed = result.failed;
    if (failed == null) {
      // Trusted at once: the installer put it in place and opened it.
      _presence = const DeviceAppPresence(installed: true, running: true);
      _failedStep = null;
      _installFailed = false;
      _log?.call('device app: install done');
    } else {
      if (failed == DeviceAppInstallStep.open) {
        _presence = const DeviceAppPresence(installed: true, running: false);
      }
      _failedStep = failed;
      _installFailed = true;
      _log?.call('device app: install failed ${failed.name}');
    }
    _notify();
    if (failed == null) unawaited(_look());
  }

  Future<void> _look() {
    if (!_supported || !_attached || _disposed) return Future.value();
    return _lookup ??= _lookUp().whenComplete(() => _lookup = null);
  }

  Future<void> _lookUp() async {
    final asked = _installsEnded;
    final DeviceAppPresence answer;
    try {
      answer = await _probe.lookup();
    } catch (_) {
      _log?.call('device app: lookup failed');
      return;
    }
    // An answer asked before an install ended describes the computer before it; the install's result stands.
    if (_disposed || asked != _installsEnded) return;
    if (answer.installed) {
      _awaitingRegistration = false;
      _failedStep = null;
      _installFailed = false;
    } else if (_awaitingRegistration) {
      return;
    }
    _presence = answer;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }
}
