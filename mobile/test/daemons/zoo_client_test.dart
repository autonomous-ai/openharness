// The phone's zoo client against an in-memory backend: the first read is a
// baseline, `zoo_changed` only fetches news, the phone's own writes show at
// once and survive a failed send, a hatch answers who came out (a duplicate:
// what it merged into), an egg that became xp is xp, a sign-out drops
// everything in flight, and the first-day consent answer goes out once while
// the dial is only read.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';
import 'zoo_fixture.dart';

void main() {
  late FakeZooBackend backend;
  late ZooClient client;
  late List<ZooEvent> events;

  setUp(() {
    backend = FakeZooBackend();
    client = ZooClient(read: backend.read, write: backend.write);
    events = [];
    client.events.listen(events.add);
  });
  tearDown(() => client.dispose());

  Future<void> join() async {
    client.ensure();
    await pumpEventQueue();
  }

  test('nothing is shown until the first read, which is a baseline', () async {
    expect(client.loaded, isFalse);
    expect(client.paired, isNull);
    await join();
    expect(client.loaded, isTrue);
    expect(client.revision, 3);
    expect(client.paired!.id, 'tim');
    expect(client.readyEgg!.id, 'e1');
    expect(client.zoo.ownedIds, ['tim', 'gnu']);
    expect(events, isEmpty);
  });

  test('zoo_changed only fetches a revision the phone has not seen', () async {
    await join();
    final reads = backend.reads;
    // Once per connected machine, at the same revision.
    client.noticeRevision(3);
    client.noticeRevision(3);
    await pumpEventQueue();
    expect(backend.reads, reads);

    backend.revision = 4;
    backend.zoo['eggs'] = [
      ...backend.zoo['eggs'] as List,
      {'id': 'e2', 'kind': 'week', 'grantedAt': '2026-09-29T00:00:00Z'},
    ];
    (backend.zoo['daemons'] as List)[0] = {
      'id': 'tim',
      'hatchedAt': '2026-09-26T09:42:00Z',
      'egg': 'first',
      'xp': 160,
    };
    client.noticeRevision(4);
    client.noticeRevision(4);
    await pumpEventQueue();
    expect(backend.reads, reads + 1);
    expect(client.zoo.eggs.map((e) => e.id), ['e1', 'e2']);
    expect(client.paired!.version, '1.0');
    expect(events.whereType<ZooEggArrived>().single.egg.kind, 'week');
    final grew = events.whereType<ZooDaemonGrew>().single;
    expect(grew.daemon.id, 'tim');
    expect(grew.versionChanged, isTrue);
  });

  test('a pair switch shows at once and is sent once', () async {
    await join();
    client.pair('gnu');
    expect(client.paired!.id, 'gnu');
    await client.settle();
    expect(backend.written, [
      {'op': 'zoo.pair', 'id': 'gnu'},
    ]);
    // Pairing what is already paired, or what is not owned, sends nothing.
    client.pair('gnu');
    client.pair('beastie');
    await client.settle();
    expect(backend.written, hasLength(1));
  });

  test(
    'a write that failed is kept, shown, and sent with the next read',
    () async {
      await join();
      backend.failWrites = true;
      client.habit('elsewhere');
      await client.settle();
      expect(backend.written, isEmpty);
      expect(client.zoo.habits, contains('elsewhere'));

      // A read in between does not undo it.
      backend.failWrites = false;
      await client.refresh();
      await client.settle();
      expect(client.zoo.habits, contains('elsewhere'));
      expect(backend.written, [
        {'op': 'zoo.habit', 'key': 'elsewhere'},
      ]);
      // A habit already recorded is not sent again.
      client.habit('elsewhere');
      client.habit('turn');
      client.habit('not-a-habit');
      await client.settle();
      expect(backend.written, hasLength(1));
    },
  );

  test('hatching answers who came out, and the zoo follows', () async {
    await join();
    final future = client.hatch('e1');
    expect(client.hatchingEgg, 'e1');
    // One hatch at a time.
    expect(await client.hatch('e1'), isNull);
    final hatch = await future;
    expect(hatch!.daemonId, 'tux');
    expect(hatch.shiny, isTrue);
    expect(client.hatchingEgg, isNull);
    expect(client.zoo.eggs, isEmpty);
    expect(client.zoo.ownedIds, ['tim', 'gnu', 'tux']);
    // An egg that is gone opens nothing.
    expect(await client.hatch('e1'), isNull);
  });

  test(
    'a hatch the backend cannot answer leaves the egg in the nest',
    () async {
      await join();
      backend.failWrites = true;
      expect(await client.hatch('e1'), isNull);
      expect(client.readyEgg!.id, 'e1');
      expect(client.hatchingEgg, isNull);
    },
  );

  test('a sign-out drops what is in flight', () async {
    await join();
    backend.holdWrites = Completer<void>();
    final future = client.hatch('e1');
    client.reset();
    expect(client.loaded, isFalse);
    expect(client.zoo.daemons, isEmpty);
    backend.holdWrites!.complete();
    expect(await future, isNull);
    expect(client.loaded, isFalse);
  });

  test('a backend without a zoo leaves the phone without a daemon', () async {
    final none = ZooClient(read: () async => null, write: (_) async => null);
    addTearDown(none.dispose);
    none.ensure();
    await pumpEventQueue();
    expect(none.loaded, isFalse);
  });

  test('the app reads the zoo on zoo_changed and on resume', () async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    app.api = ZooApi(backend);
    app.zoo.ensure();
    await pumpEventQueue();
    expect(app.zoo.paired!.id, 'tim');

    backend.zoo['pair'] = 'gnu';
    backend.revision = 9;
    await app.handleEventForTest('m', {
      'type': 'zoo_changed',
      'payload': {'revision': 9},
    });
    await pumpEventQueue();
    expect(app.zoo.paired!.id, 'gnu');
    expect(app.zoo.revision, 9);

    // Back from a pocket: whatever was pushed while suspended is read now.
    backend.zoo['pair'] = 'tim';
    backend.revision = 10;
    app.status = AppStatus.authenticated;
    app.handleAppResumed();
    await pumpEventQueue();
    expect(app.zoo.paired!.id, 'tim');
  });

  test('the zoo reads economy v2: serials, duplicates, the setup egg', () {
    final zoo = Zoo.fromJson({
      'daemons': [
        {
          'id': 'tim',
          'hatchedAt': '2026-09-26T09:42:00Z',
          'egg': 'first',
          'xp': 60,
          'serial': 42,
          'dupes': 2,
        },
        // A guest's daemon, seeded: never a serial, whatever it claims.
        {
          'id': 'vim',
          'hatchedAt': '2026-09-26T09:42:00Z',
          'egg': 'turn',
          'serial': 7,
          'origin': 'local',
        },
        // A zoo from before duplicates merged: one record per id, the others
        // counted in its dupes, shiny if either was, no xp for them.
        {
          'id': 'fzf',
          'hatchedAt': '2026-09-26T09:42:00Z',
          'egg': 'turn',
          'xp': 10,
        },
        {
          'id': 'fzf',
          'hatchedAt': '2026-09-27T09:42:00Z',
          'egg': 'week',
          'xp': 500,
          'shiny': true,
          'dupes': 1,
        },
      ],
      'eggs': [
        {'id': 's', 'kind': 'setup', 'grantedAt': ''},
      ],
      'firstEgg': true,
      'setupEgg': true,
    }, daemonRoster);
    final tim = zoo.daemon('tim')!, vim = zoo.daemon('vim')!;
    final fzf = zoo.daemon('fzf')!;
    expect(tim.serial, 42);
    expect(tim.dupes, 2);
    expect(tim.count, 3);
    expect(vim.serial, isNull);
    expect(vim.origin, 'local');
    expect(zoo.ownedIds, ['tim', 'vim', 'fzf']);
    expect(fzf.dupes, 2);
    expect(fzf.shiny, isTrue);
    expect(fzf.xp, 10);
    expect(fzf.egg, 'turn');
    // The setup egg is an egg like any other.
    expect(zoo.eggs.single.kind, 'setup');
    expect(zoo.setupEgg, isTrue);
  });

  test('a duplicate answers what it merged into, and the level', () async {
    backend.nextDaemon = 'tim';
    await join();
    final hatch = (await client.hatch('e1'))!;
    expect(hatch.daemonId, 'tim');
    expect(hatch.duplicate, isTrue);
    expect(hatch.xp, daemonRoster.rules.duplicateXp);
    // x2 on the shelf, as the lookbook says it.
    expect(hatch.count, 2);
    expect(hatch.becameShiny, isTrue);
    expect(hatch.serial, isNull);
    // 0 xp + 150: bond 2, the 1.0 release.
    expect(hatch.levelUp!.level, 2);
    expect(hatch.grewVersion, isTrue);
    expect(client.zoo.daemons, hasLength(2));
    expect(client.zoo.daemon('tim')!.dupes, 1);
    expect(client.zoo.daemon('tim')!.version, '1.0');
    // A duplicate never pairs, never takes a place, and grows the one you have.
    expect(client.paired!.id, 'tim');
    expect(events.whereType<ZooDaemonGrew>().single.versionChanged, isTrue);
    expect(events.whereType<ZooEggArrived>(), isEmpty);

    // Not shiny this time, and yours already is: nothing becomes shiny.
    backend.zoo['eggs'] = [
      {'id': 'e2', 'kind': 'turn', 'grantedAt': ''},
    ];
    backend.revision++;
    await client.refresh();
    backend.nextShiny = false;
    final again = (await client.hatch('e2'))!;
    expect(again.count, 3);
    expect(again.becameShiny, isFalse);
    expect(again.shiny, isFalse);
    expect(client.zoo.daemon('tim')!.shiny, isTrue);
    // 300 xp: bond 3, still 1.0.
    expect(again.levelUp!.level, 3);
    expect(again.grewVersion, isFalse);
  });

  test('a new daemon carries its serial', () async {
    backend.nextSerial = 42;
    await join();
    final hatch = (await client.hatch('e1'))!;
    expect(hatch.duplicate, isFalse);
    expect(hatch.serial, 42);
    expect(hatch.count, 1);
    expect(client.zoo.daemon('tux')!.serial, 42);
  });

  test('an egg that became xp is xp, never an egg', () async {
    await join();
    final eggs = client.zoo.eggs.length;
    backend.grants = [
      {'kind': 'turn', 'xp': 50},
    ];
    client.habit('find');
    await client.settle();
    expect(client.zoo.eggs, hasLength(eggs));
    expect(events.whereType<ZooEggArrived>(), isEmpty);
    final grant = events.whereType<ZooXpGranted>().single.grant;
    expect(grant.isXp, isTrue);
    expect(grant.xp, 50);
    expect(client.xpGrants.single.kind, 'turn');
    client.seenXp();
    expect(client.xpGrants, isEmpty);
    // The egg form is an egg: it shows by being in the zoo, not as xp.
    expect(ZooGrant.fromJson({'kind': 'turn', 'eggId': 'x'})!.isXp, isFalse);
    expect(ZooGrant.fromJson({'kind': 'turn'}), isNull);
  });

  test('the zoo reads the dial and the first-day answer', () {
    Zoo read(Map<String, dynamic> extra) =>
        Zoo.fromJson({'daemons': const [], ...extra}, daemonRoster);

    // Never asked: the default dial, no answer.
    final fresh = read(const {});
    expect(fresh.autonomy, 'watch');
    expect(fresh.consent, isNull);
    expect(fresh.watching, isFalse);

    final said = read(const {
      'autonomy': 'act-on-key',
      'consent': {'watching': true, 'at': '2026-09-28T12:00:00Z'},
    });
    expect(said.autonomy, 'act-on-key');
    expect(said.watching, isTrue);
    expect(said.consent!.day, '2026-09-28');

    final no = read(const {
      'consent': {'watching': false, 'at': '2026-09-28T12:00:00Z'},
    });
    expect(no.consent!.watching, isFalse);
    expect(no.watching, isFalse);

    // A level this phone does not know reads as the default; half an answer
    // is no answer.
    expect(read(const {'autonomy': 'yolo'}).autonomy, 'watch');
    for (final consent in [
      {'watching': true},
      {'watching': 'yes', 'at': '2026-09-28T12:00:00Z'},
      {'watching': true, 'at': 'yesterday'},
      'yes',
    ]) {
      expect(read({'consent': consent}).consent, isNull, reason: '$consent');
    }
  });

  test(
    'a consent answer shows at once, is sent once, a yes starts at watch',
    () async {
      backend.zoo['autonomy'] = 'suggest';
      await join();
      expect(client.zoo.autonomy, 'suggest');
      expect(client.zoo.consent, isNull);

      client.consent(watching: true);
      // Shown before the server answers: yes, and the dial back at watch.
      expect(client.zoo.watching, isTrue);
      expect(client.zoo.autonomy, 'watch');
      await client.settle();
      expect(backend.written, [
        {'op': 'zoo.consent', 'watching': true},
      ]);
      // The server's time, once it answered.
      expect(client.zoo.consent!.at, backend.consentAt);

      // The same answer again sends nothing.
      client.consent(watching: true);
      await client.settle();
      expect(backend.written, hasLength(1));

      // Withdrawn: sent, shown, and the dial left where it was.
      backend.zoo['autonomy'] = 'suggest';
      client.consent(watching: false);
      expect(client.zoo.watching, isFalse);
      await client.settle();
      expect(backend.written.last, {'op': 'zoo.consent', 'watching': false});
      expect(client.zoo.consent!.watching, isFalse);
      expect(client.zoo.autonomy, 'suggest');
    },
  );

  test('a consent answer that could not be sent is kept and shown', () async {
    await join();
    backend.failWrites = true;
    client.consent(watching: true);
    await client.settle();
    expect(backend.written, isEmpty);
    // A read in between does not undo it.
    backend.failWrites = false;
    await client.refresh();
    expect(client.zoo.watching, isTrue);
    await client.settle();
    expect(backend.written, [
      {'op': 'zoo.consent', 'watching': true},
    ]);
    expect(client.zoo.watching, isTrue);
  });

  test('nothing is answered before the zoo has been read', () async {
    client.consent(watching: true);
    await client.settle();
    expect(backend.written, isEmpty);
  });
}
