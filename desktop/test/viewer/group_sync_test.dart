import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/e2ee/primitives.dart';
import 'package:harness/viewer/group_sync.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// The viewer build's trust-group swap (`lib/viewer/group_sync.dart`) — the same code the phone
/// runs, against a machine end that answers exactly as manager.ts does.

const _machineId = 'machine-1';
final _c = 'c' * 32;

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A relay socket whose far end is the test.
class _Socket implements WebSocketChannel {
  _Socket(this.onFrame);
  final void Function(_Socket socket, Map<String, dynamic> frame) onFrame;
  final sent = <Map<String, dynamic>>[];
  final _down = StreamController<dynamic>();
  late final _sink = _Sink(this);
  @override
  Future<void> get ready => Future.value();
  @override
  Stream<dynamic> get stream => _down.stream;
  @override
  WebSocketSink get sink => _sink;
  void emit(Map<String, dynamic> frame) => _down.add(jsonEncode(frame));
  WebSocketChannel factory(Uri _, Iterable<String> _) => this;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Sink implements WebSocketSink {
  _Sink(this._s);
  final _Socket _s;
  bool closed = false;
  @override
  void add(dynamic data) {
    final frame = jsonDecode(data as String) as Map<String, dynamic>;
    _s.sent.add(frame);
    _s.onFrame(_s, frame);
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) async =>
      closed = true;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// manager.ts `onHello` + `wrapRpcReply`, for one session.
Future<_Socket> _machine(
  E2eeIdentity identity,
  Map<String, Object?> Function(Map<String, dynamic> request) reply,
) async {
  SessionKeys? keys;
  var counter = 1;
  return _Socket((socket, frame) async {
    final payload = frame['payload'] as Map<String, dynamic>;
    switch (frame['type']) {
      case 'machine_select':
        socket.emit({
          'type': 'connected',
          'payload': {'machineId': _machineId},
        });
      case 'e2e_hello':
        final webEph = b64d(payload['ephPub'] as String);
        final eph = await Ephemeral.generate();
        final k = keys = sessionKeys(eph, webEph, _machineId, webEph, eph.pub);
        final sig = await identity.sign(
          lvCat(['e2e-welcome-v1', _machineId, webEph, eph.pub]),
        );
        final enc = aeadSeal(
          k.s2c,
          0,
          utf8Bytes('e2e-welcome'),
          utf8Bytes(
            jsonEncode({
              'groupKey': b64e(Uint8List(32)),
              'epoch': 'e1',
              'features': {'strictDown': 1},
            }),
          ),
        );
        socket.emit({
          'type': 'e2e_welcome',
          'payload': {
            'webEphPub': b64e(webEph),
            'ephPub': b64e(eph.pub),
            'sig': b64e(sig),
            'enc': b64e(enc),
          },
        });
      case 'group_sync':
        expect(
          isWrapped(payload),
          isTrue,
          reason: 'the roster must never cross the relay in the clear',
        );
        final request = unwrapPayload(
          keys!.c2s,
          payload['__e2e'] as Map<String, dynamic>,
          'group_sync',
          null,
        )!;
        socket.emit({
          'type': 'group_sync_result',
          'payload': wrapPayload(
            keys!.s2c,
            'p',
            counter++,
            'group_sync_result',
            null,
            {'requestId': request['requestId'], ...reply(request)},
          ),
        });
    }
  });
}

void main() {
  test(
    'the viewer build swaps rosters sealed, and pins every machine it learns',
    () async {
      final keys = ViewerKeyStore(storage: _Memory());
      final machine = await E2eeIdentity.generate();
      final cPub = b64e((await E2eeIdentity.generate()).pub);
      await keys.pin(_machineId, machine.pub);
      Map<String, dynamic>? seen;
      final socket = await _machine(machine, (request) {
        seen = request;
        return {
          'members': [
            {
              'pub': cPub,
              'kind': 'machine',
              'machineId': _c,
              'label': 'c',
              'at': 50,
            },
          ],
          'removed': [],
        };
      });
      final outcome = await syncTrustGroup(
        machineId: _machineId,
        keys: keys,
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        label: 'Studio PC',
        socket: socket.factory,
      );
      expect(seen!['self'], containsPair('kind', 'viewer'));
      expect(outcome.pinned, [_c]);
      expect(b64e((await keys.peer(_c))!.pub), cPub);
    },
  );

  test(
    'a suspended key is neither pinned nor seeded into the roster',
    () async {
      final keys = ViewerKeyStore(storage: _Memory());
      final machine = await E2eeIdentity.generate();
      final cPub = b64e((await E2eeIdentity.generate()).pub);
      final dId = 'd' * 32;
      final dPub = b64e((await E2eeIdentity.generate()).pub);
      await keys.pin(_machineId, machine.pub);
      await keys.pin(dId, b64d(dPub)); // a pin the roster does not name yet
      Map<String, dynamic>? seen;
      final socket = await _machine(machine, (request) {
        seen = request;
        return {
          'members': [
            {
              'pub': cPub,
              'kind': 'machine',
              'machineId': _c,
              'label': 'c',
              'at': 50,
            },
          ],
          'removed': [],
        };
      });
      final outcome = await syncTrustGroup(
        machineId: _machineId,
        keys: keys,
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        label: 'Studio PC',
        socket: socket.factory,
        suspended: () async => {cPub, dPub},
      );
      expect(outcome.pinned, isEmpty);
      expect(await keys.peer(_c), isNull);
      expect([
        for (final m in seen!['members'] as List) (m as Map)['pub'],
      ], isNot(contains(dPub)));
    },
  );

  test('a key suspended by the devlog this very exchange carries is not pinned either', () async {
    final keys = ViewerKeyStore(storage: _Memory());
    final machine = await E2eeIdentity.generate();
    final cPub = b64e((await E2eeIdentity.generate()).pub);
    await keys.pin(_machineId, machine.pub);
    final socket = await _machine(machine, (request) {
      return {
        'members': [
          {
            'pub': cPub,
            'kind': 'machine',
            'machineId': _c,
            'label': 'c',
            'at': 50,
          },
        ],
        'removed': [],
        'devlog': {
          'head': {'seq': 1, 'hash': 'x'},
        },
      };
    });
    final suspendedNow = <String>{};
    final outcome = await syncTrustGroup(
      machineId: _machineId,
      keys: keys,
      accessToken: 't',
      wsBaseUrl: 'wss://relay.test',
      autonomousEnv: 'prod',
      label: 'Studio PC',
      socket: socket.factory,
      onDevlog: (_, _) async => suspendedNow.add(cPub),
      suspended: () async => {...suspendedNow},
    );
    expect(outcome.pinned, isEmpty);
    expect(await keys.peer(_c), isNull);
  });

  test('the merge matches the CLI: tombstones beat older entries, newer links beat tombstones', () async {
    final self = b64e((await E2eeIdentity.generate()).pub);
    final pub = b64e((await E2eeIdentity.generate()).pub);
    final b = GroupMember(
      pub: pub,
      kind: 'machine',
      label: 'b',
      at: 10,
      machineId: 'b' * 32,
    );
    final removed = mergeGroupRoster(
      GroupRoster([b], const []),
      GroupRoster(const [], [GroupTombstone(pub, 10)]),
      self,
    );
    expect(removed.roster.members, isEmpty);
    final back = mergeGroupRoster(
      removed.roster,
      GroupRoster([
        GroupMember(
          pub: pub,
          kind: 'machine',
          label: 'b',
          at: 11,
          machineId: 'b' * 32,
        ),
      ], const []),
      self,
    );
    expect(back.roster.members.single.at, 11);
  });
}
