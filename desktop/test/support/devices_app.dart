import 'dart:async';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_history.dart';
import 'package:harness/viewer/device_log.dart' show DevLogHead;

const fakeFingerprint = 'E2FB·0DF5·5FD8·E6C7';

/// An app whose account device list and removal are canned, so the Devices screens' own code runs
/// unmodified with no daemon.
class FakeDevicesApp extends AppNotifier {
  FakeDevicesApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  AccountDevices? devices;
  Completer<void>? loadGate;
  Object? loadError;
  String? removeError;
  final removed = <String>[];
  int loads = 0;
  final dismissCalls = <(String, bool)>[];

  /// What the History dialog reads; [historyMissing] is a daemon that predates it (null).
  DeviceLogHistory? history;
  bool historyMissing = false;
  int baselineSeenCalls = 0;

  @override
  Future<DeviceLogHistory?> loadDeviceHistory() async {
    if (historyMissing) return null;
    return history ?? (throw StateError('no history'));
  }

  /// What the list asked to be written back as seen, each time it was opened.
  final seenPending = <List<String>>[];

  /// The listing's departed keys each open handed over.
  final seenDeparted = <List<String>>[];

  /// The banner set each open handed over (null: none given).
  final seenShown = <List<String>?>[];

  /// Called by [loadDevices] with the banner's pubs as [bannerAtRead] has them (the real app reads
  /// them when the listing returns).
  List<String> Function()? bannerAtRead;

  // The real ones also write to the daemon, which a screen test has none of.
  @override
  void seenNewDevices({
    Iterable<String> pending = const [],
    Iterable<String>? shown,
    Iterable<String> departed = const [],
  }) {
    seenPending.add(pending.toList());
    seenShown.add(shown?.toList());
    seenDeparted.add(departed.toList());
    if (newDevices.isEmpty) return;
    final gone = shown?.toSet();
    newDevices.removeWhere((d) => gone == null || gone.contains(d.pub));
    notifyListeners();
  }

  /// The departed keys "Got it" was pressed for.
  final dismissedDeparted = <String>[];

  @override
  void dismissDepartedAll(Iterable<String> pubs) {
    final cleared = pubs.toSet();
    dismissedDeparted.addAll(cleared);
    departedDevices.removeWhere((d) => cleared.contains(d.pub));
    notifyListeners();
  }

  @override
  void dismissNewDevice(String pub, {bool liftSuspension = false}) {
    dismissCalls.add((pub, liftSuspension));
    newDevices.removeWhere((d) => d.pub == pub);
    notifyListeners();
  }

  /// What Trust again reads: each preview answer in turn, and what a confirm answers (the heads it
  /// was handed are recorded).
  final previews = <DevicesRebaseline>[];
  DevicesRebaseline? confirmAnswer;
  final confirmedHeads = <DevLogHead?>[];

  @override
  Future<DevicesRebaseline?> rebaselineDevices({
    required bool confirm,
    DevLogHead? head,
  }) async {
    if (!confirm) return previews.isEmpty ? null : previews.removeAt(0);
    confirmedHeads.add(head);
    return confirmAnswer;
  }

  @override
  Future<void> seeDeviceBaseline() async {
    baselineSeenCalls++;
  }

  @override
  Future<AccountDevices?> loadDevices({
    void Function(List<String> banner)? onListed,
  }) async {
    loads++;
    onListed?.call(bannerAtRead?.call() ?? [for (final d in newDevices) d.pub]);
    await loadGate?.future;
    if (loadError case final error?) throw error;
    return devices;
  }

  @override
  Future<String?> removeDevice(String pub) async {
    removed.add(pub);
    if (removeError == null) {
      newDevices.removeWhere((d) => d.pub == pub);
      devices = AccountDevices(
        devices: [
          for (final d in devices?.devices ?? const <AccountDevice>[])
            if (d.pub != pub) d,
        ],
      );
    }
    devicesRevision++;
    notifyListeners();
    return removeError;
  }
}

AccountDevice fakeDevice(
  String pub, {
  String label = 'iPad',
  String kind = 'viewer',
  bool self = false,
  DateTime? added,
  DateTime? seen,
  String fingerprint = fakeFingerprint,
  bool suspended = false,
  bool pending = false,
}) => AccountDevice(
  pub: pub,
  label: label,
  kind: kind,
  machineId: kind == 'machine' ? 'abcdef0123456789' : '',
  addedAt: added ?? DateTime(2026, 9, 1, 9, 30),
  fingerprint: fingerprint,
  self: self,
  lastSeen: seen,
  suspended: suspended,
  pending: pending,
);
