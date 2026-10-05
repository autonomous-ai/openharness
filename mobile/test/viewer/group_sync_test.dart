import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/viewer/group_sync.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

import '../e2ee/machine_session.dart' as ms;
import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'fake_relay_socket.dart';

final _b = 'b' * 32;
final _c = 'c' * 32;

Future<String> _pub() async => b64e((await E2eeIdentity.generate()).pub);

GroupMember _machine(String pub, String id, int at) => GroupMember(
  pub: pub,
  kind: 'machine',
  label: id.substring(0, 1),
  at: at,
  machineId: id,
);

/// A machine answering one roster swap: it acks the select, answers the hello with a real
/// welcome, opens the sealed `group_sync` and replies with [reply] sealed back.
FakeRelaySocket _machineSocket(
  E2eeIdentity machine,
  Map<String, Object?> Function(Map<String, dynamic> request) reply, {
  void Function(Map<String, dynamic> request)? onRequest,
}) {
  late FakeRelaySocket socket;
  ms.MachineSession? session;
  socket = FakeRelaySocket(
    onFrame: (frame) async {
      switch (frame['type']) {
        case 'machine_select':
          socket.emit('connected', {'machineId': ms.machineId});
        case 'e2e_hello':
          session = await ms.MachineSession.answer(frame, identity: machine);
          socket.emit('e2e_welcome', await session!.welcome());
        case 'group_sync':
          final request = session!.openDown(frame)!;
          onRequest?.call(request);
          final sealed = session!.target('group_sync_result', {
            'requestId': request['requestId'],
            ...reply(request),
          });
          socket.emitRaw(jsonEncode(sealed));
      }
    },
  );
  return socket;
}

