// The Dart renderer against the reference renderer's pinned frames
// (daemons/frames.json, written by daemons/tools/generate.mjs). Every frame,
// byte for byte, so the status line, the panel and the card draw exactly what
// hn and the lookbook draw.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/render.dart';
import 'package:harness/daemons/individuals.dart';
import 'package:harness/daemons/roster.dart';

void main() {
  final frames =
      jsonDecode(File('../daemons/frames.json').readAsStringSync()) as Map;
  final roster = daemonRoster;
  final printable = RegExp(r'^[\x20-\x7e]*$');

  test('the generated roster parses and matches roster.json', () {
    final source =
        jsonDecode(File('../daemons/roster.json').readAsStringSync()) as Map;
    expect(roster.daemons.map((d) => d.id), [
      for (final d in source['daemons'] as List) (d as Map)['id'],
    ]);
    expect(roster.rules.statusCells, 8);
    expect(roster.rules.habits.map((h) => h.key), [
      'turn',
      'split',
      'find',
      'elsewhere',
      'machine',
      'store',
      'resume',
      'days',
    ]);
  });

  test('every sprite frame matches the reference renderer', () {
    final sprites = frames['sprites'] as List;
    expect(sprites, hasLength(greaterThan(900)));
    var checked = 0;
    for (final raw in sprites) {
      final f = raw as Map;
      final d = roster.byId(f['id'] as String)!;
      final out = renderSprite(
        roster,
        d,
        roster.versionIndex(f['v'] as String),
        daemonMoodNamed(f['mood'] as String)!,
        t: f['t'] as int,
        lid: f['lid'] as String?,
      );
      expect(
        out,
        f['out'],
        reason: '${f['id']} ${f['v']} ${f['mood']} t=${f['t']} lid=${f['lid']}',
      );
      // A status cell is always exactly the eight cells plus both gutters (a
      // six-cell 1.0 sprite with a borrowed baton runs into the right one).
      expect(
        statusCell(
          roster,
          out,
          baseWidth(roster, d, roster.versionIndex(f['v'] as String)),
        ).length,
        roster.rules.statusCells + 2,
      );
      checked++;
    }
    expect(checked, sprites.length);
  });

  test('every portrait frame matches the reference renderer', () {
    final portraits = frames['portraits'] as List;
    expect(portraits, hasLength(greaterThan(400)));
    for (final raw in portraits) {
      final f = raw as Map;
      final d = roster.byId(f['id'] as String)!;
      final out = renderPortrait(
        roster,
        d,
        f['v'] as String,
        daemonMoodNamed(f['mood'] as String)!,
        t: f['t'] as int,
      );
      expect(out, [
        for (final l in f['out'] as List) l as String,
      ], reason: '${f['id']} ${f['v']} ${f['mood']} t=${f['t']}');
    }
  });

  test('every status cell matches the reference: centred on the base '
      'sprite', () {
    final cells = frames['cells'] as List;
    expect(cells, hasLength(greaterThan(400)));
    for (final raw in cells) {
      final f = raw as Map;
      final d = roster.byId(f['id'] as String)!;
      final vi = roster.versionIndex(f['v'] as String);
      final sprite = renderSprite(
        roster,
        d,
        vi,
        daemonMoodNamed(f['mood'] as String)!,
        t: f['t'] as int,
      );
      expect(
        statusCell(roster, sprite, baseWidth(roster, d, vi)),
        f['out'],
        reason: '${f['id']} ${f['v']} ${f['mood']} t=${f['t']}',
      );
      expect((f['out'] as String).length, roster.rules.statusCells + 2);
    }
    // The widest case: a six-cell sprite centred one cell in, plus a baton,
    // ends on the right gutter (the old port padded it to eleven).
    expect(
      statusCell(roster, '[=|==] |', 6),
      ' ' * 2 + '[=|==] |',
      reason: 'ten cells, the baton in the right gutter',
    );
    // A borrowed baton or a nap's z grows to the right: the face stays put.
    final tim = roster.byId('tim')!;
    final idle = statusCell(roster, '[oo]', baseWidth(roster, tim, 0));
    final working = statusCell(roster, '[==] |', baseWidth(roster, tim, 0));
    expect(idle.indexOf('['), working.indexOf('['));
    // Without a base width it centres the sprite as drawn.
    expect(statusCell(roster, '[oo]'), '   [oo]   ');
    expect(statusCell(roster, ';:(oo):;'), ' ;:(oo):; ');
  });

  test('every card matches card.mjs', () {
    final cards = frames['cards'] as List;
    expect(
      cards,
      hasLength(
        roster.daemons.length * 6 +
            roster.daemons.where((d) => d.traits != null).length,
      ),
    );
    for (final raw in cards) {
      final f = raw as Map;
      final d = roster.byId(f['id'] as String)!;
      final out = cardLines(
        roster,
        d,
        version: f['version'] as String,
        shiny: f['shiny'] == true,
        serial: f['serial'] as int?,
        nickname: f['nickname'] as String?,
        name: f['name'] as String?,
        traits: f['seed'] is int
            ? rollTraits(roster, d.id, f['seed'] as int)
            : null,
        hatched: f['hatched'] as String?,
        egg: f['egg'] as String?,
      );
      expect(out, [
        for (final l in f['out'] as List) l as String,
      ], reason: '${f['id']} ${f['version']} shiny=${f['shiny']}');
      expect(out.every((l) => l.length == cardWidth), isTrue);
    }
    // Secrets sit outside the numbered set; every drop numbers its own.
    expect(cardNumber(roster, roster.byId('tim')!), '#01/09');
    expect(cardNumber(roster, roster.byId('auk')!), '#09/09');
    expect(cardNumber(roster, roster.byId('beastie')!), '#S/09');
    expect(cardNumber(roster, roster.byId('tmux')!), '#01/09');
    expect(
      rarityStamp(roster, roster.byId('yak')!, shiny: true),
      '[ SHINY RARE ]  #05/09',
    );
    // The zoo's card reads its date from hatchedAt and its egg kind.
    final zooCard = zooCardLines(
      roster,
      roster.byId('tim')!,
      version: '1.0',
      name: 'pip',
      hatched: '2026-09-26T09:42:00Z',
      egg: 'week',
    );
    expect(zooCard, contains('|   pip the tim 1.0                      |'));
    expect(zooCard, contains('|   hatched 2026-09-26, week egg         |'));
    expect(cardCodeBlock(zooCard), startsWith('```\n.---'));
  });

  test('every egg stage matches render.mjs eggStage', () {
    final cases = (frames['eggStages'] as List).cast<Map>();
    expect(cases, isNotEmpty);
    for (final c in cases) {
      expect(
        eggStage(c['done'] as int, c['need'] as int, ready: c['ready'] == true),
        c['stage'],
        reason: '$c',
      );
    }
  });

  test('the first and setup eggs follow habits, as habitProgress', () {
    final cases = (frames['firstEgg'] as List).cast<Map>();
    expect(cases, isNotEmpty);
    for (final c in cases) {
      final habits = (c['habits'] as List).cast<String>();
      final kind = c['kind'] as String;
      final p = habitProgress(roster, habits, kind: kind);
      final why = '$kind $habits';
      expect(p.$1, c['done'], reason: why);
      expect(p.$2, c['need'], reason: why);
      final stage = eggStage(p.$1, p.$2);
      expect(stage, c['stage'], reason: why);
      expect(eggLine(roster, kind, stage), c['out'], reason: why);
    }
  });

  test('every egg line matches render.mjs eggLine', () {
    final cases = (frames['eggLines'] as List).cast<Map>();
    expect(cases, hasLength(greaterThan(100)));
    final unsafe = [
      for (final p
          in (jsonDecode(
                File('../daemons/roster.json').readAsStringSync(),
              )['rules']['ligatureUnsafe']
              as List))
        p as String,
    ];
    for (final c in cases) {
      final out = c['stage'] == 'hatchling'
          ? eggLine(roster, 'first', 'hatchling', sprite: c['sprite'] as String)
          : eggLine(
              roster,
              c['kind'] as String,
              c['stage'] as String,
              lid: c['lid'] as String?,
            );
      final why = '${c['kind']} ${c['stage']} ${c['lid']} ${c['id']}';
      expect(out, c['out'], reason: why);
      expect(out.length, lessThanOrEqualTo(roster.rules.statusCells));
      expect(printable.hasMatch(out), isTrue, reason: why);
      for (final pair in unsafe) {
        expect(out.contains(pair), isFalse, reason: '$why has $pair');
      }
    }
    // Every hatchling line is its 0.1 sprite between the halves of its shell.
    expect(eggLine(roster, 'first', 'hatchling', sprite: '(o o)'), ')(o o)(');
    expect(eggLine(roster, 'first', 'hatchling', sprite: '1234567'), '1234567');
  });

  test('every banner matches renderBanner in the shared face', () {
    final banners = frames['banners'] as List;
    expect(banners, hasLength(roster.daemons.length));
    for (final raw in banners) {
      final f = raw as Map;
      expect(renderBanner(daemonBanner, f['id'] as String), [
        for (final l in f['out'] as List) l as String,
      ], reason: f['id'] as String);
      expect(bannerRows(f['id'] as String), f['out']);
    }
    // Every row fits the reveal's 56 columns (a plate's width) at its own
    // size.
    for (final d in roster.daemons) {
      expect(
        bannerRows(d.id)
            .every((r) => r.length <= roster.rules.plate!.revealCols),
        isTrue,
        reason: d.id,
      );
    }
    expect(silhouette('[oo]'), '####');
    expect(silhouette('o   o'), '#   #');
  });

  test('every trait roll, its flags and rarity match render.mjs', () {
    final cases = (frames['traitRolls'] as List).cast<Map>();
    expect(cases, hasLength(greaterThan(200)));
    for (final c in cases) {
      final id = c['id'] as String, seed = c['seed'] as int;
      final traits = rollTraits(roster, id, seed)!;
      final why = '$id $seed';
      expect(traits.toJson(), c['traits'], reason: why);
      expect(
        traits.toJson().keys.toList(),
        (c['traits'] as Map).keys.toList(),
        reason: why,
      );
      expect(individualFlags(roster, id, traits), c['flags'], reason: why);
      expect(oneIn(roster, id, traits), c['oneIn'], reason: why);
    }
    // Every plate species has a catalogue; a line-art one has none to roll.
    expect(rollTraits(roster, 'tmux', 42), isNull);
    final zero = rollTraits(roster, 'tim', 0)!;
    expect(zero.colour, roster.byId('tim')!.traits!.colours.first.name);
    expect(zero.props.values.every((v) => v == 1), isTrue);
    expect(zero.fidgety, isFalse);
  });

  test('every individual sprite matches renderIndividualSprite', () {
    final cases = (frames['individualSprites'] as List).cast<Map>();
    expect(cases, hasLength(greaterThan(1000)));
    for (final c in cases) {
      final id = c['id'] as String, seed = c['seed'] as int;
      final traits = rollTraits(roster, id, seed);
      final vi = roster.versionIndex(c['v'] as String);
      final mood = daemonMoodNamed(c['mood'] as String)!;
      final out = renderIndividualSprite(
        roster,
        id,
        traits,
        vi,
        mood,
        t: c['t'] as int,
        lid: c['lid'] as String?,
      );
      final why =
          '$id $seed ${c['v']} ${c['mood']} t=${c['t']} lid=${c['lid']}';
      expect(out, c['out'], reason: why);
      final d = individualDaemon(roster, id, traits);
      expect(
        statusCell(roster, out, baseWidth(roster, d!, vi)),
        c['cell'],
        reason: why,
      );
    }
    // No extra and calm: the species itself.
    final plain = rollTraits(roster, 'tim', 0);
    expect(individualDaemon(roster, 'tim', plain), same(roster.byId('tim')));
  });
}
