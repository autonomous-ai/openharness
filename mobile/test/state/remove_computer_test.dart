import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import '../viewer_app_fixture.dart';
import '../voice_fakes.dart' show MemoryKeyValueStore;

/// Settings ▸ Computers ▸ Remove takes the computer off the account the way desktop does
/// (`MachineDevices.removeComputer`): its key out of the account's device log first — out of Your
/// devices, trusted by no device any more — and only then its machine record. Against a real
/// [ViewerDeviceLog] and an honest backend.

const _acct = 'acct-1';
final _mid = 'b' * 32;

/// The account's device log and machine records, as the backend keeps them.
class _Backend {
  final entries = <DevLogEntry>[];
  DevLogState state = DevLogState.empty(_acct);

  /// What reached the backend from the phone, in order: each removal appended to the log, and each
  /// machine record it was asked to delete.
  final events = <String>[];

  /// No log to read at all: a backend from before the log, or one that cannot be reached.
  bool unreadable = false;

  /// Every append is refused with this code while set.
  String? refuseWith;

  /// Every append goes unanswered while set (the network dropped it).
  bool appendsLost = false;

  /// Held: an append of a removal waits on it.
  Completer<void>? removeGate;

  Future<void> add(
    E2eeIdentity who,
    String kind,
    String machineId,
    String label,
  ) async {
    final pub = b64e(who.pub);
    await _push(
      await signDevLogEntry(
        nextDevLogEntry(
          state,
          op: 'add',
          pub: pub,
          kind: kind,
          machineId: machineId,
          label: label,
          signer: pub,
          at: 1000,
        ),
        who,
      ),
    );
  }

  Future<void> removeBy(String target, E2eeIdentity by) async {
    final t = state.active[target]!;
    await _push(
      await signDevLogEntry(
        nextDevLogEntry(
          state,
          op: 'remove',
          pub: t.pub,
          kind: t.kind,
          machineId: t.machineId,
          label: t.label,
          signer: b64e(by.pub),
          at: 2000,
        ),
        by,
      ),
    );
  }

  Future<void> _push(DevLogEntry e) async {
    state = (await applyDevLogEntries(state, [e.toJson()])).state;
    entries.add(e);
  }

  Future<DeviceLogFetched?> fetch(int since) async => unreadable
      ? null
      : (
          acct: _acct,
          head: state.head,
          entries: [
            for (final e in entries)
              if (e.seq > since) e.toJson(),
          ],
        );

  Future<DeviceLogAppendAnswer?> append(DevLogEntry entry) async {
    if (entry.op == 'remove') await removeGate?.future;
    if (appendsLost) return null;
    if (refuseWith case final code?) return (head: null, error: code);
    if (entry.seq != state.head.seq + 1 || entry.prev != state.head.hash) {
      return (head: state.head, error: 'STALE_HEAD');
    }
    await _push(entry);
    if (entry.op == 'remove') events.add('remove ${entry.pub}');
    return (head: state.head, error: null);
  }
}

class _Api extends FakeApi {
  _Api(this.backend);

  final _Backend backend;

  @override
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) =>
      backend.fetch(since);

  @override
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) =>
      backend.append(entry);

  @override
  Future<void> deleteMachine({required String machineId}) {
    // Asked, whatever it answers: a record the phone must not touch is one it never asks about.
    backend.events.add('delete $machineId');
    return super.deleteMachine(machineId: machineId);
  }
}

