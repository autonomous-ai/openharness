// The phone's Dart renderer against the reference renderer's pinned frames
// (daemons/frames.json, written by daemons/tools/generate.mjs): every sprite,
// portrait, status cell, card, banner and plate colour, byte for byte, so the
// phone draws exactly what hn, the desktop and the lookbook draw. And the
// baked plates (daemons/plates.json) as the phone reads them.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/painting.dart' show Color;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/card.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';

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
    expect(roster.rules.habits.map((h) => h.key), contains('elsewhere'));
    // Economy v2: the setup egg, duplicate and overflow xp, shiny colours and
    // drop dates, all read from the roster rather than written down here.
    final rules = source['rules'] as Map;
    expect(roster.rules.setupEggNeed, (rules['setupEgg'] as Map)['need']);
    expect(roster.rules.duplicateXp, rules['duplicateXp']);
    expect(roster.rules.overflowXp, rules['overflowXp']);
    expect(roster.rules.eggs['setup']!.look, r'\_$_/');
    for (final (i, raw) in (source['daemons'] as List).indexed) {
      final shiny = (raw as Map)['shiny'] as Map;
      expect(roster.daemons[i].shinyHex, shiny['hex']);
      expect(
        roster.daemons[i].colorFor(shiny: true),
        isNot(roster.daemons[i].color),
      );
    }
    for (final (i, raw) in (source['drops'] as List).indexed) {
      expect(roster.drops[i].announce, (raw as Map)['announce']);
      expect(roster.drops[i].release, raw['release']);
      expect(roster.drops[i].hold, raw['hold'] == true);
    }
    // Drop init: ten daemons drawn filled, each with a gradient and a shiny
    // one, and no line portrait; the status line keeps their sprites.
    final init = roster.daemons.where((d) => d.drop == 'init').toList();
    expect(init.map((d) => d.id), [
      'tim', 'gnu', 'lynx', 'mutt', 'yak', //
      'gopher', 'bug', 'tux', 'auk', 'beastie',
    ]);
    for (final d in init) {
      expect(d.plate, isTrue, reason: d.id);
      expect(d.portraits, isEmpty, reason: d.id);
      expect(d.gradient, isNotNull, reason: d.id);
      expect(d.gradientFor(shiny: true), same(d.shinyGradient), reason: d.id);
      expect(d.sprites.keys, roster.rules.versions, reason: d.id);
    }
    expect(roster.byId('tmux')!.plate, isFalse);
    expect(roster.byId('tmux')!.gradientFor(shiny: true), isNull);
    expect(roster.rules.plate!.cols, {'portrait': 28, 'reveal': 56});
    expect(roster.rules.plate!.frameMs, 170);
  });

  test(
    'a drop is announced, then released, on UTC days (card.mjs dropState)',
    () {
      final init = roster.drop('init')!;
      expect(
        init.stateAt(DateTime.utc(2026, 9, 12, 23, 59, 59)),
        DropState.hidden,
      );
      expect(init.stateAt(DateTime.utc(2026, 9, 13)), DropState.announced);
      expect(
        init.stateAt(DateTime.utc(2026, 9, 26, 23, 59, 59)),
        DropState.announced,
      );
      expect(init.stateAt(DateTime.utc(2026, 9, 27)), DropState.released);
      // A drop without dates is out.
      expect(
        const DaemonDrop('x', 2, 'x').stateAt(DateTime.utc(2000)),
        DropState.released,
      );
      expect(shelfDrops(roster, DateTime.utc(2026, 9, 1)), isEmpty);
      expect(shelfDrops(roster, DateTime.utc(2026, 9, 20)).single.id, 'init');
      expect(shelfDrops(roster, DateTime.utc(2030)).single.id, 'init');
    },
  );

  test('a drop on hold is shown nowhere, whatever its dates say', () {
    for (final id in ['unix', 'tty']) {
      final held = roster.drop(id)!;
      expect(held.hold, isTrue);
      expect(held.announce, isNull);
      expect(held.release, isNull);
      for (final day in [DateTime.utc(2000), DateTime.utc(2030)]) {
        expect(held.stateAt(day), DropState.hidden, reason: '$id $day');
        expect(shelfCells(roster, const [], drop: id, now: day), isEmpty);
        // Not even what you own of it: no shelf, no count.
        expect(
          shelfLines(roster, shelfEntries(['tmux', 'vim']), drop: id, now: day),
          isEmpty,
        );
      }
    }
    // Hold is read before the dates (card.mjs dropState): a held drop with
    // dates long past is still hidden.
    const dated = DaemonDrop(
      'x',
      4,
      'x',
      announce: '2000-01-01',
      release: '2000-01-15',
      hold: true,
    );
    expect(dated.stateAt(DateTime.utc(2026)), DropState.hidden);
    // Its daemons still render if a zoo from before ever pairs one.
    final tmux = roster.byId('tmux')!;
    expect(renderSprite(roster, tmux, 0, DaemonMood.idle), '[o o]');
    expect(
      renderPortrait(roster, tmux, '0.1', DaemonMood.idle, motion: false),
      isNotEmpty,
    );
  });

  test('a card carries its serial; a guest\'s daemon has none', () {
    final tim = roster.byId('tim')!;
    final framed = (frames['cards'] as List).cast<Map>().firstWhere(
      (f) => f['id'] == 'tim' && f['version'] == '2.0' && f['serial'] == 42,
    );
    // The card of a daemon you own is card.mjs's card with its own facts.
    final mine = ZooDaemon.fromJson({
      'id': 'tim',
      'hatchedAt': '2026-09-26T12:00:00Z',
      'egg': 'first',
      'shiny': true,
      'nickname': 'pip',
      'xp': 600,
      'serial': 42,
    }, roster)!;
    final lines = ownedCardLines(roster, tim, mine);
    expect(lines, [for (final l in framed['out'] as List) l as String]);
    expect(lines.join('\n'), contains('pip the tim 2.0  #0042'));
    expect(serialLabel(7), '#0007');

    final seeded = ZooDaemon.fromJson({
      'id': 'tim',
      'hatchedAt': '2026-09-26T12:00:00Z',
      'egg': 'first',
      'xp': 600,
      'serial': 42,
      'origin': 'local',
    }, roster)!;
    expect(
      ownedCardLines(roster, tim, seeded).join('\n'),
      isNot(contains('#00')),
    );
    // The portrait rows are the ones a card colours: tim is drawn filled,
    // so they hold its portrait plate at 2.0, idle, frame 0.
    final rows = cardPortraitRows(roster, tim, '2.0');
    final portrait = daemonPlates.still('tim', PlateSize.portrait, '2.0');
    expect(portrait, isNotEmpty);
    expect(cardPortrait(roster, tim, '2.0'), portrait);
    expect(rows.to - rows.from, portrait.length);
    for (final (i, line) in portrait.indexed) {
      expect(lines[rows.from + i], contains(line));
    }
  });

  test('every sprite frame matches the reference renderer', () {
    final sprites = frames['sprites'] as List;
    expect(sprites, hasLength(greaterThan(900)));
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
    }
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

  test('every status cell matches, centred on the base sprite', () {
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
      final cell = statusCell(roster, sprite, baseWidth(roster, d, vi));
      expect(
        cell,
        f['out'],
        reason: '${f['id']} ${f['v']} ${f['mood']} t=${f['t']}',
      );
    }
  });

  test('every card matches card.mjs', () {
    final cards = frames['cards'] as List;
    expect(cards, hasLength(roster.daemons.length * 6));
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
        hatched: f['hatched'] as String?,
        egg: f['egg'] as String?,
      );
      expect(out, [
        for (final l in f['out'] as List) l as String,
      ], reason: '${f['id']} ${f['version']} shiny=${f['shiny']}');
      expect(out.every((l) => l.length == cardWidth), isTrue);
      expect(out.every(printable.hasMatch), isTrue);
    }
    // Secrets sit outside the numbered set.
    expect(cardNumber(roster, roster.byId('tim')!), '#01/09');
    expect(cardNumber(roster, roster.byId('beastie')!), '#S/09');
    // A held drop numbers its own set.
    expect(cardNumber(roster, roster.byId('tmux')!), '#01/09');
    expect(cardNumber(roster, roster.byId('grue')!), '#S/09');
  });

  test('a plate daemon\'s card shows its portrait plate, idle, frame 0', () {
    for (final d in roster.daemons.where((d) => d.plate)) {
      for (final v in roster.rules.versions) {
        final plate = daemonPlates.still(d.id, PlateSize.portrait, v);
        final card = cardLines(roster, d, version: v);
        final rows = cardPortraitRows(roster, d, v);
        expect(rows.to - rows.from, plate.length, reason: '${d.id} $v');
        final pad = ((cardWidth - 4 - plate.first.length) / 2).floor();
        for (final (i, row) in plate.indexed) {
          expect(
            card[rows.from + i],
            '| ${(' ' * pad + row).padRight(cardWidth - 4)} |',
            reason: '${d.id} $v row $i',
          );
        }
        // Given the plate (card.mjs's `{ plate }`), the same card.
        expect(cardLines(roster, d, version: v, plate: plate), card);
      }
    }
  });

  test('the generated banner copy matches banner.json', () {
    final source =
        jsonDecode(File('../daemons/banner.json').readAsStringSync()) as Map;
    expect(daemonBanner.rows, source['rows']);
    expect(daemonBanner.gap, source['gap']);
    expect(daemonBanner.glyphs, source['glyphs']);
  });

  test('every banner matches renderBanner in render.mjs', () {
    final banners = frames['banners'] as List;
    expect(banners, hasLength(roster.daemons.length));
    for (final raw in banners) {
      final f = raw as Map;
      final out = renderBanner(daemonBanner, f['id'] as String);
      expect(out, [
        for (final l in f['out'] as List) l as String,
      ], reason: f['id'] as String);
      expect(out.every(printable.hasMatch), isTrue, reason: f['id'] as String);
    }
    expect(renderBanner(daemonBanner, 'tim'), [
      ' _     _',
      '| |_  (_)  _ __',
      "|  _| | | | '  \\",
      ' \\__| |_| |_|_|_|',
    ]);
    // Upper case draws as lower; a character the face lacks is a space.
    expect(
      renderBanner(daemonBanner, 'TIM'),
      renderBanner(daemonBanner, 'tim'),
    );
    expect(
      renderBanner(daemonBanner, 'i#i'),
      renderBanner(daemonBanner, 'i i'),
    );
    expect(renderBanner(daemonBanner, ''), isEmpty);
  });

  test('the shelf matches card.mjs shelfLines', () {
    final released = DateTime.utc(2026, 9, 27);
    expect(
      shelfLines(
        roster,
        shelfEntries(['tim', 'gnu', 'beastie']),
        now: released,
      ),
      [
        'zoo: drop 1 init  2/9  +secret',
        '',
        r'~(o o)~   \_oUo_/   [ ? ]     [ ? ]     [ ? ]',
        'tim       gnu       #03       #04       #05',
        '',
        '[ ? ]     [ ? ]     [ ? ]     [ ? ]     }oWo{ -E',
        '#06       #07       #08       #09       beastie',
      ],
    );
    expect(shelfLines(roster, const [], now: released), [
      'zoo: drop 1 init  0/9',
      '',
      '[ ? ]     [ ? ]     [ ? ]     [ ? ]     [ ? ]',
      '#01       #02       #03       #04       #05',
      '',
      '[ ? ]     [ ? ]     [ ? ]     [ ? ]     [ ! ]',
      '#06       #07       #08       #09       secret',
    ]);
    expect(fencedCard(['a', 'b']), '```\na\nb\n```');
  });

  test(
    'the shelf counts duplicates and shows announced drops, as card.mjs',
    () {
      // node daemons/tools/card.mjs --shelf 'tim*x2,gnu,beastiex4'
      final released = DateTime.utc(2026, 9, 27);
      expect(
        shelfLines(roster, const [
          ShelfEntry('tim', shiny: true, dupes: 1),
          ShelfEntry('gnu'),
          ShelfEntry('beastie', dupes: 3),
        ], now: released),
        [
          'zoo: drop 1 init  2/9  +secret',
          '',
          r'~(o o)~   \_oUo_/   [ ? ]     [ ? ]     [ ? ]',
          'tim x2    gnu       #03       #04       #05',
          '',
          '[ ? ]     [ ? ]     [ ? ]     [ ? ]     }oWo{ -E',
          '#06       #07       #08       #09       beastie x4',
        ],
      );
      final cells = shelfCells(roster, const [
        ShelfEntry('tim', shiny: true, dupes: 1),
      ], now: released);
      expect(cells.first.shiny, isTrue);
      expect(cells.first.count, 2);
      // Announced, not released: silhouettes of the 0.1 sprites, the release
      // date, and what you own does not show yet.
      expect(
        shelfLines(
          roster,
          shelfEntries(['tim']),
          now: DateTime.utc(2026, 9, 26, 23, 59, 59),
        ),
        [
          'zoo: drop 1 init  out 2026-09-27',
          '',
          '## ##     #####     #####     ######    #####',
          '#01       #02       #03       #04       #05',
          '',
          '#####     ###       ### ##    ####      [ ! ]',
          '#06       #07       #08       #09       secret',
        ],
      );
      final announced = shelfCells(
        roster,
        const [],
        now: DateTime.utc(2026, 9, 20),
      );
      expect(announced.where((c) => c.silhouette), hasLength(9));
      expect(announced.any((c) => c.owned), isFalse);
      // Not announced yet: shown nowhere.
      expect(
        shelfLines(roster, const [], now: DateTime.utc(2026, 9, 12)),
        isEmpty,
      );
      expect(
        shelfCells(roster, const [], now: DateTime.utc(2026, 9, 1)),
        isEmpty,
      );
    },
  );

  test('nest stages follow habits done, as render.mjs nestStage', () {
    final nests = (frames['nests'] as List).cast<Map>();
    expect(nests, isNotEmpty);
    expect(
      [
        for (final n in nests)
          nestFor(roster, (n['habits'] as List).cast<String>()),
      ],
      [for (final n in nests) n['out'] as String],
    );
  });

  test('the reveal pieces keep their shape', () {
    for (final frame in [
      eggFrame(roster),
      eggFrame(roster, offset: -1),
      eggFrame(roster, offset: 1, crack: 1),
      eggFrame(roster, crack: 2),
      eggPopFrame(roster),
    ]) {
      expect(frame.split('\n').every((r) => r.length == 18), isTrue);
    }
    expect(silhouette('[oo]'), '####');
    expect(silhouette('o   o'), '#   #');
    expect(
      rarityStamp(roster, roster.byId('yak')!, shiny: true),
      '[ * SHINY * RARE ]  #05/09',
    );
  });

  test('a new version morphs in three quick frames', () {
    final tim = roster.byId('tim')!;
    String at(int v) => renderSprite(roster, tim, v, DaemonMood.idle);
    expect(versionMorph(at(0), at(1)), ['## ##', '### ###', ',(o o),']);
    expect(versionMorph(at(1), at(2)), ['### ###', '### ###', '~(o o)~']);
    // A line-art daemon of a held drop grows the same way.
    final tmux = roster.byId('tmux')!;
    String old(int v) => renderSprite(roster, tmux, v, DaemonMood.idle);
    expect(versionMorph(old(0), old(1)), ['## ##', '#####', '[o|o]']);
  });

  // ── plates ─────────────────────────────────────────────────────────────────

  test('the generated plates are plates.json, parsed once', () {
    final source =
        jsonDecode(File('../daemons/plates.json').readAsStringSync()) as Map;
    expect(daemonPlates.source, source['source']);
    expect(daemonPlates.frameMs, source['frameMs']);
    expect(daemonPlates.frameMs, roster.rules.plate!.frameMs);
    final daemons = source['daemons'] as Map;
    expect(daemons.keys, [
      for (final d in roster.daemons)
        if (d.plate) d.id,
    ]);
    for (final e in daemons.entries) {
      for (final s in (e.value as Map).entries) {
        for (final v in (s.value as Map).entries) {
          for (final m in (v.value as Map).entries) {
            final frames = daemonPlates.frames(
              e.key as String,
              PlateSize.values.byName(s.key as String),
              v.key as String,
              daemonMoodNamed(m.key as String)!,
            );
            expect(
              [for (final f in frames) f.join('\n')],
              m.value,
              reason: '${e.key} ${s.key} ${v.key} ${m.key}',
            );
          }
        }
      }
    }
    // A loop is split into rows once and kept.
    expect(
      daemonPlates.frames('tim', PlateSize.reveal, '2.0', DaemonMood.idle),
      same(
        daemonPlates.frames('tim', PlateSize.reveal, '2.0', DaemonMood.idle),
      ),
    );
    // A line-art daemon has none; a version not baked draws as the nearest
    // one below.
    expect(daemonPlates.has('tmux'), isFalse);
    expect(
      daemonPlates.frames('tmux', PlateSize.portrait, '2.0', DaemonMood.idle),
      isEmpty,
    );
    expect(
      daemonPlates.frames('tim', PlateSize.portrait, '1.5', DaemonMood.idle),
      daemonPlates.frames('tim', PlateSize.portrait, '1.0', DaemonMood.idle),
    );
  });

  test('every plate keeps its shape: one crop per width and version', () {
    final rules = roster.rules.plate!;
    for (final d in roster.daemons.where((d) => d.plate)) {
      for (final size in PlateSize.values) {
        for (final v in roster.rules.versions) {
          int? width, height;
          for (final mood in DaemonMood.values) {
            final loop = daemonPlates.frames(d.id, size, v, mood);
            final why = '${d.id} ${size.name} $v ${mood.name}';
            expect(
              loop,
              hasLength(
                mood == DaemonMood.idle ? rules.idleFrames : rules.otherFrames,
              ),
              reason: why,
            );
            for (final rows in loop) {
              width ??= rows.first.length;
              height ??= rows.length;
              expect(rows, hasLength(height), reason: why);
              for (final row in rows) {
                expect(row.length, width, reason: why);
                expect(printable.hasMatch(row), isTrue, reason: why);
              }
            }
          }
          expect(width, lessThanOrEqualTo(rules.cols[size.name]!));
          expect(height, lessThanOrEqualTo(rules.maxRows[size.name]!));
        }
      }
    }
  });

  test('every plate colour matches bake.mjs plateColor', () {
    final cases = (frames['plateColors'] as List).cast<Map>();
    expect(cases, isNotEmpty);
    var cells = 0;
    for (final f in cases) {
      final d = roster.byId(f['id'] as String)!;
      final rows = daemonPlates.frames(
        d.id,
        PlateSize.values.byName(f['size'] as String),
        f['v'] as String,
        daemonMoodNamed(f['mood'] as String)!,
      )[f['frame'] as int];
      expect(rows, hasLength(f['rows']));
      final bg = f['bg'] as String;
      final ground = Color(0xff000000 | int.parse(bg.substring(1), radix: 16));
      final shiny = f['shiny'] == true;
      final palette = PlatePalette.of(
        roster,
        d,
        rows.length,
        ground: ground,
        shiny: shiny,
      );
      for (final c in (f['cells'] as List).cast<Map>()) {
        final r = c['r'] as int, ch = c['ch'] as String;
        expect(rows[r][c['c'] as int], ch);
        final why = '${d.id} shiny=$shiny r=$r c=${c['c']} $ch';
        expect(
          plateHex(roster, d, rows.length, r, ch, ground: ground, shiny: shiny),
          c['hex'],
          reason: why,
        );
        expect(
          palette.at(r, ch),
          plateColor(
            roster,
            d,
            rows.length,
            r,
            ch,
            ground: ground,
            shiny: shiny,
          ),
          reason: why,
        );
        cells++;
      }
    }
    expect(cells, greaterThan(1000));
    // A space is not drawn; a line-art daemon has no plate colour.
    final tim = roster.byId('tim')!;
    expect(plateHex(roster, tim, 12, 0, ' '), isNull);
    expect(plateHex(roster, roster.byId('tmux')!, 12, 0, '#'), isNull);
    // `#` is the row colour itself: the top row the gradient's top, the last
    // its bottom; `@` burns toward white; a shiny tim is gold.
    expect(plateHex(roster, tim, 12, 0, '#'), tim.gradient!.top);
    expect(plateHex(roster, tim, 12, 11, '#'), tim.gradient!.bottom);
    expect(plateHex(roster, tim, 1, 0, '%'), tim.gradient!.top);
    expect(
      plateHex(roster, tim, 12, 11, '#', shiny: true),
      tim.shinyGradient!.bottom,
    );
    expect(tim.shinyGradient!.bottom, '#d7af00');
  });
}
