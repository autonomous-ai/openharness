import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_notices.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Dee's iPhone (2026-11-01): the same notice came back every 5 seconds.
/// Each thing a Swarm asks of the person is told once on this phone, however
/// often it is read, however it is read, and across sessions.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Backend backend;
  late _Notices notices;
  late ExperimentalFeaturesStore features;
  late ValueNotifier<String?> account;
  late SwarmHomeCache home;
  late MemoryKeyValueStore store;

  setUp(() async {
    backend = Backend();
    notices = _Notices();
    features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore());
    await features.set(PhoneExperiment.swarm, true);
    account = ValueNotifier(me);
    home = memoryHomeCache();
    store = MemoryKeyValueStore();
  });

  SwarmHost host({bool disposeAtEnd = true}) {
    final h = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: backend.fake.request,
      notices: notices,
      features: features,
      homeCache: home,
      readMarks: store,
    );
    if (disposeAtEnd) addTearDown(h.dispose);
    return h;
  }

  /// One read of the Swarm: through the list (each test moves its last
  /// change, so it is read), or, [watched], as an open chat reads it on its
  /// own every 5 seconds.
  Future<void> poll(SwarmHost h, {bool watched = false}) async {
    final inbox = h.session!.inbox;
    final reader = inbox.reader('a');
    if (watched && reader != null) {
      await reader.refresh();
    } else {
      await inbox.refresh();
    }
    await settle();
  }

  /// What each notice told, by its key, in order.
  List<String> told() => [for (final n in notices.shown) n.key];

  /// Everything a Swarm can ask, arrived after the first read.
  void everything() {
    backend
      ..decision('d1')
      ..mention('t1')
      ..stuck('g1')
      ..needsYou('g2');
  }

  const all = [
    'decision:d1',
    'mention:t1',
    'work:a:g1:attempt-g1:blocked',
    'work:a:g2:attempt-g2:needs_human',
  ];

  test('read again and again, each ask is told once', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    everything();
    for (var i = 0; i < 6; i++) {
      backend.version++;
      await poll(h);
    }
    expect(told()..sort(), [...all]..sort());
  });

  test('read again from nothing on each read, each ask is told once', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    everything();
    backend.reload = true;
    for (var i = 0; i < 6; i++) {
      backend.version++;
      await poll(h);
    }
    expect(told()..sort(), [...all]..sort());
  });

  test(
    'a session made again for the same account tells nothing again',
    () async {
      var h = host();
      h.foreground = false;
      await poll(h);
      everything();
      await poll(h);
      expect(told()..sort(), [...all]..sort());
      for (var i = 0; i < 4; i++) {
        // The account read again: a moment with none, then the same one.
        account.value = null;
        account.value = me;
        h.foreground = false;
        backend.version++;
        await poll(h);
        await poll(h);
      }
      expect(told()..sort(), [...all]..sort());
    },
  );

  test('what leaves a read and comes back at the next is told once', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    everything();
    // Each read is the Swarm read again from nothing, by turns with and
    // without what waits: the 5-second rhythm of Dee's notice.
    backend.reload = true;
    for (var i = 0; i < 8; i++) {
      backend
        ..hidden = i.isOdd
        ..version += 1;
      await poll(h, watched: i % 4 >= 2);
    }
    expect(told()..sort(), [...all]..sort());
    expect(
      notices.cancelled,
      isEmpty,
      reason: 'a need back at every other read stays on the lock screen',
    );
  });

  test(
    'a need gone for two reads in a row has its notice taken down',
    () async {
      final h = host();
      h.foreground = false;
      await poll(h);
      everything();
      await poll(h);
      expect(told()..sort(), [...all]..sort());

      // Answered, tagged done, and the work moved on, all elsewhere.
      backend
        ..decisions = []
        ..mentions = []
        ..groups = [
          groupData('g1', status: 'working'),
          groupData('g2', status: 'working'),
        ]
        ..version += 1;
      await poll(h);
      expect(notices.cancelled, isEmpty, reason: 'one read may miss them');
      backend.version++;
      await poll(h);
      expect(notices.cancelled..sort(), [...all]..sort());
    },
  );

  test('a session made again tells nothing again, even when its first read '
      'misses what waits', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    everything();
    await poll(h);
    expect(told()..sort(), [...all]..sort());
    backend.reload = true;
    for (var i = 0; i < 3; i++) {
      account.value = null;
      account.value = me;
      h.foreground = false;
      backend
        ..hidden = true
        ..version += 1;
      await poll(h);
      backend
        ..hidden = false
        ..version += 1;
      await poll(h);
    }
    expect(told()..sort(), [...all]..sort());
  });

  test('another account starts with nothing told', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    everything();
    await poll(h);
    expect(told(), hasLength(all.length));

    // The same Swarm and asks, for the next account to sign in on this
    // phone: news to them once their first read is done.
    account.value = 'person-other';
    h.foreground = false;
    final kept = [...backend.decisions];
    backend
      ..decisions = []
      ..reload = true
      ..version += 1;
    await poll(h);
    backend
      ..decisions = kept
      ..version += 1;
    await poll(h);
    expect(told().where((k) => k == 'decision:d1'), hasLength(2));
  });

  test('a relaunch tells nothing again of what waits', () async {
    var h = host(disposeAtEnd: false);
    h.foreground = false;
    await poll(h);
    everything();
    await poll(h);
    await homeSaved(home);
    expect(told()..sort(), [...all]..sort());

    // The app closed and opened again: a new host over the same phone.
    h.dispose();
    h = host();
    h.foreground = false;
    for (var i = 0; i < 3; i++) {
      backend.version++;
      await poll(h);
    }
    expect(told()..sort(), [...all]..sort());
  });

  test('turning Swarm off forgets what was told', () async {
    final h = host();
    h.foreground = false;
    await poll(h);
    backend
      ..decision('d1')
      ..version += 1;
    await poll(h);
    expect(told(), ['decision:d1']);

    await features.set(PhoneExperiment.swarm, false);
    await features.set(PhoneExperiment.swarm, true);
    h.foreground = false;
    backend
      ..decisions = []
      ..reload = true
      ..version += 1;
    await poll(h);
    backend
      ..decision('d1')
      ..version += 1;
    await poll(h);
    expect(told(), ['decision:d1', 'decision:d1']);
  });

  test('the record keeps the newest keys, at most its limit', () {
    final record = SwarmTold(limit: 3);
    for (final key in ['a', 'b', 'c', 'd']) {
      expect(record.add(key), isTrue);
    }
    expect(record.length, 3);
    expect(record.add('d'), isFalse, reason: 'newest kept');
    expect(record.add('a'), isTrue, reason: 'oldest let go');
  });
}

