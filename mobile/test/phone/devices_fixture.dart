import 'dart:async';
import 'dart:typed_data';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart' as keys;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_history.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

/// A 32-byte key, distinct per [n], base64 — what a device log carries as `pub`.
String pubOf(int n) =>
    b64e(Uint8List.fromList(List.generate(32, (i) => (i * 7 + n) & 0xff)));

/// The key code the app shows for [pub].
String fpOf(String pub) => keys.fingerprint(b64d(pub));

DevLogMember member(
  String pub, {
  String label = 'Device',
  String kind = 'viewer',
  String machineId = '',
  required int addedAt,
  int seq = 1,
}) => DevLogMember(
  pub: pub,
  kind: kind,
  machineId: machineId,
  label: label,
  addedAt: addedAt,
  seq: seq,
);

DeviceLogRow row(
  DevLogMember m, {
  bool self = false,
  bool pending = false,
  bool suspended = false,
}) => DeviceLogRow(
  m,
  fingerprint: fpOf(m.pub),
  self: self,
  pending: pending,
  suspended: suspended,
);

DevLogHistoryRow historyRow(
  int seq,
  String op,
  String pub, {
  String label = 'Device',
  String? previousLabel,
  DevLogHistoryBy? by,
  bool thisDevice = false,
  bool pending = false,
  bool active = true,
  bool whileFrozen = false,
  int at = 0,
}) => DevLogHistoryRow(
  seq: seq,
  op: op,
  pub: pub,
  kind: 'viewer',
  machineId: '',
  label: label,
  previousLabel: previousLabel,
  fingerprint: fpOf(pub),
  by: by,
  at: at,
  thisDevice: thisDevice,
  afterJoin: true,
  pending: pending,
  active: active,
  whileFrozen: whileFrozen,
);

/// An app whose device list, last-seen times and removal are canned, so a page test is about what the
/// page does with them.
class DevicesApp extends AppNotifier {
  DevicesApp({this.rows = const [], this.seen = const {}})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  List<DeviceLogRow> rows;
  Map<String, int> seen;

  /// What the listing says about this phone's join: the devices already there ([joinedSeq]) and
  /// whether "Already on your account" was acknowledged.
  int joinedSeq = 0;
  bool baselineSeen = true;

  /// What the listing names as the "already on your account" set; empty = not named.
  List<String> baseline = const [];

  /// What the listing names as departed: new keys removed before anyone looked.
  List<DeviceLogDeparted> departed = const [];

  /// A frozen list (offers Review / Trust again) and the log that answers it.
  DeviceLogFreeze? frozen;
  ViewerDeviceLog? log;

  @override
  ViewerDeviceLog? get deviceLog => log;

  /// What [deviceHistory] answers; [historyError] makes it throw.
  DeviceLogHistory history = const DeviceLogHistory(rows: [], complete: true);
  bool historyError = false;
  int baselineSeenCalls = 0;

  /// What [removeDevice] answers: null is done, else why not.
  String? removeError;
  final removed = <String>[];

  /// When set, a removal waits on it — to see the page while the removal is in flight.
  Completer<void>? removeGate;

  /// The next this many [deviceListing] calls throw.
  int listingFailures = 0;

  @override
  Future<DeviceLogListing> deviceListing() async {
    if (listingFailures > 0) {
      listingFailures--;
      throw StateError('listing');
    }
    return _listing();
  }

  DeviceLogListing _listing() => DeviceLogListing(
    members: rows,
    frozen: frozen,
    frozenPeers: const [],
    pending: [
      for (final r in rows)
        if (r.pending) r.member.pub,
    ],
    joinedSeq: joinedSeq,
    baseline: baseline,
    baselineSeen: baselineSeen,
    departed: departed,
    registerError: registerError,
  );

  /// Why the backend last refused this phone a place in the log.
  String? registerError;

  /// When set, [deviceHistory] waits for it before answering (a read still in flight).
  Completer<void>? historyGate;

  @override
  Future<DeviceLogHistory> deviceHistory() async {
    if (historyGate case final gate?) await gate.future;
    if (historyError) throw StateError('history');
    return history;
  }

