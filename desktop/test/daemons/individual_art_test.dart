import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/daemon_plate_client.dart';
import 'package:harness/daemons/plates.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/zoo.dart';

void main() {
  final fixtures =
      jsonDecode(File('../daemons/frames.json').readAsStringSync()) as Map;
  final roster = daemonRoster;
  Color color(String hex) =>
      Color(0xff000000 | int.parse(hex.substring(1), radix: 16));

  test('every egg plate and its material channel match the bake', () {
    final source =
        jsonDecode(File('../daemons/plates.json').readAsStringSync()) as Map;
    for (final kind in (source['eggs'] as Map).entries) {
      for (final size in (kind.value as Map).entries) {
        for (final stage in (size.value as Map).entries) {
          final frames = daemonPlates.egg(
            kind.key as String,
            PlateSize.values.byName(size.key as String),
            stage.key as String,
          );
          expect(
            [
              for (final frame in frames)
                {'rows': frame.rows.join('\n'), 'mats': frame.mats.join('\n')},
            ],
            stage.value,
            reason: '${kind.key} ${size.key} ${stage.key}',
          );
        }
      }
    }
  });

  test('every egg and individual material colour matches the reference', () {
    for (final f in (fixtures['eggColors'] as List).cast<Map>()) {
      final frame = daemonPlates.egg(
        f['kind'] as String,
        PlateSize.values.byName(f['size'] as String),
        f['stage'] as String,
      )[f['frame'] as int];
      for (final c in (f['cells'] as List).cast<Map>()) {
        final r = c['r'] as int, col = c['c'] as int;
        expect(frame.rows[r][col], c['ch']);
        expect(frame.mat(r, col), c['mat']);
        final actual = eggColor(
          roster,
          f['kind'] as String,
          frame.rows.length,
          r,
          c['ch'] as String,
          c['mat'] as String,
          background: color(f['bg'] as String),
          light: f['light'] as String,
          dim: f['dim'] == true,
        );
        expect(
          plateHex(actual!),
          c['hex'],
          reason: '${f['kind']} ${f['stage']} $r $col',
        );
      }
    }
    for (final f in (fixtures['individualColors'] as List).cast<Map>()) {
      final frame = PlateFrame.fromJson(f)!;
      final t = f['traits'] as Map;
      final traits = (
        colour: t['colour'] as String,
        accent: t['accent'] as String,
        extra: t['extra'] as String?,
      );
      for (final c in (f['cells'] as List).cast<Map>()) {
        final actual = individualColor(
          roster,
          roster.byId(f['id'] as String)!,
          traits,
          frame.rows.length,
          c['r'] as int,
          c['ch'] as String,
          c['mat'] as String,
          background: color(f['bg'] as String),
          shiny: f['shiny'] == true,
        );
        expect(
          plateHex(actual!),
          c['hex'],
          reason: '${f['id']} ${c['r']} ${c['c']}',
        );
      }
    }
  });

  final mine = ZooDaemon(
    uid: 'a' * 24,
    id: 'tim',
    seed: 13,
    hatched: '',
    egg: 'first',
  );
  Map<String, dynamic> answer(Map<String, dynamic> ask) => {
    ...ask,
    'frames': [
      {'rows': ' .#\n@x ', 'mats': '.m.\na..'},
    ],
    'frameMs': 170,
  };

  test(
    'a request is deduplicated and only its own validated answer is drawn',
    () {
      final sent = <Map<String, dynamic>>[];
      final client = DaemonPlateClient(
        send: (type, payload) {
          expect(type, 'daemon_plate_get');
          sent.add(payload);
          return true;
        },
      );
      addTearDown(client.dispose);
      DaemonIndividualArt? read() =>
          client.art(mine, PlateSize.portrait, '0.1', DaemonMood.idle);
      expect(read(), isNull);
      expect(read(), isNull);
      expect(sent, hasLength(1));
      client.receive('daemon_plate', answer(sent.single));
      final art = read()!;
      expect(art.frames.single.mat(0, 1), 'm');
      expect(read(), same(art));
      expect(sent, hasLength(1));
    },
  );

  test(
    'wrong individual, oversized and malformed frames fail with a retry delay',
    () {
      for (final bad in <Map<String, dynamic>>[
        {'uid': 'b' * 24},
        {
          'frames': [
            {'rows': 'x' * 57, 'mats': '.' * 57},
          ],
        },
        {
          'frames': [
            {'rows': 'x\nx', 'mats': '.'},
          ],
        },
        {
          'frames': [
            {'rows': '\x1b', 'mats': '.'},
          ],
        },
        {
          'frames': [
            {'rows': 'x', 'mats': 'q'},
          ],
        },
      ]) {
        var now = DateTime.utc(2026, 9, 27);
        final sent = <Map<String, dynamic>>[];
        final client = DaemonPlateClient(
          now: () => now,
          send: (_, payload) {
            sent.add(payload);
            return true;
          },
        );
        DaemonIndividualArt? read() =>
            client.art(mine, PlateSize.portrait, '0.1', DaemonMood.idle);
        read();
        client.receive('daemon_plate', {...answer(sent.single), ...bad});
        expect(read(), isNull);
        expect(sent, hasLength(1));
        now = now.add(const Duration(minutes: 2));
        read();
        expect(sent, hasLength(2));
        client.dispose();
      }
    },
  );

  test('reset discards old requests; a default individual sends nothing', () {
    final sent = <Map<String, dynamic>>[];
    final client = DaemonPlateClient(
      send: (_, payload) {
        sent.add(payload);
        return true;
      },
    );
    addTearDown(client.dispose);
    client.art(
      ZooDaemon(id: 'tim', hatched: '', egg: 'first'),
      PlateSize.portrait,
      '0.1',
      DaemonMood.idle,
    );
    expect(sent, isEmpty);
    client.art(mine, PlateSize.portrait, '0.1', DaemonMood.idle);
    final old = sent.single;
    client.reset();
    client.receive('daemon_plate', answer(old));
    expect(
      client.art(mine, PlateSize.portrait, '0.1', DaemonMood.idle),
      isNull,
    );
    expect(sent, hasLength(2));
  });
}
