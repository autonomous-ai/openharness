import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/device_ack.dart';
import 'package:harness/viewer/device_log.dart';

/// The Dart port of the device acknowledgement, held to the fixture every implementation shares
/// (cli/scripts/gen-devack-vectors.ts).
void main() {
  final vectors = jsonDecode(File('test/viewer/deviceAck.vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final acct = vectors['acct'] as String;
  final seeds = (vectors['seeds'] as Map).cast<String, String>();
  final pubs = (vectors['pubs'] as Map).cast<String, String>();
  final valid = (vectors['valid'] as List).cast<Map<String, dynamic>>();
  Future<DevLogState> state() async =>
      (await applyDevLogEntries(DevLogState.empty(acct), (vectors['log'] as List).cast<Object?>())).state;

  test('encodes the first acknowledgement to the fixture bytes', () {
    expect(hexOf(devAckMessage(DevAck.parse(valid.first)!)), vectors['message']);
  });

  test('re-signs every valid acknowledgement to the same signature, and accepts it', () async {
    final byPub = {for (final n in seeds.keys) pubs[n]!: seeds[n]!};
    final s = await state();
    for (final raw in valid) {
      final a = DevAck.parse(raw)!;
      final id = await E2eeIdentity.fromSeed(b64d(byPub[a.signer]!));
      expect(b64e(id.pub), a.signer);
      expect((await signDevAck(a.withSig(''), id)).sig, a.sig);
      final checked = await checkDevAck(s, raw);
      expect(checked.code, isNull);
      expect(checked.ack?.toJson(), raw);
    }
  });

  for (final c in (vectors['invalid'] as List).cast<Map<String, dynamic>>()) {
    test('refuses: ${c['name']} (${c['code']})', () async {
      final checked = await checkDevAck(await state(), c['ack']);
      expect(checked.ack, isNull);
      expect(checked.code, c['code']);
    });
  }

  test('refuses each field out of bounds', () {
    final good = valid.first;
    for (final bad in <Object?>[
      null,
      {...good, 'acct': ''},
      {...good, 'acct': 'x' * 129},
      {...good, 'signer': 'not base64!'},
      {...good, 'pub': 'A' * 200},
      {...good, 'addSeq': 1.5},
      {...good, 'addSeq': '3'},
      {...good, 'at': 0},
    ]) {
      expect(DevAck.parse(bad), isNull, reason: '$bad');
    }
    expect(DevAck.parse({...good, 'extra': 1})?.toJson(), good);
  });
}
