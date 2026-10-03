// The zoo: the README's rules (for a guest's local zoo) and the window's half
// of the account zoo, against a scripted harnessd.
import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  final reads = <String>[];
  @override
  Future<String?> read(String key) async {
    reads.add(key);
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// harnessd's `/api/zoo` proxy, scripted: the server's rules applied to a
/// document, a zoo-less daemon (null), or a failure.
class FakeZooTransport implements ZooTransport {
  FakeZooTransport({this.available = true});
  bool available;
  Object? failWith;
  Zoo zoo = Zoo.empty;
  int revision = 0;
  final batches = <List<Map<String, dynamic>>>[];
  int fetches = 0;
  Completer<void>? gate;
  final random = Random(7);

  Map<String, dynamic> get _doc => {'revision': revision, 'zoo': zoo.toJson()};

  @override
  Future<Map<String, dynamic>?> fetch() async {
    fetches++;
    await gate?.future;
    if (failWith != null) throw failWith!;
    return available ? _doc : null;
  }

  @override
  Future<Map<String, dynamic>?> apply(List<Map<String, dynamic>> ops) async {
    await gate?.future;
    if (failWith != null) throw failWith!;
    if (!available) return null;
    batches.add(ops);
    final result = applyZooOps(
      daemonRoster,
      zoo,
      ops,
      random: random,
      now: DateTime.utc(2026, 9, 28, 9, 42),
    );
    zoo = result.zoo;
    revision++;
    return {
      ..._doc,
      'hatched': [
        for (final h in result.hatched)
          {
            'eggId': h.eggId,
            'daemonId': h.daemonId,
            'uid': h.uid,
            'seed': h.seed,
            'shiny': h.shiny,
          },
      ],
    };
  }
}

Map<String, dynamic> habit(String key) => {'op': 'zoo.habit', 'key': key};

void main() {
  final roster = daemonRoster;
  // After drop init's release (2026-09-27): only released drops hatch.
  final now = DateTime.utc(2026, 9, 28);
  ZooOpsResult apply(Zoo zoo, List<Map<String, dynamic>> ops, [int seed = 1]) =>
      applyZooOps(roster, zoo, ops, random: Random(seed), now: now);

  group('rules', () {
    test('the first egg: three habits, a finished turn among them; the '
        'setup egg at six', () {
      var zoo = apply(Zoo.empty, [
        for (final key in ['split', 'find', 'machine', 'split', 'bogus'])
          habit(key),
      ]).zoo;
      expect(zoo.habits, ['split', 'find', 'machine']);
      expect(zoo.eggs, isEmpty, reason: 'no finished turn yet');
      zoo = apply(zoo, [habit('turn')]).zoo;
      expect(zoo.firstEgg, isTrue);
      expect(zoo.eggs.single.kind, 'first');
      zoo = apply(zoo, [habit('store')]).zoo;
      expect(zoo.eggs, hasLength(1));
      zoo = apply(zoo, [habit('resume'), habit('days')]).zoo;
      expect(zoo.setupEgg, isTrue);
      expect(zoo.eggs.map((e) => e.kind), ['first', 'setup']);
      expect(roster.rules.eggs['setup']!.mark, r'$');
      zoo = apply(zoo, [habit('elsewhere')]).zoo;
      expect(zoo.eggs, hasLength(2), reason: 'each once');
    });

    test('a hatch draws, removes the egg and pairs the first; the pity counts '
        'only eggs that can hold a secret', () {
      var zoo = apply(Zoo.empty, [
        for (final key in ['turn', 'split', 'find']) habit(key),
      ]).zoo;
      final egg = zoo.eggs.single;
      final result = apply(zoo, [
        {'op': 'zoo.hatch', 'eggId': egg.id},
        {'op': 'zoo.hatch', 'eggId': egg.id},
      ]);
      zoo = result.zoo;
      expect(result.hatched, hasLength(1), reason: 'a missing egg is dropped');
      expect(zoo.eggs, isEmpty);
      final d = zoo.daemons.single;
      expect(d.id, result.hatched.single.daemonId);
      expect(zoo.pair, d.uid);
      expect(
        [d.version, d.egg, d.origin, d.serial],
        ['0.1', 'first', 'local', null],
      );
      expect(zoo.pity, 0, reason: 'a first egg can never be beastie');
      final night = apply(
        zoo.copyWith(
          eggs: const [ZooEgg(id: 'n1', kind: 'night', grantedAt: '')],
        ),
        [
          {'op': 'zoo.hatch', 'eggId': 'n1'},
        ],
      );
      expect(
        night.zoo.pity,
        night.hatched.single.daemonId == 'beastie' ? 0 : 1,
      );
    });

    test('the first four are new; secrets only from night and easter eggs', () {
      var zoo = Zoo.empty;
      final random = Random(3);
      final seen = <String>[];
      final regulars = [
        for (final d in roster.released(now))
          if (!d.secret) d.id,
      ];
      for (var i = 0; i < 4; i++) {
        final id = drawDaemon(roster, zoo, 'marathon', random, now: now)!;
        expect(zoo.owns(id), isFalse);
        seen.add(id);
        zoo = zoo.copyWith(
          daemons: [
            ...zoo.daemons,
            ZooDaemon(id: id, hatched: '', egg: 'marathon'),
          ],
        );
      }
      expect(seen.toSet(), hasLength(4));
      expect(seen, isNot(contains('beastie')));
      // Every regular owned: duplicates again, still never beastie from a
      // marathon egg; a night egg can still give it.
      for (var i = 0; i < 200; i++) {
        expect(
          drawDaemon(roster, zoo, 'marathon', random, now: now),
          isNot('beastie'),
        );
      }
      expect(drawWeights(roster, zoo, 'night', now: now).map((w) => w.$1.id), [
        ...regulars,
        'beastie',
      ]);
      expect(
        drawWeights(
          roster,
          Zoo.empty,
          'first',
          now: now,
        ).where((w) => w.$1.secret),
        isEmpty,
      );
      // Before drop 1's release nothing hatches.
      expect(
        drawDaemon(
          roster,
          Zoo.empty,
          'first',
          random,
          now: DateTime.utc(2026, 9, 20),
        ),
        isNull,
      );
    });

    test('odds follow the egg weights; the first egg leans toward tim', () {
      final random = Random(11);
      final counts = <String, int>{};
      final ids = <String, int>{};
      const draws = 20000;
      for (var i = 0; i < draws; i++) {
        final id = drawDaemon(roster, Zoo.empty, 'first', random, now: now)!;
        final rarity = roster.byId(id)!.rarity;
        counts[rarity] = (counts[rarity] ?? 0) + 1;
        ids[id] = (ids[id] ?? 0) + 1;
      }
      // Commons 60 (tim x4 of four), rare 27, legendary 12: of 144.
      expect(ids['tim']! / draws, closeTo(60 / 144, .02));
      expect(counts['rare']! / draws, closeTo(27 / 144, .015));
      expect(counts['legendary']! / draws, closeTo(12 / 144, .01));
      expect(counts['secret'], isNull);
      // A night egg boosts bug fourfold among the rares.
      final night = <String, int>{};
      for (var i = 0; i < draws; i++) {
        final id = drawDaemon(roster, Zoo.empty, 'night', random, now: now)!;
        night[id] = (night[id] ?? 0) + 1;
      }
      expect(night['bug']! / night['yak']!, closeTo(4, .6));
      // Only drop init hatches: unix and tty are on hold.
      expect(
        {...ids.keys, ...night.keys}.map((id) => roster.byId(id)!.drop).toSet(),
        {'init'},
      );
    });

    test('pity raises the secret; the eighth egg that could hold it is it', () {
      final random = Random(5);
      var secret = 0;
      for (var i = 0; i < 4000; i++) {
        if (drawDaemon(
              roster,
              const Zoo(pity: 5),
              'easter',
              random,
              now: now,
            ) ==
            'beastie') {
          secret++;
        }
      }
      // (10 + 5) against 90 of legendaries.
      expect(secret / 4000, closeTo(15 / 105, .03));
      expect(
        drawWeights(
          roster,
          Zoo(pity: roster.rules.secretGuaranteeAt - 1),
          'night',
          now: now,
        ).map((w) => w.$1.id),
        ['beastie'],
      );
    });

    test('a same-species hatch is a separate individual, without merge xp', () {
      final regulars = [
        for (final d in roster.released(now))
          if (!d.secret) d.id,
      ];
      final zoo = Zoo(
        daemons: [
          for (final id in regulars)
            ZooDaemon(id: id, hatched: '', egg: 'turn'),
        ],
        pair: legacyZooUid('tim'),
        eggs: const [ZooEgg(id: 't1', kind: 'turn', grantedAt: '')],
      );
      final r = apply(zoo, [
        {'op': 'zoo.hatch', 'eggId': 't1'},
      ]);
      final hatch = r.hatched.single;
      final born = r.zoo.byUid(hatch.uid)!;
      expect(hatch.duplicate, isFalse);
      expect(r.zoo.daemons, hasLength(regulars.length + 1));
      expect(born.id, hatch.daemonId);
      expect(born.seed, inInclusiveRange(1, 0xffffffff));
      expect(born.seed, hatch.seed);
      expect(born.uid, matches(RegExp(r'^[a-f0-9]{24}$')));
      expect(born.uid, isNot(legacyZooUid(born.id)));
      expect(born.xp, 0);
      expect(r.levelUps, isEmpty);
      expect(r.zoo.pair, zoo.pair);
      expect(
        r.zoo.daemons.take(regulars.length).map((d) => d.xp),
        everyElement(0),
      );
      expect(
        Zoo.fromJson(r.zoo.toJson(), roster).daemons,
        hasLength(regulars.length + 1),
      );
    });

    test('eight repeated species make the next hatch new', () {
      final zoo = Zoo(
        daemons: [
          for (var i = 0; i < 9; i++)
            ZooDaemon(
              uid: 'individual-$i',
              id: 'tim',
              hatched: '',
              egg: 'turn',
            ),
        ],
      );
      expect(zoo.hatchesWithoutNew, 8);
      final weights = drawWeights(roster, zoo, 'turn', now: now);
      expect(weights, isNotEmpty);
      expect(weights.map((w) => w.$1.id), isNot(contains('tim')));
      final earlier = zoo.copyWith(daemons: zoo.daemons.take(8).toList());
      expect(
        drawWeights(roster, earlier, 'turn', now: now).map((w) => w.$1.id),
        contains('tim'),
      );
    });

    test('pair, nickname, easter and seed follow the rules', () {
      var zoo = Zoo(
        daemons: [
          ZooDaemon(id: 'tim', hatched: '', egg: 'first'),
          ZooDaemon(id: 'gnu', hatched: '', egg: 'turn'),
        ],
        pair: legacyZooUid('tim'),
      );
      zoo = apply(zoo, [
        {'op': 'zoo.pair', 'uid': legacyZooUid('tux')},
        {'op': 'zoo.pair', 'uid': legacyZooUid('gnu')},
        {'op': 'zoo.nickname', 'uid': legacyZooUid('gnu'), 'name': 'x' * 25},
        {'op': 'zoo.nickname', 'uid': legacyZooUid('gnu'), 'name': 'café'},
        {'op': 'zoo.nickname', 'uid': legacyZooUid('tim'), 'name': ' Pip '},
        {'op': 'zoo.easter', 'word': 'plugh'},
        {'op': 'zoo.easter', 'word': ' XYZZY '},
        {'op': 'zoo.easter', 'word': 'xyzzy'},
      ]).zoo;
      expect(zoo.pair, legacyZooUid('gnu'));
      expect(zoo.daemons[1].name, isNull);
      expect(zoo.daemons[0].name, 'Pip');
      expect(zoo.eggs.single.kind, 'easter');
      // Words never ship: the zoo keeps the hash, as the roster lists it.
      expect(zoo.easter, [easterHash('xyzzy')]);
      expect(roster.rules.easterHashes, contains(easterHash('xyzzy')));
      expect(
        Zoo.fromJson({
          'easter': ['xyzzy'],
        }, roster).easter,
        [easterHash('xyzzy')],
        reason: 'a word stored before hashing reads as its hash',
      );
      zoo = apply(zoo, [
        {'op': 'zoo.nickname', 'uid': legacyZooUid('tim'), 'name': null},
      ]).zoo;
      expect(zoo.daemons[0].name, isNull);
      // Seed applies only to an empty zoo.
      final seeded = apply(Zoo.empty, [
        {
          'op': 'zoo.seed',
          'zoo': {
            ...zoo.toJson(),
            'daemons': [
              for (final d in zoo.daemons) {...d.toJson(), 'serial': 7},
            ],
          },
        },
      ]).zoo;
      // A guest's daemons are local and carry no serial.
      expect(seeded.daemons.map((d) => (d.origin, d.serial)), [
        ('local', null),
        ('local', null),
      ]);
      zoo = zoo.copyWith(
        daemons: [for (final d in zoo.daemons) d.copyWith(origin: 'local')],
      );
      expect(seeded.toJson(), zoo.toJson());
      expect(
        apply(seeded, [
          {'op': 'zoo.seed', 'zoo': Zoo.empty.toJson()},
        ]).zoo.toJson(),
        zoo.toJson(),
      );
    });

    test('the autonomy dial: four levels, watch by default, unknown '
        'dropped, carried by a seed', () {
      expect(zooAutonomyLevels, [
        'watch',
        'suggest',
        'act-on-key',
        'act-within-rules',
      ]);
      expect(Zoo.empty.autonomy, 'watch');
      expect(Zoo.fromJson({'autonomy': 'yolo'}, roster).autonomy, 'watch');
      var zoo = apply(Zoo.empty, [
        {'op': 'zoo.autonomy', 'level': 'act-on-key'},
        {'op': 'zoo.autonomy', 'level': 'bypass'},
      ]).zoo;
      expect(zoo.autonomy, 'act-on-key');
      expect(Zoo.fromJson(zoo.toJson(), roster).autonomy, 'act-on-key');
      // A guest's dial goes with its seed; a seed without one keeps the
      // account's.
      zoo = apply(Zoo.empty, [
        {
          'op': 'zoo.seed',
          'zoo': Zoo(habits: ['turn'], autonomy: 'suggest').toJson(),
        },
      ]).zoo;
      expect(zoo.autonomy, 'suggest');
      zoo = apply(const Zoo(autonomy: 'act-within-rules'), [
        {
          'op': 'zoo.seed',
          'zoo': {
            'habits': ['turn'],
          },
        },
      ]).zoo;
      expect(zoo.autonomy, 'act-within-rules');
    });

    test('consent: never asked is null; a yes starts the dial at watch; a '
        'seed never carries it', () {
      expect(Zoo.empty.consent, isNull);
      expect(Zoo.empty.watching, isFalse);
      var zoo = apply(const Zoo(autonomy: 'act-on-key'), [
        {'op': 'zoo.consent', 'watching': true},
        {'op': 'zoo.consent', 'watching': 'yes'},
      ]).zoo;
      expect(zoo.watching, isTrue);
      expect(zoo.autonomy, 'watch', reason: 'suggest is a second step');
      expect(zoo.consent!.at, startsWith('2026-09-28T'));
      final read = Zoo.fromJson(zoo.toJson(), roster);
      expect(read.consent!.watching, isTrue);
      expect(read.consent!.at, zoo.consent!.at);
      zoo = apply(zoo.copyWith(autonomy: 'suggest'), [
        {'op': 'zoo.consent', 'watching': false},
      ]).zoo;
      expect(zoo.watching, isFalse);
      expect(zoo.consent, isNotNull, reason: 'answered: no');
      expect(zoo.autonomy, 'suggest', reason: 'a no leaves the dial');
      expect(
        Zoo.fromJson({
          'consent': {'watching': 'yes', 'at': 1},
        }, roster).consent,
        isNull,
      );
      // A guest's answer stays the guest's: the account asks its own.
      zoo = apply(Zoo.empty, [
        {
          'op': 'zoo.seed',
          'zoo': {
            'habits': ['turn'],
            'consent': {'watching': true, 'at': '2026-09-01T00:00:00Z'},
          },
        },
      ]).zoo;
      expect(zoo.consent, isNull);
    });

    test('unknown daemons, eggs and habits are dropped on read', () {
      final zoo = Zoo.fromJson({
        'daemons': [
          {'id': 'tim', 'hatchedAt': '2026-09-26', 'egg': 'first'},
          {'id': 'clippy', 'hatchedAt': '2026-09-26', 'egg': 'first'},
        ],
        'eggs': [
          {'id': 'e1', 'kind': 'week', 'grantedAt': ''},
          {'id': 'e2', 'kind': 'mystery', 'grantedAt': ''},
        ],
        'pair': 'clippy',
        'habits': ['turn', 'turn', 'fly'],
      }, roster);
      expect(zoo.daemons.map((d) => d.id), ['tim']);
      expect(zoo.eggs.map((e) => e.id), ['e1']);
      expect(zoo.pair, isNull);
      expect(zoo.paired?.id, 'tim');
      expect(zoo.habits, ['turn']);
    });
  });

  group('earning eggs and growing (the server rules, for a guest)', () {
    var batch = 0;
    Map<String, dynamic> turn(
      String day,
      int n, {
      int hour = 12,
      String machine = 'm1',
      int? away,
      int? minutes,
    }) => {
      'op': 'zoo.turn',
      'batchId': 'b${++batch}',
      'n': n,
      'minutes': ?minutes,
      'away': ?away,
      'day': day,
      'hour': hour,
      'machineId': machine,
    };
    DateTime noon(String day) => DateTime.parse('${day}T12:00:00Z');
    ({Zoo zoo, List<ZooGrant> grants, List<ZooLevelUp> levelUps}) play(
      Zoo start,
      List<Map<String, dynamic>> ops,
    ) {
      var zoo = start;
      final grants = <ZooGrant>[];
      final levelUps = <ZooLevelUp>[];
      for (final op in ops) {
        final r = applyZooOps(
          roster,
          zoo,
          [op],
          random: Random(3),
          now: noon(op['day'] as String),
        );
        zoo = r.zoo;
        grants.addAll(r.grants);
        levelUps.addAll(r.levelUps);
      }
      return (zoo: zoo, grants: grants, levelUps: levelUps);
    }

    final tim = Zoo(
      daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
      pair: legacyZooUid('tim'),
    );

    test('the roster carries the earn and bond rules', () {
      final earn = roster.rules.earn;
      expect(
        [earn.turnEvery, earn.dailyCap, earn.weekDays, earn.marathonTurns],
        [40, 20, 3, 500],
      );
      expect(roster.rules.bondLevels, [0, 50, 150, 300, 600]);
      expect(roster.rules.historyDates.keys, [
        '04-01',
        '08-25',
        '09-09',
        '09-27',
        '10-31',
      ]);
      expect(roster.rules.eggs['history']!.mark, '#');
      expect(
        [
          earn.minutesPerTurn,
          earn.nightFrom,
          earn.nightTo,
          earn.awayMinutes,
          earn.historyDays,
        ],
        [10, 22, 6, 30, 7],
      );
      expect(
        [
          roster.rules.firstEggNeed,
          roster.rules.setupEggNeed,
          roster.rules.secretGuaranteeAt,
          roster.rules.duplicateXp,
          roster.rules.overflowXp,
        ],
        [3, 6, 8, 150, 50],
      );
      expect(roster.rules.firstEggRequire, ['turn']);
    });

    test(
      'at most 20 turns count a local day; a replayed batch counts once',
      () {
        final replay = turn('2026-09-21', 3);
        final r = play(Zoo.empty, [
          turn('2026-09-21', 15),
          turn('2026-09-21', 4, machine: 'm2'),
          turn('2026-09-21', 10),
          replay,
          replay,
        ]);
        expect(r.zoo.progress.days, {'2026-09-21': 20});
        expect(r.zoo.progress.turns, 20);
        expect(r.zoo.progress.batches, hasLength(3));
      },
    );

    test('a turn egg every 40 counted turns, a week egg at 3 days', () {
      final r = play(Zoo.empty, [
        turn('2026-09-21', 20),
        turn('2026-09-22', 20),
        turn('2026-09-23', 1),
      ]);
      expect(r.grants.map((g) => g.kind), ['turn', 'week']);
      expect(r.zoo.eggs.map((e) => e.kind), ['turn', 'week']);
      expect(r.zoo.progress.weeks, [isoWeek('2026-09-23')]);
    });

    test(
      'a second machine earns a marathon egg once; nights earn a night egg',
      () {
        final r = play(Zoo.empty, [
          turn('2026-09-21', 1, hour: 23, away: 1, machine: 'a'),
          // 02:00 on the 22nd is still the night of the 21st.
          turn('2026-09-22', 1, hour: 2, away: 1, machine: 'b'),
          // At the desk at night: not an away turn.
          turn('2026-09-22', 1, hour: 23, machine: 'c'),
          turn('2026-09-23', 1, hour: 22, away: 1),
          turn('2026-09-24', 2, hour: 22, away: 1),
        ]);
        // Three days of one ISO week earn its week egg on the way.
        expect(r.grants.map((g) => g.kind), ['marathon', 'week', 'night']);
        expect(r.zoo.progress.machines, ['a', 'b']);
        expect(r.zoo.progress.nights, isEmpty);
        expect(nightOf(roster, '2026-09-22', 2), '2026-09-21');
        expect(nightOf(roster, '2026-09-22', 12), isNull);
      },
    );

    test('a history date gives a dated egg all its week; long turns count '
        'more', () {
      final r = play(Zoo.empty, [turn('2026-09-12', 1)]);
      expect(r.zoo.eggs.single.kind, 'history');
      expect(r.zoo.eggs.single.date, '2026-09-09', reason: 'the date it keeps');
      expect(historyDatesOpen(roster, '2026-09-15'), ['2026-09-09']);
      expect(historyDatesOpen(roster, '2026-09-16'), isEmpty);
      expect(play(Zoo.empty, [turn('2026-09-13', 1)]).zoo.eggs, hasLength(1));
      final hatched = applyZooOps(
        roster,
        r.zoo,
        [
          {'op': 'zoo.hatch', 'eggId': r.zoo.eggs.single.id},
        ],
        random: Random(1),
        now: noon('2026-09-27'),
      );
      // Every 10 agent-minutes is one more counted turn.
      expect(
        play(Zoo.empty, [
          turn('2026-09-21', 1, minutes: 25),
        ]).zoo.progress.turns,
        3,
      );
      // No drop holds the moth yet: the usual pool.
      expect(hatched.zoo.daemons.single.egg, 'history');
    });

    test('the pair grows by xp: levels, versions, level-ups', () {
      final r = play(tim, [
        turn('2026-09-21', 20),
        turn('2026-09-22', 20),
        turn('2026-09-23', 20),
      ]);
      // 3 days x (20 + 5) = 75 xp: level 1, still 0.1.
      expect(r.zoo.daemons.single.xp, 75);
      expect(r.zoo.daemons.single.bond, 1);
      expect(r.zoo.daemons.single.version, '0.1');
      expect(r.levelUps, [
        (uid: legacyZooUid('tim'), id: 'tim', level: 1, version: '0.1'),
      ]);
      final more = play(r.zoo, [
        for (var d = 24; d <= 27; d++) turn('2026-09-$d', 20),
      ]);
      expect(more.zoo.daemons.single.xp, 175);
      expect(more.zoo.daemons.single.version, '1.0');
      expect(more.levelUps.single.version, '1.0');
      // Nothing is earned without a pair.
      expect(play(Zoo.empty, [turn('2026-09-21', 5)]).levelUps, isEmpty);
    });

    test('a full nest holds earned eggs and lets them in after a hatch', () {
      final full = Zoo(
        daemons: tim.daemons,
        pair: legacyZooUid('tim'),
        eggs: [
          for (var i = 0; i < Zoo.maxEggs; i++)
            ZooEgg(id: 'e$i', kind: 'turn', grantedAt: ''),
        ],
        progress: const ZooProgress(turns: 39),
      );
      final r = play(full, [turn('2026-09-21', 1)]);
      expect(r.zoo.eggs, hasLength(Zoo.maxEggs));
      expect(r.zoo.progress.held, [('turn', null)]);
      final hatched = applyZooOps(
        roster,
        r.zoo,
        [
          {'op': 'zoo.hatch', 'eggId': 'e0'},
        ],
        random: Random(2),
        now: noon('2026-09-27'),
      );
      expect(hatched.zoo.eggs, hasLength(Zoo.maxEggs));
      expect(hatched.zoo.progress.held, isEmpty);
      expect(hatched.grants.single.kind, 'turn');
      // The first egg waits for room too, and so does an easter word.
      final waiting = applyZooOps(
        roster,
        full.copyWith(habits: ['turn', 'split']),
        [
          {'op': 'zoo.habit', 'key': 'store'},
          {'op': 'zoo.easter', 'word': 'xyzzy'},
        ],
        random: Random(2),
        now: noon('2026-09-21'),
      ).zoo;
      expect(waiting.firstEgg, isFalse);
      expect(waiting.easter, isEmpty);
    });

    test('past 64 held, an earned egg is xp for the pair', () {
      final r = play(
        Zoo(
          daemons: tim.daemons,
          pair: legacyZooUid('tim'),
          eggs: [
            for (var i = 0; i < Zoo.maxEggs; i++)
              ZooEgg(id: 'e$i', kind: 'turn', grantedAt: ''),
          ],
          progress: ZooProgress(
            turns: 39,
            held: [
              for (var i = 0; i < ZooProgress.maxHeld; i++) ('turn', null),
            ],
          ),
        ),
        [turn('2026-09-21', 1)],
      );
      expect(r.grants.single, (kind: 'turn', eggId: null, xp: 50));
      expect(r.zoo.daemons.single.xp, 1 + 5 + 50);
      expect(r.zoo.progress.held, hasLength(ZooProgress.maxHeld));
    });

    test('a day that cannot be today anywhere is dropped', () {
      final now = DateTime.parse('2026-09-26T12:00:00Z');
      bool accepted(String day) =>
          applyZooOps(
            roster,
            Zoo.empty,
            [turn(day, 1)],
            random: Random(1),
            now: now,
          ).zoo.progress.turns ==
          1;
      expect(
        ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map(accepted),
        everyElement(isTrue),
      );
      expect(
        ['2026-09-23', '2026-09-28', '2025-09-26'].map(accepted),
        everyElement(isFalse),
      );
    });

    test('ISO weeks match the server', () {
      expect(isoWeek('2027-01-01'), '2026-W53');
      expect(isoWeek('2024-12-30'), '2025-W01');
      expect(isoWeek('2026-09-26'), '2026-W39');
    });

    test('a stored daemon without xp reads the least xp its bond needs', () {
      final zoo = Zoo.fromJson({
        'daemons': [
          {'id': 'tim', 'hatchedAt': '', 'egg': 'first', 'bond': 2},
        ],
      }, roster);
      expect(zoo.daemons.single.xp, 150);
      expect(zoo.daemons.single.version, '1.0');
    });
  });

  group('controller', () {
    late _Memory storage;
    setUp(() => storage = _Memory());

    ZooController controller() => ZooController(
      storage: storage,
      random: Random(2),
      now: () => DateTime(2026, 9, 28, 9, 42),
    );

    test(
      'nothing is shown until a scope is known and the zoo is read',
      () async {
        final remote = FakeZooTransport()..gate = Completer();
        final zoo = controller();
        addTearDown(zoo.dispose);
        zoo.bind(null);
        expect(zoo.loaded, isFalse);
        zoo.bind('account:u1', remote: remote);
        await pumpEventQueue();
        expect(
          zoo.loaded,
          isFalse,
          reason: 'the first read is still in flight',
        );
        remote.gate!.complete();
        await pumpEventQueue();
        expect(zoo.loaded, isTrue);
        expect(zoo.isAccount, isTrue);
      },
    );

    test('a guest zoo is local, drawn here and remembered', () async {
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('guest');
      await pumpEventQueue();
      expect(zoo.source, ZooSource.local);
      for (final h in roster.rules.habits.take(5)) {
        zoo.habit(h.key);
      }
      expect(zoo.readyEgg, isNotNull);
      final hatched = await zoo.hatch(zoo.readyEgg!.id);
      expect(hatched, isNotNull);
      expect(zoo.paired?.id, hatched!.daemonId);
      await zoo.flush();
      final again = controller();
      addTearDown(again.dispose);
      again.bind('guest');
      await pumpEventQueue();
      expect(again.paired?.id, hatched.daemonId);
    });

    test('the dial is posted as zoo.autonomy; a guest keeps it', () async {
      final remote = FakeZooTransport();
      final account = controller();
      addTearDown(account.dispose);
      account.bind('account:u1', remote: remote);
      await pumpEventQueue();
      account.autonomy('suggest');
      expect(account.zoo.autonomy, 'suggest', reason: 'shown at once');
      account.autonomy('suggest');
      account.autonomy('nonsense');
      await account.flush();
      expect(remote.batches.single, [
        {'op': 'zoo.autonomy', 'level': 'suggest'},
      ]);
      expect(remote.zoo.autonomy, 'suggest');
      // Consent: shown at once, sent once, the dial back at watch.
      account.consent(watching: true);
      account.consent(watching: true);
      expect(account.zoo.watching, isTrue);
      expect(account.zoo.autonomy, 'watch');
      await account.flush();
      expect(remote.batches.last, [
        {'op': 'zoo.consent', 'watching': true},
      ]);
      expect(remote.zoo.watching, isTrue);

      final guest = controller();
      addTearDown(guest.dispose);
      guest.bind('guest');
      await pumpEventQueue();
      guest.autonomy('act-on-key');
      guest.consent(watching: false);
      await guest.flush();
      final again = controller();
      addTearDown(again.dispose);
      again.bind('guest');
      await pumpEventQueue();
      expect(again.zoo.autonomy, 'act-on-key');
      expect(again.zoo.consent!.watching, isFalse, reason: 'kept locally');
    });

    test('first sign-in seeds the guest zoo once', () async {
      final guest = controller();
      addTearDown(guest.dispose);
      guest.bind('guest');
      await pumpEventQueue();
      guest.habit('turn');
      guest.habit('split');
      await guest.flush();

      final remote = FakeZooTransport();
      final account = controller();
      addTearDown(account.dispose);
      account.bind('account:u1', remote: remote);
      await pumpEventQueue();
      await account.flush();
      expect(remote.batches.single.single['op'], 'zoo.seed');
      expect(account.zoo.habits, ['turn', 'split']);

      final later = controller();
      addTearDown(later.dispose);
      later.bind('account:u2', remote: remote);
      await pumpEventQueue();
      await later.flush();
      expect(remote.batches, hasLength(1), reason: 'sent once');
    });

    test(
      'habits are sent once, optimistically, and the server grants the egg',
      () async {
        final remote = FakeZooTransport();
        final zoo = controller();
        addTearDown(zoo.dispose);
        zoo.bind('account:u1', remote: remote);
        await pumpEventQueue();
        for (final h in roster.rules.habits.take(5)) {
          zoo.habit(h.key);
          zoo.habit(h.key);
        }
        expect(zoo.habitsDone, 5);
        expect(
          zoo.readyEgg,
          isNull,
          reason: 'the egg is the server\'s to grant',
        );
        await zoo.flush();
        expect(
          remote.batches
              .expand((b) => b)
              .where((op) => op['op'] == 'zoo.habit'),
          hasLength(5),
        );
        expect(zoo.readyEgg?.kind, 'first');
        final hatched = await zoo.hatch(zoo.readyEgg!.id);
        expect(hatched?.daemonId, remote.zoo.daemons.single.id);
        expect(zoo.paired?.id, hatched!.daemonId);
        expect(zoo.revision, remote.revision);
      },
    );

    test('two tims are named and paired independently by uid', () async {
      const firstUid = '000000000000000000000001';
      const secondUid = '000000000000000000000002';
      final remote = FakeZooTransport()
        ..zoo = Zoo(
          daemons: [
            ZooDaemon(
              uid: firstUid,
              id: 'tim',
              seed: 17,
              serial: 42,
              hatched: '2026-09-27',
              egg: 'first',
            ),
            ZooDaemon(
              uid: secondUid,
              id: 'tim',
              seed: 42,
              serial: 43,
              hatched: '2026-09-27',
              egg: 'turn',
            ),
          ],
          pair: firstUid,
        );
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('account:u1', remote: remote);
      await pumpEventQueue();
      expect(zoo.nickname(secondUid, ' dot '), isTrue);
      zoo.pair(secondUid);
      await zoo.flush();
      expect(remote.batches.expand((ops) => ops), [
        {'op': 'zoo.nickname', 'uid': secondUid, 'name': 'dot'},
        {'op': 'zoo.pair', 'uid': secondUid},
      ]);
      expect(zoo.paired?.uid, secondUid);
      expect(remote.zoo.byUid(firstUid)?.name, isNull);
      expect(remote.zoo.byUid(secondUid)?.name, 'dot');
      expect(remote.zoo.toJson()['paired'], secondUid);
      expect(zoo.nickname(secondUid, null), isTrue);
      await zoo.flush();
      expect(remote.zoo.byUid(secondUid)?.name, isNull);
    });

    test('zoo_changed refetches only when it is news', () async {
      final remote = FakeZooTransport()..revision = 3;
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('account:u1', remote: remote);
      await pumpEventQueue();
      expect(remote.fetches, 1);
      zoo.pushed(3);
      await pumpEventQueue();
      expect(remote.fetches, 1);
      remote
        ..zoo = Zoo(
          daemons: [ZooDaemon(id: 'tux', hatched: '', egg: 'first')],
          pair: legacyZooUid('tux'),
        )
        ..revision = 4;
      zoo.pushed(4);
      await pumpEventQueue();
      expect(remote.fetches, 2);
      expect(zoo.paired?.id, 'tux');
      // An older answer never replaces a newer one.
      remote
        ..zoo = Zoo.empty
        ..revision = 2;
      zoo.pushed(null);
      await pumpEventQueue();
      expect(zoo.paired?.id, 'tux');
    });

    test(
      'a 404 is off: nothing shown, read or sent; asked again on '
      'zoo_changed, a reconnect or when the answer is six hours old',
      () async {
        var clock = DateTime(2026, 9, 26, 9, 42);
        final remote = FakeZooTransport(available: false);
        final zoo = ZooController(
          storage: storage,
          random: Random(2),
          now: () => clock,
        );
        addTearDown(zoo.dispose);
        zoo.bind('account:u1', remote: remote);
        expect(zoo.daemons, DaemonsSwitch.unknown);
        await pumpEventQueue();
        expect(zoo.daemons, DaemonsSwitch.off);
        expect(zoo.loaded, isFalse);
        expect(zoo.source, ZooSource.none);
        expect(
          storage.reads,
          isEmpty,
          reason: 'nothing local is read while off',
        );
        // Nothing is reported or kept while off.
        zoo.habit('turn');
        zoo.noteDay();
        expect(zoo.easter('xyzzy'), isFalse);
        zoo.recordTurns(3, machineId: 'm');
        await zoo.flush();
        expect(remote.batches, isEmpty);
        expect(storage.values, isEmpty);
        expect(remote.fetches, 1);
        // Not due yet: no request.
        clock = clock.add(const Duration(hours: 5));
        zoo.recheckIfDue();
        await pumpEventQueue();
        expect(remote.fetches, 1);
        clock = clock.add(const Duration(hours: 1));
        zoo.recheckIfDue();
        await pumpEventQueue();
        expect(remote.fetches, 2);
        expect(zoo.daemons, DaemonsSwitch.off);
        // Switched on at the server: zoo_changed (or a reconnect) asks again.
        remote.available = true;
        zoo.pushed(1);
        await pumpEventQueue();
        expect(zoo.daemons, DaemonsSwitch.on);
        expect(zoo.isAccount, isTrue);
        // And off again: a 404 on a write takes everything away at once.
        remote
          ..zoo = Zoo(
            daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
            pair: legacyZooUid('tim'),
          )
          ..revision = 2;
        zoo.pushed(2);
        await pumpEventQueue();
        expect(zoo.paired?.id, 'tim');
        remote.available = false;
        zoo.habit('split');
        await zoo.flush();
        expect(zoo.daemons, DaemonsSwitch.off);
        expect(zoo.paired, isNull);
      },
    );

    test(
      'an account with no way to ask is off; a failed read is not',
      () async {
        final zoo = controller();
        addTearDown(zoo.dispose);
        zoo.bind('account:u1');
        expect(zoo.daemons, DaemonsSwitch.off);
        final remote = FakeZooTransport()..failWith = StateError('502');
        zoo.bind('account:u2', remote: remote);
        await pumpEventQueue();
        expect(zoo.daemons, DaemonsSwitch.unknown, reason: 'a 5xx is not off');
      },
    );

    test(
      'switchOff (DAEMONS_OFF from harnessd) hides everything at once',
      () async {
        final remote = FakeZooTransport()
          ..zoo = Zoo(
            daemons: [ZooDaemon(id: 'gnu', hatched: '', egg: 'first')],
            pair: legacyZooUid('gnu'),
          );
        final zoo = controller();
        addTearDown(zoo.dispose);
        zoo.bind('account:u1', remote: remote);
        await pumpEventQueue();
        expect(zoo.daemons, DaemonsSwitch.on);
        zoo.switchOff();
        expect(zoo.daemons, DaemonsSwitch.off);
        expect(zoo.paired, isNull);
        expect(zoo.loaded, isFalse);
        zoo.refresh();
        await pumpEventQueue();
        expect(zoo.daemons, DaemonsSwitch.on, reason: 'asked again: 200');
      },
    );

    test('a guest is off unless the preview is on; turning it on shows the '
        'local zoo', () async {
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('guest', enabled: false);
      expect(zoo.daemons, DaemonsSwitch.off);
      await pumpEventQueue();
      expect(storage.reads, isEmpty);
      zoo.habit('turn');
      expect(storage.values, isEmpty);
      zoo.bind('guest');
      await pumpEventQueue();
      expect(zoo.daemons, DaemonsSwitch.on);
      expect(zoo.source, ZooSource.local);
      zoo.bind('guest', enabled: false);
      expect(zoo.daemons, DaemonsSwitch.off);
      expect(zoo.loaded, isFalse);
    });

    testWidgets('a failed read retries and stays hidden meanwhile', (
      tester,
    ) async {
      final remote = FakeZooTransport()..failWith = StateError('offline');
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('account:u1', remote: remote);
      await tester.pump();
      expect(zoo.loaded, isFalse);
      remote.failWith = null;
      await tester.pump(const Duration(seconds: 6));
      expect(zoo.loaded, isTrue);
    });

    testWidgets('a failed write is kept and retried', (tester) async {
      final remote = FakeZooTransport();
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('account:u1', remote: remote);
      await tester.pump();
      remote.failWith = StateError('offline');
      zoo.habit('turn');
      await tester.pump();
      expect(remote.batches, isEmpty);
      remote.failWith = null;
      await tester.pump(const Duration(seconds: 6));
      expect(remote.zoo.habits, ['turn']);
    });

    test('days are local dates; the third reports the habit', () async {
      var day = DateTime(2026, 9, 24, 23);
      final zoo = ZooController(storage: storage, now: () => day);
      addTearDown(zoo.dispose);
      zoo.bind('guest');
      await pumpEventQueue();
      zoo.noteDay();
      zoo.noteDay();
      day = DateTime(2026, 9, 25, 1);
      zoo.noteDay();
      expect(zoo.zoo.habits, isEmpty);
      day = DateTime(2026, 9, 27, 8);
      zoo.noteDay();
      expect(zoo.zoo.habits, ['days']);
    });

    test(
      'the arrival hint shows once per scope, before the first hatch',
      () async {
        final zoo = controller();
        addTearDown(zoo.dispose);
        expect(zoo.needsHint, isFalse);
        zoo.bind('guest');
        await pumpEventQueue();
        expect(zoo.needsHint, isTrue);
        expect(zoo.acknowledgeHint(), isTrue);
        expect(zoo.acknowledgeHint(), isFalse);
        await zoo.flush();
        final again = controller();
        addTearDown(again.dispose);
        again.bind('guest');
        await pumpEventQueue();
        expect(again.needsHint, isFalse);
        again.bind('account:u9', remote: FakeZooTransport());
        await pumpEventQueue();
        expect(again.needsHint, isTrue);
      },
    );

    test('the seed goes first at sign-in, before any habit', () async {
      final guest = controller();
      addTearDown(guest.dispose);
      guest.bind('guest');
      await pumpEventQueue();
      guest.habit('turn');
      await guest.flush();

      final remote = FakeZooTransport()..gate = Completer();
      final account = controller();
      addTearDown(account.dispose);
      account.bind('account:u1', remote: remote);
      remote.gate!.complete();
      await pumpEventQueue();
      account.habit('split');
      await account.flush();
      expect(remote.batches.map((b) => b.single['op']), [
        'zoo.seed',
        'zoo.habit',
      ]);
      expect(remote.zoo.habits, ['turn', 'split']);
    });

    test('no seed when the account already holds something', () async {
      final guest = controller();
      addTearDown(guest.dispose);
      guest.bind('guest');
      await pumpEventQueue();
      guest.habit('turn');
      await guest.flush();
      final remote = FakeZooTransport()..zoo = const Zoo(habits: ['store']);
      final account = controller();
      addTearDown(account.dispose);
      account.bind('account:u1', remote: remote);
      await pumpEventQueue();
      await account.flush();
      expect(remote.batches, isEmpty);
    });

    test(
      'new eggs and level-ups are events; reads and seeds are not',
      () async {
        final remote = FakeZooTransport()
          ..zoo = Zoo(
            daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
            pair: legacyZooUid('tim'),
            eggs: [ZooEgg(id: 'old', kind: 'turn', grantedAt: '')],
          )
          ..revision = 1;
        final zoo = controller();
        addTearDown(zoo.dispose);
        final events = <ZooEvent>[];
        zoo.events.listen(events.add);
        zoo.bind('account:u1', remote: remote);
        await pumpEventQueue();
        expect(events, isEmpty, reason: 'the first read is a baseline');
        // Another window's grant and level-up arrive as zoo_changed.
        remote
          ..zoo = remote.zoo.copyWith(
            daemons: [
              ZooDaemon(
                id: 'tim',
                hatched: '',
                egg: 'first',
                xp: 160,
                bond: 2,
                version: '1.0',
              ),
            ],
            eggs: const [
              ZooEgg(id: 'old', kind: 'turn', grantedAt: ''),
              ZooEgg(id: 'new', kind: 'week', grantedAt: ''),
            ],
          )
          ..revision = 2;
        zoo.pushed(2);
        await pumpEventQueue();
        expect(events, hasLength(2));
        expect((events[0] as ZooEggArrived).egg.id, 'new');
        final grew = events[1] as ZooDaemonGrew;
        expect(grew.daemon.version, '1.0');
        expect(grew.versionChanged, isTrue);
      },
    );

    test(
      'fresh hatches celebrate once without pairing or replaying a read',
      () async {
        final remote = FakeZooTransport()
          ..zoo = Zoo(
            daemons: [ZooDaemon(id: 'tim', hatched: '', egg: 'first')],
            pair: legacyZooUid('tim'),
          )
          ..revision = 1;
        final zoo = controller();
        addTearDown(zoo.dispose);
        final events = <ZooEvent>[];
        zoo.events.listen(events.add);
        zoo.bind('account:u1', remote: remote);
        await pumpEventQueue();
        remote
          ..zoo = remote.zoo.copyWith(
            daemons: [
              ...remote.zoo.daemons,
              ZooDaemon(
                id: 'gnu',
                uid: 'fresh_gnu',
                hatched: DateTime(2026, 9, 28, 9, 42).toIso8601String(),
                egg: 'turn',
              ),
            ],
          )
          ..revision = 2;
        zoo.pushed(2);
        await pumpEventQueue();
        expect(
          events.whereType<ZooDaemonHatched>().single.daemon.uid,
          'fresh_gnu',
        );
        expect(zoo.paired!.id, 'tim');
        zoo.pushed(2);
        await pumpEventQueue();
        expect(events.whereType<ZooDaemonHatched>(), hasLength(1));
      },
    );

    test(
      'a guest counts its own turns; an account never sends zoo.turn',
      () async {
        final guest = controller();
        addTearDown(guest.dispose);
        guest.bind('guest');
        await pumpEventQueue();
        guest.recordTurns(3, machineId: 'this mac/1');
        expect(guest.zoo.progress.turns, 3);
        expect(guest.zoo.progress.machines, ['this-mac-1']);

        final remote = FakeZooTransport();
        final account = controller();
        addTearDown(account.dispose);
        account.bind('account:u1', remote: remote);
        await pumpEventQueue();
        await account.flush();
        final before = remote.batches.length;
        account.recordTurns(3, machineId: 'm');
        await account.flush();
        expect(remote.batches.length, before);
        expect(
          remote.batches.expand((b) => b).where((op) => op['op'] == 'zoo.turn'),
          isEmpty,
        );
      },
    );

    test('a new scope forgets the previous account at once', () async {
      final remote = FakeZooTransport()
        ..zoo = Zoo(
          daemons: [ZooDaemon(id: 'gnu', hatched: '', egg: 'first')],
          pair: legacyZooUid('gnu'),
        );
      final zoo = controller();
      addTearDown(zoo.dispose);
      zoo.bind('account:u1', remote: remote);
      await pumpEventQueue();
      expect(zoo.paired?.id, 'gnu');
      zoo.bind('account:u2', remote: FakeZooTransport()..gate = Completer());
      expect(zoo.loaded, isFalse);
      expect(zoo.paired, isNull);
    });
  });
}
