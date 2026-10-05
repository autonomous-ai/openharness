import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/viewer/device_history.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

/// The Dart port of cli/src/lib/e2ee/deviceHistory.ts, on the same log as deviceHistory.spec.ts.
void main() {
  late E2eeIdentity a, b, c;
  late List<DevLogEntry> entries;
  late DevLogState state;

  Future<void> push(
    String op,
    E2eeIdentity key,
    E2eeIdentity signer,
    String label,
    int at, {
    String kind = 'viewer',
  }) async {
    final e = await signDevLogEntry(
      nextDevLogEntry(
        state,
        op: op,
        pub: b64e(key.pub),
        kind: kind,
        machineId: kind == 'machine' ? 'a' * 32 : '',
        label: label,
        signer: b64e(signer.pub),
        at: at,
      ),
      signer,
    );
    state = (await applyDevLogEntries(state, [e.toJson()])).state;
    entries.add(e);
  }

  setUp(() async {
    a = await E2eeIdentity.fromSeed(List.filled(32, 1));
    b = await E2eeIdentity.fromSeed(List.filled(32, 2));
    c = await E2eeIdentity.fromSeed(List.filled(32, 3));
    state = DevLogState.empty('acct');
    entries = [];
    await push('add', a, a, 'mac', 10, kind: 'machine');
    await push('add', b, b, 'phone', 20);
    await push('add', b, b, 'pixel', 30);
    await push('add', c, c, 'ipad', 40);
    await push('remove', c, a, 'ipad', 50);
    await push('remove', b, b, 'pixel', 60);
  });

  List<DevLogHistoryRow> rows({
    List<DevLogEntry>? only,
    List<DevLogEntry> loose = const [],
  }) => devLogHistory(
    only ?? entries,
    selfPub: b64e(a.pub),
    joinedSeq: 1,
    pending: [b64e(b.pub)],
    active: state.active,
    loose: loose,
  );

  test('is newest first and tells each operation apart', () {
    expect(
      [for (final r in rows()) '${r.seq}:${r.op}'],
      [
        '6:signedOut',
        '5:removed',
        '4:added',
        '3:renamed',
        '2:added',
        '1:added',
      ],
    );
  });

  test(
    'names who removed a key that is gone, and the old label of a rename',
    () {
      final r = rows();
      expect(r[1].by?.label, 'mac');
      expect(r[1].active, isFalse);
      expect(r[3].previousLabel, 'phone');
      expect(r[3].label, 'pixel');
    },
  );

  test('flags this device, entries after joining and pending', () {
    final r = rows();
    expect(r[5].thisDevice, isTrue);
    expect(r[5].afterJoin, isFalse);
    expect(r[4].afterJoin, isTrue);
    expect(r[4].pending, isTrue);
  });

  test(
    'marks loose removals as applied while frozen and does not duplicate',
    () {
      final out = rows(
        only: entries.sublist(0, 4),
        loose: [entries[4], entries[4]],
      );
      expect(out.first.whileFrozen, isTrue);
      expect(out, hasLength(5));
    },
  );

  test('reads the rows the daemon sends', () {
    final h = DeviceLogHistory.fromJson({
      'complete': false,
      'frozen': null,
      'rows': [
        {
          'seq': 3,
          'op': 'removed',
          'pub': 'p',
          'kind': 'machine',
          'machineId': 'm',
          'label': 'box',
          'fingerprint': 'AAAA',
          'by': {'pub': 'q', 'label': 'mac', 'fingerprint': 'BBBB'},
          'at': 5,
          'thisDevice': false,
          'afterJoin': true,
          'pending': false,
          'active': false,
          'whileFrozen': true,
        },
        'junk',
      ],
    })!;
    expect(h.complete, isFalse);
    expect(h.rows.single.by?.label, 'mac');
    expect(h.rows.single.whileFrozen, isTrue);
    expect(DeviceLogHistory.fromJson('x'), isNull);
  });

  group('copy', () {
    DeviceRemovalNotice notice({
      String signerLabel = 'Mac',
      bool pending = false,
      bool self = false,
      String label = 'iPad',
    }) => DeviceRemovalNotice(
      pub: 'p',
      label: label,
      kind: 'viewer',
      fingerprint: 'AAAA',
      signer: 'q',
      signerLabel: signerLabel,
      signerFingerprint: 'E2FB·0DF5·5FD8·E6C7',
      signerPending: pending,
      selfRemoved: self,
      at: 0,
    );

    test('removal notices', () {
      expect(notice().title, 'Device removed');
      expect(notice().sentence, 'iPad was removed from your account by Mac.');
      expect(
        notice(signerLabel: '').sentence,
        'iPad was removed from your account by another device.',
      );
      expect(notice(self: true).title, 'Device signed out');
      expect(notice(self: true).sentence, 'iPad signed out of your account.');
      expect(notice(self: true, pending: true).red, isFalse);
    });

    test('a red notice shows two fingerprint groups', () {
      final n = notice(pending: true);
      expect(n.red, isTrue);
      expect(n.title, 'Removed by a new device');
      expect(
        n.sentence,
        'iPad was removed from your account by a new device you haven’t looked at (Mac · E2FB·0DF5…).',
      );
      expect(
        notice(pending: true, signerLabel: '').sentence,
        contains('(another device · E2FB·0DF5…)'),
      );
    });

    DeviceLogDeparted departed({
      String removedBy = 'q',
      String removedByLabel = 'Mac',
      bool self = false,
    }) => DeviceLogDeparted(
      pub: 'p',
      label: 'iPad',
      kind: 'viewer',
      machineId: '',
      fingerprint: 'AAAA',
      addedAt: 0,
      removedAt: 0,
      removedBy: removedBy,
      removedByLabel: removedByLabel,
      selfRemoved: self,
    );

    test('a departed key names its remover only when something removed it', () {
      const head = 'iPad joined your account and left before you looked.';
      expect(departed().sentence(red: false), '$head Removed by Mac.');
      expect(
        departed().sentence(red: true),
        '$head Removed by Mac, a new device you haven’t looked at.',
      );
      expect(
        departed(removedByLabel: '').sentence(red: false),
        '$head Removed by another device.',
      );
      expect(departed(self: true).sentence(red: false), head);
      expect(departed(removedBy: 'p').sentence(red: true), head);
      // Taken off the list by a review of it (no signer): nothing "removed" it.
      expect(
        departed(removedBy: '', removedByLabel: '').sentence(red: false),
        head,
      );
      expect(
        departed(removedBy: '', removedByLabel: '').sentence(red: true),
        head,
      );
    });

    DevLogHistoryRow histRow(
      String op, {
      String label = 'Mac',
      String? previous,
      String? by,
      bool frozen = false,
    }) => DevLogHistoryRow(
      seq: 1,
      op: op,
      pub: 'p',
      kind: 'viewer',
      machineId: '',
      label: label,
      previousLabel: previous,
      fingerprint: 'AAAA',
      by: by == null
          ? null
          : DevLogHistoryBy(pub: 'q', label: by, fingerprint: 'BBBB'),
      at: 0,
      thisDevice: false,
      afterJoin: false,
      pending: false,
      active: false,
      whileFrozen: frozen,
    );

    test('history sentences', () {
      expect(historySentence(histRow('added')), 'Mac added');
      expect(
        historySentence(histRow('renamed', previous: 'Old Mac')),
        'Old Mac renamed to Mac',
      );
      expect(historySentence(histRow('renamed')), 'Mac renamed');
      expect(
        historySentence(histRow('removed', by: 'iPad')),
        'Mac removed by iPad',
      );
      expect(
        historySentence(histRow('removed', by: '')),
        'Mac removed by another device',
      );
      expect(historySentence(histRow('removed')), 'Mac removed');
      expect(historySentence(histRow('signedOut')), 'Mac signed out');
      expect(
        historySentence(histRow('added', frozen: true)),
        'Mac added · applied while the list was frozen',
      );
    });
  });

  group('shared vectors (cli/src/lib/e2ee/deviceHistory.vectors.json)', () {
    final vectors = jsonDecode(
      File('test/viewer/deviceHistory.vectors.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    final pubs = (vectors['pubs'] as Map).cast<String, String>();
    final all = [
      for (final e in vectors['entries'] as List) DevLogEntry.parse(e)!,
    ];

    for (final c in (vectors['history'] as List).cast<Map<String, dynamic>>()) {
      test('history: ${c['name']}', () async {
        final state = (await applyDevLogEntries(
          DevLogState.empty(vectors['acct'] as String),
          [for (final e in all) e.toJson()],
        )).state;
        List<DevLogEntry> pick(List<dynamic> seqs) => [
          for (final n in seqs) all[(n as int) - 1],
        ];
        final rows = devLogHistory(
          pick(c['seqs'] as List),
          selfPub: pubs[c['self']]!,
          joinedSeq: c['joinedSeq'] as int?,
          pending: [for (final k in c['pending'] as List) pubs[k]!],
          active: state.active,
          loose: pick(c['loose'] as List),
        );
        final want = (c['rows'] as List).cast<Map<String, dynamic>>();
        expect(rows, hasLength(want.length));
        for (var i = 0; i < want.length; i++) {
          final r = rows[i], w = want[i];
          expect(
            {
              'seq': r.seq,
              'op': r.op,
              'label': r.label,
              'kind': r.kind,
              'previousLabel': r.previousLabel,
              'by': r.by?.label,
              'thisDevice': r.thisDevice,
              'afterJoin': r.afterJoin,
              'pending': r.pending,
              'active': r.active,
              'whileFrozen': r.whileFrozen,
            },
            {
              'seq': w['seq'],
              'op': w['op'],
              'label': w['label'],
              'kind': w['kind'],
              'previousLabel': w['previousLabel'],
              'by': w['by'],
              'thisDevice': w['thisDevice'],
              'afterJoin': w['afterJoin'],
              'pending': w['pending'],
              'active': w['active'],
              'whileFrozen': w['whileFrozen'],
            },
          );
        }
      });
    }

    for (final c
        in (vectors['divergence'] as List).cast<Map<String, dynamic>>()) {
      test('divergence: ${c['name']}', () async {
        final acct = vectors['acct'] as String;
        final mine = (await applyDevLogEntries(DevLogState.empty(acct), [
          for (final e in vectors['entries'] as List) e,
        ])).state;
        final other = (await applyDevLogEntries(DevLogState.empty(acct), [
          for (final e
              in (c['log'] == 'fork' ? vectors['fork'] : vectors['entries'])
                  as List)
            e,
        ])).state;
        final from = c['from'] as int, to = c['to'] as int;
        final hashes = [
          for (var seq = from; seq <= to; seq++)
            {'seq': seq, 'hash': other.hashes[seq - 1]},
        ];
        Object? theirs = {
          'head': {'seq': to, 'hash': other.hashes[to - 1]},
          'hashes': hashes,
        };
        switch (c['tamper']) {
          case 'gap':
            theirs = {
              'head': {'seq': to, 'hash': other.hashes[to - 1]},
              'hashes': [
                for (final h in hashes)
                  if (h['seq'] != 2) h,
              ],
            };
          case 'head':
            theirs = {
              'head': {'seq': to, 'hash': 'nope'},
              'hashes': hashes,
            };
          case 'junk':
            theirs = {
              'head': {'seq': to, 'hash': other.hashes[to - 1]},
              'hashes': 'junk',
            };
        }
        expect(devLogDivergence(mine, theirs), c['expect']);
      });
    }
  });
}
