import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/viewer/device_log.dart';
import 'package:harness/viewer/removed_machines.dart';

String _key(int n) => b64e(Uint8List(32)..fillRange(0, 32, n));

const _old = '3ebf380400004000800000000000000a';
const _mac = '6674db5700004000800000000000000b';

Map<String, Object?> _entry(
  int seq,
  String op,
  String kind,
  int key,
  String machineId,
) => DevLogEntry(
  v: devLogVersion,
  acct: 'acct',
  seq: seq,
  prev: devLogZeroHash,
  op: op,
  pub: _key(key),
  kind: kind,
  machineId: machineId,
  label: 'MacBookPro2021.local',
  at: 1,
  signer: _key(key),
  sig: b64e(Uint8List(64)),
).toJson();

Map<String, Object?> _stored({
  required List<Map<String, Object?>> recent,
  Map<String, DevLogMember> active = const {},
  List<Map<String, Object?>> loose = const [],
}) => {
  'state': DevLogState(
    acct: 'acct',
    head: DevLogHead(recent.length, devLogZeroHash),
    hashes: const [],
    active: active,
    removed: const [],
  ).toJson(),
  'recent': recent,
  'looseRemoved': loose,
};

void main() {
  test('a machine whose key was removed, with its latest removal', () {
    final removed = removedMachinesOf(
      _stored(
        recent: [
          _entry(1, 'add', 'machine', 1, _old),
          _entry(2, 'add', 'machine', 2, _mac),
          _entry(3, 'remove', 'machine', 1, _old),
          _entry(4, 'remove', 'machine', 2, _mac),
          _entry(5, 'remove', 'viewer', 3, ''),
        ],
      ),
    );

    expect(removed, {_old: 3, _mac: 4});
  });

  test('one signed in again under a new key is not removed', () {
    final removed = removedMachinesOf(
      _stored(
        recent: [
          _entry(1, 'add', 'machine', 1, _mac),
          _entry(2, 'remove', 'machine', 1, _mac),
          _entry(3, 'add', 'machine', 2, _mac),
        ],
        active: {
          _key(2): DevLogMember(
            pub: _key(2),
            kind: 'machine',
            machineId: _mac,
            label: 'MacBookPro2021.local',
            addedAt: 1,
            seq: 3,
          ),
        },
      ),
    );

    expect(removed, isEmpty);
  });

  test('a removal made while the log was frozen counts too', () {
    final removed = removedMachinesOf(
      _stored(
        recent: const [],
        loose: [_entry(7, 'remove', 'machine', 1, _mac)],
      ),
    );

    expect(removed, {_mac: 7});
  });

  test('no log yet: nothing removed', () {
    expect(removedMachinesOf(null), isEmpty);
    expect(removedMachinesOf({'recent': []}), isEmpty);
  });
}
