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
  Map<String, Object?> Function(Map<String, dynamic> request) reply, {
  Future<void> Function()? beforeReply,
}) async {
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
        final answer = reply(request);
        await beforeReply?.call();
        socket.emit({
          'type': 'group_sync_result',
          'payload': wrapPayload(
            keys!.s2c,
            'p',
            counter++,
            'group_sync_result',
            null,
            {'requestId': request['requestId'], ...answer},
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

  test('a member taken in while a swap is on the network survives the swap\'s write', () async {
    final keys = ViewerKeyStore(storage: _Memory());
    final machine = await E2eeIdentity.generate();
    final browserPub = b64e((await E2eeIdentity.generate()).pub);
    await keys.pin(_machineId, machine.pub);
    // The approval lands while the machine is still answering this swap.
    final socket = await _machine(
      machine,
      (_) => {'members': [], 'removed': []},
      beforeReply: () => admitGroupMember(
        keys,
        GroupMember(pub: browserPub, kind: 'viewer', label: 'Chrome on macOS', at: 99),
      ),
    );
    await syncTrustGroup(
      machineId: _machineId,
      keys: keys,
      accessToken: 't',
      wsBaseUrl: 'wss://relay.test',
      autonomousEnv: 'prod',
      label: 'Studio PC',
      socket: socket.factory,
    );
    final stored = GroupRoster.parse(await keys.groupRoster());
    expect(stored.members.map((m) => m.pub), contains(browserPub));
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

  group('a browser signing in by phone', () {
    test(
      'the phone hands it its group, sealed so only the QR\'s code opens it',
      () async {
        final phone = ViewerKeyStore(storage: _Memory());
        final browser = ViewerKeyStore(storage: _Memory());
        final machinePub = Uint8List.fromList(List.generate(32, (i) => i + 7));
        await phone.pin('a' * 32, machinePub, label: 'studio');

        final roster = await handoffRoster(phone, selfLabel: 'iPhone');
        final sealed = sealHandedRoster(
          roster,
          code: 'ABCDEFGHJKMNPQRS',
          userCode: 'U1',
        );
        // Another code, or the same code for another request, opens nothing.
        expect(
          openHandedRoster(sealed, code: 'ABCDEFGHJKMNPQRT', userCode: 'U1'),
          isNull,
        );
        expect(
          openHandedRoster(sealed, code: 'ABCDEFGHJKMNPQRS', userCode: 'U2'),
          isNull,
        );
        final tampered = b64d(sealed)..[3] ^= 1;
        expect(
          openHandedRoster(
            b64e(tampered),
            code: 'ABCDEFGHJKMNPQRS',
            userCode: 'U1',
          ),
          isNull,
        );

        final raw = openHandedRoster(
          sealed,
          code: 'abcdefghjkmnpqrs',
          userCode: 'U1',
        );
        final outcome = await adoptHandedRoster(browser, raw);
        expect(outcome.pinned, ['a' * 32]);
        expect((await browser.peer('a' * 32))!.pub, machinePub);
        // The phone is in the browser's roster too: the two trust each other from the start.
        final stored = GroupRoster.parse(await browser.groupRoster());
        expect(
          stored.members.map((m) => m.pub),
          contains(b64e((await phone.identity()).pub)),
        );
      },
    );

    test(
      'the phone takes the browser into its own roster, for its next sync',
      () async {
        final phone = ViewerKeyStore(storage: _Memory());
        final browserPub = b64e((await E2eeIdentity.generate()).pub);
        await admitGroupMember(
          phone,
          GroupMember(
            pub: browserPub,
            kind: 'viewer',
            label: 'Chrome on macOS',
            at: 5,
          ),
        );
        final stored = GroupRoster.parse(await phone.groupRoster());
        expect(stored.members.map((m) => m.pub), [browserPub]);
      },
    );
  });

  test('a handed roster seals to the bytes the CLI opens', () {
    // The same vector as cli/src/lib/e2ee/handedRoster.spec.ts: the CLI opens what the phones seal.
    const vector =
        'MCsWzwhdskkULflZqvr/unR+ynpfBWQdAE3GXwh+/8m83dSl5Ec/JCojguagCCL91gghdXqGphL7tgaRHbJO11qaAJAvrguTW6XwhFjtK3V785T2LWibIeRWCjBsrJ+FCPGtbK+6qTS0dmFWPNyB41Jm7Qc1ICGuXKVLNort+YXR3uMh+sx16TlHddBqkbn1rkZE7O+MiYfFSiwjAw2+hTwIiBmSzZAi7wEn99u/22/yMpp83cH6a8tZzVZvyKBSZ0hIVfE=';
    final roster = GroupRoster([
      GroupMember(
        pub: '${'A' * 43}=',
        kind: 'machine',
        label: 'studio',
        at: 1700000000000,
        machineId: 'a' * 32,
      ),
    ], const []);
    expect(
      sealHandedRoster(
        roster,
        code: 'ABCDEFGHJKMNPQRS',
        userCode: 'VECTORUSERCODE',
      ),
      vector,
    );
  });
}
