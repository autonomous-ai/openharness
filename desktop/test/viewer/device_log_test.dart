import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/device_log.dart';

/// The Dart port of the device key log, held to the fixture every implementation shares
/// (cli/scripts/gen-devlog-vectors.ts).
void main() {
  final vectors = jsonDecode(File('test/viewer/device_log.vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final acct = vectors['acct'] as String;
  final valid = vectors['valid'] as Map<String, dynamic>;
  final entries = (valid['entries'] as List).cast<Object?>();

  test('derives the fixture keys from their seeds', () async {
    final seeds = (vectors['seeds'] as Map).cast<String, String>();
    final pubs = (vectors['pubs'] as Map).cast<String, String>();
    for (final name in seeds.keys) {
      final id = await E2eeIdentity.fromSeed(b64d(seeds[name]!));
      expect(b64e(id.pub), pubs[name]);
    }
  });

  test('applies every valid entry to the fixture hashes, head and active set', () async {
    final applied = await applyDevLogEntries(DevLogState.empty(acct), entries);
    expect(applied.state.hashes, valid['hashes']);
    expect(applied.state.head.toJson(), valid['head']);
    expect(applied.state.active.keys.toList()..sort(), valid['active']);
    expect(applied.state.removed, valid['removed']);
  });

  test('re-signs every valid entry to the same signature', () async {
    final seeds = (vectors['seeds'] as Map).cast<String, String>();
    final pubs = (vectors['pubs'] as Map).cast<String, String>();
    final byPub = {for (final n in seeds.keys) pubs[n]!: seeds[n]!};
    for (final raw in entries) {
      final e = DevLogEntry.parse(raw)!;
      final id = await E2eeIdentity.fromSeed(b64d(byPub[e.signer]!));
      expect((await signDevLogEntry(e.withSig(''), id)).sig, e.sig);
    }
  });

  for (final c in (vectors['invalid'] as List).cast<Map<String, dynamic>>()) {
    test('refuses: ${c['name']} (${c['code']})', () async {
      final base = (await applyDevLogEntries(DevLogState.empty(acct), entries.sublist(0, c['after'] as int))).state;
      Object? error;
      try {
        await applyDevLogEntries(base, [c['entry']]);
      } catch (err) {
        error = err;
      }
      expect(error, isA<DevLogError>().having((e) => e.code, 'code', c['code']));
    });
  }

  test('round-trips its state through JSON', () async {
    final s = (await applyDevLogEntries(DevLogState.empty(acct), entries)).state;
    final back = DevLogState.fromJson(jsonDecode(jsonEncode(s.toJson())))!;
    expect(back.toJson(), s.toJson());
  });

  test('tells same, ahead, behind and fork apart', () async {
    final s = (await applyDevLogEntries(DevLogState.empty(acct), entries.sublist(0, 4))).state;
    final hashes = (valid['hashes'] as List).cast<String>();
    expect(compareDevLogHead(s, s.head), 'same');
    expect(compareDevLogHead(s, DevLogHead(2, hashes[1])), 'ahead');
    expect(compareDevLogHead(s, DevLogHead(6, hashes[5])), 'behind');
    expect(compareDevLogHead(s, DevLogHead(3, hashes[1])), 'fork');
  });
}
