// The backend's zoo routes, answered in memory, for the phone's daemon tests.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/daemons/roster.dart';

/// The real roster with drop 2, `unix`, taken off hold the way it will come
/// back: given dates, announced 2026-10-01 and released 2026-10-15. Only the
/// shelves' drop dates are under test; `unix` has no dates yet.
DaemonRoster rosterWithDropTwo() {
  final raw = jsonDecode(
    File('../daemons/roster.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  raw['drops'] = [
    for (final d in raw['drops'] as List)
      if ((d as Map)['id'] == 'unix')
        {
          'id': 'unix',
          'n': d['n'],
          'name': d['name'],
          'announce': '2026-10-01',
          'release': '2026-10-15',
        }
      else
        d,
  ];
  return DaemonRoster.parse(jsonEncode(raw));
}

/// `routes/zoo.ts`, answered in memory. Hatches always give [nextDaemon],
/// shiny when [nextShiny]: a daemon you do not own takes [nextSerial] (when
/// set), one you own merges in as a duplicate (`lib/zoo.ts`), with the same
/// xp and levels. Every answer carries [grants] too.
class FakeZooBackend {
  int revision = 3;
  Map<String, dynamic> zoo = {
    'daemons': [
      {
        'id': 'tim',
        'hatchedAt': '2026-09-26T09:42:00Z',
        'egg': 'first',
        'xp': 0,
      },
      {
        'id': 'gnu',
        'hatchedAt': '2026-09-27T09:42:00Z',
        'egg': 'turn',
        'xp': 0,
      },
    ],
    'eggs': [
      {'id': 'e1', 'kind': 'turn', 'grantedAt': '2026-09-28T00:00:00Z'},
    ],
    'pair': 'tim',
    'habits': ['turn', 'split'],
    'firstEgg': true,
  };
  String nextDaemon = 'tux';
  bool nextShiny = true;
  int? nextSerial;
  List<Map<String, dynamic>> grants = [];
  static const _levels = [0, 50, 150, 300, 600];
  static const _duplicateXp = 150;
  int reads = 0;
  final written = <Map<String, dynamic>>[];
  bool failWrites = false;

  /// When the server says a `zoo.consent` was answered.
  String consentAt = '2026-09-28T10:05:00Z';
  Completer<void>? holdWrites;

  Map<String, dynamic> get doc => {'revision': revision, 'zoo': zoo};

  Future<Map<String, dynamic>?> read() async {
    reads++;
    return doc;
  }

  Future<Map<String, dynamic>?> write(List<Map<String, dynamic>> ops) async {
    await holdWrites?.future;
    if (failWrites) throw Exception('offline');
    written.addAll(ops);
    final hatched = <Map<String, dynamic>>[];
    final levelUps = <Map<String, dynamic>>[];
    int level(int xp) => _levels.lastIndexWhere((at) => xp >= at);
    for (final op in ops) {
      switch (op['op']) {
        case 'zoo.habit':
          zoo['habits'] = [...zoo['habits'] as List, op['key']];
        case 'zoo.pair':
          zoo['pair'] = op['id'];
        case 'zoo.consent':
          final consent = zoo['consent'] as Map?;
          if (consent?['watching'] == op['watching']) break;
          // A yes starts the dial at watch.
          if (op['watching'] == true) zoo['autonomy'] = 'watch';
          zoo['consent'] = {'watching': op['watching'], 'at': consentAt};
        case 'zoo.hatch':
          zoo['eggs'] = [
            for (final e in zoo['eggs'] as List)
              if ((e as Map)['id'] != op['eggId']) e,
          ];
          final daemons = [
            for (final d in zoo['daemons'] as List? ?? const [])
              Map<String, dynamic>.from(d as Map),
          ];
          final had = daemons.where((d) => d['id'] == nextDaemon).firstOrNull;
          if (had != null) {
            final before = (had['xp'] as int?) ?? 0;
            had['xp'] = before + _duplicateXp;
            had['dupes'] = ((had['dupes'] as int?) ?? 0) + 1;
            if (nextShiny) had['shiny'] = true;
            if (level(had['xp'] as int) > level(before)) {
              final at = level(had['xp'] as int);
              levelUps.add({
                'id': nextDaemon,
                'level': at,
                'version': at >= 4 ? '2.0' : (at >= 2 ? '1.0' : '0.1'),
              });
            }
            zoo['daemons'] = daemons;
            hatched.add({
              'eggId': op['eggId'],
              'daemonId': nextDaemon,
              'shiny': nextShiny,
              'duplicate': true,
              'xp': _duplicateXp,
            });
            break;
          }
          zoo['daemons'] = [
            ...daemons,
            {
              'id': nextDaemon,
              'hatchedAt': '2026-09-28T10:00:00Z',
              'egg': 'turn',
              'shiny': nextShiny,
              'serial': ?nextSerial,
            },
          ];
          hatched.add({
            'eggId': op['eggId'],
            'daemonId': nextDaemon,
            'shiny': nextShiny,
            'serial': ?nextSerial,
          });
      }
    }
    revision++;
    return {...doc, 'hatched': hatched, 'grants': grants, 'levelUps': levelUps};
  }
}

/// The real [ApiClient] with the zoo routes answered by [backend].
class ZooApi extends ApiClient {
  ZooApi(this.backend) : super(config: AppConfig.dev, session: AuthSession());
  final FakeZooBackend backend;
  @override
  Future<Map<String, dynamic>?> zoo() => backend.read();
  @override
  Future<Map<String, dynamic>?> zooOps(List<Map<String, dynamic>> ops) =>
      backend.write(ops);
  // No desk on this backend: the phone then swipes the whole account.
  @override
  Future<Map<String, dynamic>?> desk() async => null;
}