class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];
  final cancelled = <String>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);

  @override
  Future<void> cancelSwarm(String key) async => cancelled.add(key);
}

/// Swarm `a`, whose asks and waiting work a test sets as it goes.
class Backend {
  final fake = FakeSwarm();
  var decisions = <Map<String, dynamic>>[];
  var mentions = <Map<String, dynamic>>[];
  var groups = <Map<String, dynamic>>[];
  var reload = false;
  var version = 2;

  /// This read leaves the waiting work and asks out, as one answered another
  /// way does (straight from the backend, or through a computer).
  var hidden = false;

  Map<String, dynamic> get derived => {
    'decisionsWaiting': decisions.length,
    'mentionsWaiting': mentions.length,
  };

  Backend() {
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': version},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/a/parts'] = (_) => firstLoad(
      tabId: 'a',
      derived: hidden ? const {} : derived,
      lastChangedAt: version,
      groups: hidden ? const [] : groups,
    );
    fake.routes['/api/super-tabs/a/changes'] = (_) => reload
        ? {'reload': true}
        : changes(
            cursor: 'c$version',
            derived: derived,
            lastChangedAt: version,
            groups: [
              for (final g in groups) part(g['id'] as String, version, g),
            ],
          );
    fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => {
      'decisions': decisions,
    };
    fake.routes['/api/super-tabs/a/mentions?state=waiting'] = (_) => {
      'mentions': mentions,
    };
  }

  void decision(String id) => decisions = [
    ...decisions,
    {
      'id': id,
      'conversationId': 'g9',
      'askerName': 'River',
      'question': 'Ship it?',
      'options': ['Yes', 'No'],
    },
  ];

  void mention(String id) => mentions = [
    ...mentions,
    {'id': id, 'conversationId': 'g9', 'messageId': 'm-$id'},
  ];

  void stuck(String id) {
    groups = [...groups, groupData(id, status: 'blocked')];
    version++;
  }

  void needsYou(String id) {
    groups = [...groups, groupData(id, status: 'needs_human')];
    version++;
  }
}