  /// What each [seenNewDevices] was handed as the list's own `pending`, and as the banner's set.
  final seenPending = <List<String>>[];
  final seenShown = <List<String>?>[];

  @override
  void seenNewDevices({
    Iterable<String> pending = const [],
    Iterable<String>? shown,
  }) {
    seenPending.add(pending.toList());
    seenShown.add(shown?.toList());
    super.seenNewDevices(pending: pending, shown: shown);
  }

  /// The pubs each [dismissNewDevice] was given, and whether it lifted a suspension.
  final dismissed = <({String pub, bool liftSuspension})>[];

  @override
  void dismissNewDevice(String pub, {bool liftSuspension = false}) {
    dismissed.add((pub: pub, liftSuspension: liftSuspension));
    super.dismissNewDevice(pub, liftSuspension: liftSuspension);
  }

  /// Tell the page the app changed (a test edited it directly).
  void poke() => notifyListeners();

  /// The pubs each [dismissDeparted] was given.
  final dismissedDeparted = <String>[];

  @override
  void dismissDeparted(String pub) {
    dismissedDeparted.add(pub);
    super.dismissDeparted(pub);
  }

  /// The banner entries the (canned) log holds as suspended.
  final suspendedNew = <String>{};

  @override
  bool newDeviceSuspended(String pub) => suspendedNew.contains(pub);

  /// Held: the page's last-seen read waits on it.
  Completer<void>? seenGate;

  @override
  Future<void> seeDeviceBaseline() async {
    baselineSeenCalls++;
    if (log is ScriptedDeviceLog) return super.seeDeviceBaseline();
    baselineSeen = true;
    devicesRevision++;
    notifyListeners();
  }

  @override
  Future<Map<String, int>> devicesLastSeen() async {
    await seenGate?.future;
    return seen;
  }

  @override
  Future<String?> removeDevice(String pub) async {
    removed.add(pub);
    await removeGate?.future;
    if (removeError == null) {
      rows = [
        for (final r in rows)
          if (r.member.pub != pub) r,
      ];
      newDevices.removeWhere((d) => d.pub == pub);
    }
    devicesRevision++;
    notifyListeners();
    return removeError;
  }
}

class _MemoryStore implements LocalKeyValueStore {
  final _values = <String, String>{};
  @override
  Future<String?> read(String key) async => _values[key];
  @override
  Future<void> write(String key, String value) async => _values[key] = value;
  @override
  Future<void> delete(String key) async => _values.remove(key);
}

/// A device log whose review (`rebaseline`) answers from a script, and which records what it was asked.
class ScriptedDeviceLog extends ViewerDeviceLog {
  ScriptedDeviceLog()
    : super(
        keys: ViewerKeyStore(storage: _MemoryStore()),
        fetch: (_) async => null,
        append: (_) async => null,
        label: () => 'phone',
      );

  /// Answers to successive `rebaseline` calls (null: unreadable on a preview, "list changed" on a confirm).
  final answers = <DeviceLogRebaseline?>[];
  final calls = <({bool confirm, DevLogHead? expectedHead})>[];
  bool seeBaselineThrows = false;

  @override
  Future<DeviceLogRebaseline?> rebaseline({
    required bool confirm,
    DevLogHead? expectedHead,
  }) async {
    calls.add((confirm: confirm, expectedHead: expectedHead));
    return answers.isEmpty ? null : answers.removeAt(0);
  }

  @override
  Future<void> seeBaseline() async {
    if (seeBaselineThrows) throw StateError('disk');
  }
}

DeviceLogDeparted departedKey(
  String pub, {
  String label = 'iPad',
  String removedBy = '',
  String removedByLabel = '',
  bool selfRemoved = false,
}) => DeviceLogDeparted(
  pub: pub,
  label: label,
  kind: 'viewer',
  machineId: '',
  fingerprint: fpOf(pub),
  addedAt: 1000,
  removedAt: 2000,
  removedBy: removedBy,
  removedByLabel: removedByLabel,
  selfRemoved: selfRemoved,
);