void main() {
  group('mergeGroupRoster', () {
    test(
      'takes new members, the newest entry per key, and never itself',
      () async {
        final self = await _pub();
        final b = _machine(await _pub(), _b, 10);
        final renamed = GroupMember(
          pub: b.pub,
          kind: 'machine',
          label: 'B2',
          at: 20,
          machineId: _b,
        );
        final r1 = mergeGroupRoster(
          GroupRoster.empty,
          GroupRoster([
            b,
            GroupMember(pub: self, kind: 'viewer', label: 'me', at: 5),
          ], const []),
          self,
        );
        expect(r1.roster.members.map((m) => m.pub), [b.pub]);
        expect(r1.upserted.single.pub, b.pub);
        final r2 = mergeGroupRoster(
          r1.roster,
          GroupRoster([renamed], const []),
          self,
        );
        expect(r2.roster.members.single.label, 'B2');
        final r3 = mergeGroupRoster(
          r2.roster,
          GroupRoster([b], const []),
          self,
        );
        expect(r3.upserted, isEmpty);
      },
    );

    test('a tombstone beats what it is not older than; a newer link beats the tombstone', () async {
      final self = await _pub();
      final b = _machine(await _pub(), _b, 10);
      final removed = mergeGroupRoster(
        GroupRoster([b], const []),
        GroupRoster(const [], [GroupTombstone(b.pub, 10)]),
        self,
      );
      expect(removed.roster.members, isEmpty);
      expect(removed.dropped.single.pub, b.pub);
      final relinked = mergeGroupRoster(
        removed.roster,
        GroupRoster([_machine(b.pub, _b, 11)], const []),
        self,
      );
      expect(relinked.roster.members.single.at, 11);
    });

    test('parse drops malformed entries: a machine needs its id', () async {
      final good = _machine(await _pub(), _b, 1).toJson();
      final roster = GroupRoster.parse({
        'members': [
          good,
          {...good, 'machineId': 'nope'},
          {...good, 'pub': 'x'},
          {...good, 'kind': 'server'},
        ],
        'removed': [
          {'pub': good['pub'], 'at': 1},
          {'pub': 'x', 'at': 1},
        ],
      });
      expect(roster.members, hasLength(1));
      expect(roster.removed, hasLength(1));
    });
  });

  group('syncTrustGroup', () {
    test('sends this phone and every machine it pinned, sealed; pins every machine it learns', () async {
      final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
      final machine = await E2eeIdentity.generate();
      final bPub = await _pub();
      final cPub = await _pub();
      await keys.pin(ms.machineId, machine.pub);
      await keys.pin(_b, b64d(bPub), label: 'b');
      Map<String, dynamic>? seen;
      final socket = _machineSocket(
        machine,
        (_) => {
          'members': [_machine(cPub, _c, 50).toJson()],
          'removed': [],
        },
        onRequest: (r) => seen = r,
      );

      final outcome = await syncTrustGroup(
        machineId: ms.machineId,
        keys: keys,
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        label: "Dee's iPhone",
        socket: socket.factory,
      );

      // What left the phone went sealed (the machine could open it) and said who the phone is.
      final groupFrame = socket.sent.firstWhere(
        (f) => f['type'] == 'group_sync',
      );
      expect((groupFrame['payload'] as Map).containsKey('__e2e'), isTrue);
      expect(seen!['self'], containsPair('kind', 'viewer'));
      expect(seen!['self'], containsPair('label', "Dee's iPhone"));
      final sentMembers = (seen!['members'] as List).cast<Map>();
      expect(sentMembers.map((m) => m['machineId']), contains(_b));

      expect(outcome.pinned, [_c]);
      expect(b64e((await keys.peer(_c))!.pub), cPub);
      expect(socket.closedByPhone, isTrue);
    });

    test(
      'a suspended key is neither pinned nor seeded into the roster',
      () async {
        final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
        final machine = await E2eeIdentity.generate();
        final cPub = await _pub();
        final dPub = await _pub();
        final dId = 'd' * 32;
        await keys.pin(ms.machineId, machine.pub);
        await keys.pin(
          dId,
          b64d(dPub),
          label: 'd',
        ); // a pin the roster does not name yet
        Map<String, dynamic>? seen;
        final socket = _machineSocket(
          machine,
          (_) => {
            'members': [_machine(cPub, _c, 50).toJson()],
            'removed': [],
          },
          onRequest: (r) => seen = r,
        );
        final outcome = await syncTrustGroup(
          machineId: ms.machineId,
          keys: keys,
          accessToken: 't',
          wsBaseUrl: 'wss://relay.test',
          autonomousEnv: 'prod',
          label: 'p',
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
      final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
      final machine = await E2eeIdentity.generate();
      final cPub = await _pub();
      await keys.pin(ms.machineId, machine.pub);
      final socket = _machineSocket(
        machine,
        (_) => {
          'members': [_machine(cPub, _c, 50).toJson()],
          'removed': [],
          'devlog': {
            'head': {'seq': 1, 'hash': 'x'},
          },
        },
      );
      final suspendedNow = <String>{};
      final outcome = await syncTrustGroup(
        machineId: ms.machineId,
        keys: keys,
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        label: 'p',
        socket: socket.factory,
        onDevlog: (_, _) async => suspendedNow.add(cPub),
        suspended: () async => {...suspendedNow},
      );
      expect(outcome.pinned, isEmpty);
      expect(await keys.peer(_c), isNull);
    });

    test(
      'a pin the roster already names is not restamped by re-pinning',
      () async {
        final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
        final machine = await E2eeIdentity.generate();
        final bPub = await _pub();
        await keys.pin(ms.machineId, machine.pub);
        await keys.pin(_b, b64d(bPub), label: 'b');
        final sent = <int>[];
        Future<void> swap() async {
          final socket = _machineSocket(
            machine,
            (_) => {'members': [], 'removed': []},
            onRequest: (r) => sent.add(
              ((r['members'] as List).cast<Map>().firstWhere(
                    (m) => m['machineId'] == _b,
                  ))['at']
                  as int,
            ),
          );
          await syncTrustGroup(
            machineId: ms.machineId,
            keys: keys,
            accessToken: 't',
            wsBaseUrl: 'wss://relay.test',
            autonomousEnv: 'prod',
            label: 'p',
            socket: socket.factory,
          );
        }

        await swap();
        await Future<void>.delayed(const Duration(milliseconds: 5));
        await keys.pin(
          _b,
          b64d(bPub),
          label: 'b',
        ); // what the group's own pin does
        await swap();
        expect(sent, hasLength(2));
        expect(sent[1], sent[0]);
      },
    );

    test('a member the group removed is unpinned', () async {
      final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
      final machine = await E2eeIdentity.generate();
      final cPub = await _pub();
      await keys.pin(ms.machineId, machine.pub);
      await keys.pin(_c, b64d(cPub));
      final socket = _machineSocket(
        machine,
        (_) => {
          'members': [],
          'removed': [
            {'pub': cPub, 'at': DateTime.now().millisecondsSinceEpoch},
          ],
        },
      );
      final outcome = await syncTrustGroup(
        machineId: ms.machineId,
        keys: keys,
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        label: 'p',
        socket: socket.factory,
      );
      expect(outcome.unpinned, [_c]);
      expect(await keys.peer(_c), isNull);
    });

    test(
      'a machine that is not linked, refuses, or never answers changes nothing',
      () async {
        final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
        expect(
          (await syncTrustGroup(
            machineId: ms.machineId,
            keys: keys,
            accessToken: 't',
            wsBaseUrl: 'wss://relay.test',
            autonomousEnv: 'prod',
            label: 'p',
            socket: FakeRelaySocket().factory,
          )).changed,
          isFalse,
        );

        final machine = await E2eeIdentity.generate();
        await keys.pin(ms.machineId, machine.pub);
        late FakeRelaySocket denied;
        denied = FakeRelaySocket(
          onFrame: (frame) {
            if (frame['type'] == 'machine_select') {
              denied.emit('connected', {'machineId': ms.machineId});
            }
            if (frame['type'] == 'e2e_hello') {
              denied.emit('e2e_denied', {'reason': 'unpaired'});
            }
          },
        );
        final refused = await syncTrustGroup(
          machineId: ms.machineId,
          keys: keys,
          accessToken: 't',
          wsBaseUrl: 'wss://relay.test',
          autonomousEnv: 'prod',
          label: 'p',
          socket: denied.factory,
        );
        expect(refused.changed, isFalse);

        final silent = await syncTrustGroup(
          machineId: ms.machineId,
          keys: keys,
          accessToken: 't',
          wsBaseUrl: 'wss://relay.test',
          autonomousEnv: 'prod',
          label: 'p',
          socket: FakeRelaySocket().factory,
          timeout: const Duration(milliseconds: 50),
        );
        expect(silent.changed, isFalse);
        expect(await keys.peer(ms.machineId), isNotNull);
      },
    );
  });
}