void main() {
  late _Backend backend;
  late _Api api;
  late E2eeIdentity box, ipad;
  late String boxPub;

  setUp(() async {
    backend = _Backend();
    box = await E2eeIdentity.fromSeed(List.filled(32, 2));
    ipad = await E2eeIdentity.fromSeed(List.filled(32, 3));
    boxPub = b64e(box.pub);
  });

  /// The phone opening, signed in, on an account with one computer ("Studio", [_mid]); it registers
  /// with the device log on its own. Nothing that reached the backend while it did is in
  /// [_Backend.events].
  Future<AppNotifier> launch() async {
    final session = AuthSession(storage: MemoryKeyValueStore());
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      cliLogin: FakeSignIn(),
      peerLinks: FakeLinks(),
      viewer: FakeViewer(session),
      systemNotices: SilentSystemNotices(),
      connectionForTest: (_) => ScriptedConn(),
    );
    addTearDown(app.dispose);
    api = _Api(backend)
      ..onMachines = () async => [remoteMachine(_mid, name: 'Studio')];
    app.api = api;
    await app.bootstrap();
    await settle();
    expect(app.status, AppStatus.authenticated);
    expect(app.stateOf(_mid), isNotNull);
    backend.events.clear();
    return app;
  }

  Future<List<String>> listed(AppNotifier app) async => [
    for (final r in (await app.deviceListing()).members) r.member.pub,
  ];

  test(
    'signs its key out of Your devices first, then deletes the record',
    () async {
      await backend.add(box, 'machine', _mid, 'Studio');
      final app = await launch();
      final phonePub = b64e((await app.viewer.keys.identity()).pub);
      expect(backend.state.active.containsKey(phonePub), isTrue);
      expect(await listed(app), contains(boxPub));
      final revision = app.devicesRevision;

      expect(await app.deleteMachine(_mid), isNull);

      expect(backend.events, ['remove $boxPub', 'delete $_mid']);
      expect(
        backend.state.active.containsKey(boxPub),
        isFalse,
        reason: 'the account\'s other devices stop trusting it',
      );
      expect(await listed(app), isNot(contains(boxPub)));
      expect(await app.viewer.keys.peer(_mid), isNull);
      expect(app.devicesRevision, greaterThan(revision));
      expect(app.stateOf(_mid), isNull);
      expect(app.machines, isEmpty);
      expect(app.machineRemoving(_mid), isFalse);
    },
  );

  test('a computer that joined since the log was last read is still signed out', () async {
    final app = await launch();
    // Joined after the phone last read the log: only a read now finds its key.
    await backend.add(box, 'machine', _mid, 'Studio');
    expect(await listed(app), isNot(contains(boxPub)));

    expect(await app.deleteMachine(_mid), isNull);
    await settle();

    expect(backend.events, ['remove $boxPub', 'delete $_mid']);
    expect(backend.state.active.containsKey(boxPub), isFalse);
    expect(
      app.newDevices.map((d) => d.pub),
      isNot(contains(boxPub)),
      reason: 'a device just removed is no new device',
    );
  });

  test('a sign-out that fails stops before the record, and says why', () async {
    await backend.add(box, 'machine', _mid, 'Studio');
    final app = await launch();

    backend.refuseWith = 'FORBIDDEN';
    expect(
      await app.deleteMachine(_mid),
      'Couldn’t sign Studio out (FORBIDDEN). Try again.',
    );
    backend
      ..refuseWith = null
      ..appendsLost = true;
    expect(
      await app.deleteMachine(_mid),
      'Couldn’t sign Studio out (UNAVAILABLE). Try again.',
    );

    expect(backend.events, isEmpty, reason: 'no record is deleted');
    expect(api.deleted, isEmpty);
    expect(backend.state.active.containsKey(boxPub), isTrue);
    expect(app.stateOf(_mid), isNotNull);
    expect(app.machineRemoving(_mid), isFalse);

    // Once the backend takes it, the next press does the whole of it.
    backend.appendsLost = false;
    expect(await app.deleteMachine(_mid), isNull);
    expect(backend.events, ['remove $boxPub', 'delete $_mid']);
    expect(app.stateOf(_mid), isNull);
  });

  test('a record that fails after the sign-out says it is signed out, and the next press deletes only the record', () async {
    await backend.add(box, 'machine', _mid, 'Studio');
    final app = await launch();

    api.deleteFailure = ApiException('Request failed (500)', status: 500);
    expect(
      await app.deleteMachine(_mid),
      'Studio is signed out, but its machine record could not be deleted: Request failed (500)',
    );
    expect(backend.events, ['remove $boxPub', 'delete $_mid']);
    expect(backend.state.active.containsKey(boxPub), isFalse);
    expect(app.stateOf(_mid), isNotNull, reason: 'its record is still there');

    api.deleteFailure = null;
    backend.events.clear();
    expect(await app.deleteMachine(_mid), isNull);
    expect(backend.events, ['delete $_mid']);
    expect(api.deleted, [_mid]);
    expect(app.stateOf(_mid), isNull);
  });

  test('a computer with no key in the log loses its record alone', () async {
    final app = await launch();
    final logLength = backend.entries.length;

    expect(await app.deleteMachine(_mid), isNull);

    expect(backend.events, ['delete $_mid']);
    expect(backend.entries, hasLength(logLength));
    expect(app.stateOf(_mid), isNull);
  });

  test(
    'a computer already signed out from another device loses its record alone',
    () async {
      await backend.add(ipad, 'viewer', '', 'iPad');
      await backend.add(box, 'machine', _mid, 'Studio');
      final app = await launch();
      expect(await listed(app), contains(boxPub));
      // Signed out on the iPad; this phone has not read the log since.
      await backend.removeBy(boxPub, ipad);

      expect(await app.deleteMachine(_mid), isNull);

      expect(backend.events, ['delete $_mid']);
      expect(app.stateOf(_mid), isNull);
    },
  );

  test(
    'with no log to read, the record still goes, as it did before the log',
    () async {
      backend.unreadable = true;
      final app = await launch();

      expect(await app.deleteMachine(_mid), isNull);

      expect(backend.events, ['delete $_mid']);
      expect(app.stateOf(_mid), isNull);
    },
  );

  test('a second press joins the first: one sign-out, one delete', () async {
    await backend.add(box, 'machine', _mid, 'Studio');
    final app = await launch();
    final gate = backend.removeGate = Completer<void>();

    final first = app.deleteMachine(_mid);
    final second = app.deleteMachine(_mid);
    await settle();
    expect(second, same(first));
    expect(app.machineRemoving(_mid), isTrue);

    gate.complete();
    expect(await first, isNull);
    expect(await second, isNull);
    expect(backend.events, ['remove $boxPub', 'delete $_mid']);
    expect(app.machineRemoving(_mid), isFalse);
  });
}
