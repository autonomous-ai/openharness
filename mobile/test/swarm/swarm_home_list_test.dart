import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_buddy.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// Swarm Home, direction B (Tony, 2026-10-29): Needs you at the top, then the
/// projects the person pinned on this phone, then the others by their latest
/// activity, those quiet for a day folded under "Other projects".
void main() {
  /// 2026-10-29 10:00 UTC, and [minutes] before it, in epoch milliseconds.
  final now = DateTime.utc(2026, 10, 29, 10);
  int ago(int minutes) =>
      now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
  DateTime at(int ms) => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);

  /// [part] as last changed at [changedAt].
  Map<String, dynamic> changed(Map<String, dynamic> part, int changedAt) => {
    ...part,
    'changedAt': changedAt,
  };

  group('when a chat last changed', () {
    test("is its part's, from the first load and from each change read "
        'after', () async {
      final swarm = FakeSwarm();
      final load = firstLoad(groups: [groupData('g1')]);
      final groups = load['groups'] as List;
      groups[0] = changed(groups[0] as Map<String, dynamic>, ago(90));
      groups[1] = changed(groups[1] as Map<String, dynamic>, ago(30));
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load;
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: swarm.request,
      );
      addTearDown(reader.dispose);

      await reader.refresh();
      expect(reader.snapshot!.conversation(leadChat)!.changedAt, at(ago(90)));
      expect(reader.snapshot!.conversation('g1')!.changedAt, at(ago(30)));

      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c2',
        groups: [
          changed(
            part('g1', 9, groupData('g1', lastMessageSequence: 1)),
            ago(2),
          ),
        ],
      );
      await reader.refresh();
      expect(reader.snapshot!.conversation('g1')!.changedAt, at(ago(2)));
      expect(reader.snapshot!.conversation(leadChat)!.changedAt, at(ago(90)));
    });

    test('a closed chat read later carries its own', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      swarm.routes['/api/super-tabs/$tab/groups?dormant=1'] = (_) => {
        'groups': [
          changed(
            part('old', 3, groupData('old', title: 'Old', dormant: true)),
            ago(3000),
          ),
        ],
        'next': null,
      };
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: swarm.request,
      );
      addTearDown(reader.dispose);
      await reader.refresh();

      await reader.loadDormant(project);

      expect(reader.snapshot!.conversation('old')!.changedAt, at(ago(3000)));
    });

    test('the Home kept keeps it, and a chat without one has none', () {
      final read = SuperTabSnapshot.fromJson({
        ...headData(),
        'people': [person(me)],
        'agents': <Object>[],
        'conversations': [
          groupData(leadChat),
          {...groupData('g1'), 'changedAt': ago(30)},
        ],
      });

      final back = SuperTabSnapshot.fromJson(
        jsonDecode(jsonEncode(swarmHomeSwarm(read, const {}).state))
            as Map<String, dynamic>,
      );

      expect(back.conversation('g1')!.changedAt, at(ago(30)));
      expect(back.conversation(leadChat)!.changedAt, isNull);
    });
  });

  group("a project's latest activity", () {
    SuperTabSnapshot swarmOf(List<Map<String, dynamic>> conversations) =>
        SuperTabSnapshot.fromJson({
          ...headData(
            projects: [
              for (final id in ['p1', 'p2'])
                {
                  'id': id,
                  'name': 'Project $id',
                  'ownerId': me,
                  'leadConversationId': 'lead-$id',
                  'visibility': 'public',
                  'members': <Object>[],
                },
            ],
          ),
          'people': [person(me)],
          'agents': <Object>[],
          'conversations': conversations,
        });

    Map<String, dynamic> chat(
      String id,
      String projectId,
      int? changedAt, {
      List<String>? audience,
    }) => {
      ...groupData(id, audience: audience),
      'projectId': projectId,
      'changedAt': ?changedAt,
    };

    test('is the newest change of its chats; none for a project with no '
        'chat timed', () {
      final snapshot = swarmOf([
        chat('lead-p1', 'p1', ago(60)),
        chat('w1', 'p1', ago(5)),
        chat('w2', 'p1', ago(300)),
        chat('lead-p2', 'p2', null),
      ]);

      final activity = swarmProjectActivity(snapshot, SwarmBuddies.none);

      expect(activity, {'p1': at(ago(5))});
    });

    test("leaves out the person's Buddy chat and a private chat, as a "
        "project's news does", () {
      final snapshot = swarmOf([
        chat('lead-p1', 'p1', ago(600)),
        {...chat('buddy', 'p1', ago(1)), 'kind': 'buddy', 'buddyOwnerId': me},
        chat('private', 'p1', ago(2), audience: [me]),
      ]);

      final activity = swarmProjectActivity(
        snapshot,
        SwarmBuddies.read({
          'agents': <Object>[],
          'conversations': [
            {
              ...chat('buddy', 'p1', ago(1)),
              'kind': 'buddy',
              'buddyOwnerId': me,
            },
          ],
        }, me),
      );

      expect(activity, {'p1': at(ago(600))});
    });
  });

  group("Home's projects", () {
    final mobile = SuperTabProject.fromJson({
      'id': 'mobile',
      'name': 'Mobile',
      'ownerId': me,
      'leadConversationId': 'lead-mobile',
    });
    SwarmHomeProject project(
      String id, {
      int? minutes,
      String swarmId = tab,
      SwarmRowNews news = swarmNoNews,
    }) => SwarmHomeProject(
      swarmId: swarmId,
      project: SuperTabProject.fromJson({
        'id': id,
        'name': 'Project $id',
        'ownerId': me,
        'leadConversationId': 'lead-$id',
      }),
      active: minutes == null ? null : at(ago(minutes)),
      news: news,
    );
    List<String> ids(List<SwarmHomeProject> projects) => [
      for (final p in projects) p.project.id,
    ];

    test('newest first; one with no time known after them, in the order '
        'read, and never folded', () {
      final lists = swarmHomeLists(
        [
          project('a', minutes: 40),
          project('b'),
          project('c', minutes: 2),
          project('d'),
          project('e', minutes: 20),
        ],
        pins: const {},
        now: now,
      );

      expect(ids(lists.pinned), isEmpty);
      expect(ids(lists.recent), ['c', 'e', 'a', 'b', 'd']);
      expect(lists.quiet, isEmpty);
    });

    test('quiet for more than a day: folded under Other projects, newest '
        'first', () {
      final lists = swarmHomeLists(
        [
          project('a', minutes: 60 * 24 + 1),
          project('b', minutes: 60 * 24),
          project('c', minutes: 60 * 72),
          project('d', minutes: 60 * 30),
        ],
        pins: const {},
        now: now,
      );

      expect(ids(lists.recent), ['b']);
      expect(ids(lists.quiet), ['a', 'd', 'c']);
    });

    test('pinned: at the top in a group of their own, newest first, quiet '
        'or not, and out of Projects', () {
      final lists = swarmHomeLists(
        [
          project('a', minutes: 5),
          project('b', minutes: 60 * 48),
          project('c', minutes: 1),
          project('d', minutes: 3),
          project('e', minutes: 60 * 50),
        ],
        pins: {swarmHomeProjectKey(tab, 'b'), swarmHomeProjectKey(tab, 'd')},
        now: now,
      );

      expect(ids(lists.pinned), ['d', 'b']);
      expect(ids(lists.recent), ['c', 'a']);
      expect(ids(lists.quiet), ['e']);
    });

    test('a pin names its Swarm: the same project id in another Swarm is '
        'not pinned', () {
      final lists = swarmHomeLists(
        [project('p', minutes: 5), project('p', minutes: 6, swarmId: 'tab-2')],
        pins: {swarmHomeProjectKey('tab-2', 'p')},
        now: now,
      );

      expect([for (final p in lists.pinned) p.swarmId], ['tab-2']);
      expect([for (final p in lists.recent) p.swarmId], [tab]);
    });

    test('something new in a quiet project keeps it out of the fold', () {
      final lists = swarmHomeLists(
        [
          project('a', minutes: 5),
          project('b', minutes: 60 * 30, news: (bold: false, tags: 1)),
          project('c', minutes: 60 * 31, news: (bold: true, tags: 0)),
          project('d', minutes: 60 * 32),
        ],
        pins: const {},
        now: now,
      );

      expect(ids(lists.recent), ['a', 'b', 'c']);
      expect(ids(lists.quiet), ['d']);
    });

    test('nothing is folded when nothing else would be listed', () {
      final lists = swarmHomeLists(
        [project('a', minutes: 60 * 30), project('b', minutes: 60 * 40)],
        pins: const {},
        now: now,
      );

      expect(ids(lists.recent), ['a', 'b']);
      expect(lists.quiet, isEmpty);

      // A pinned project above is something listed.
      final pinned = swarmHomeLists(
        [
          project('a', minutes: 60 * 30),
          project('b', minutes: 60 * 40),
          project('c', minutes: 60 * 50),
        ],
        pins: {swarmHomeProjectKey(tab, 'c')},
        now: now,
      );
      expect(ids(pinned.recent), isEmpty);
      expect(ids(pinned.quiet), ['a', 'b']);
    });

    test('keys a project by its Swarm and its id', () {
      expect(
        SwarmHomeProject(swarmId: 's', project: mobile).key,
        swarmHomeProjectKey('s', 'mobile'),
      );
      expect(
        swarmHomeProjectKey('s', 'mobile'),
        isNot(swarmHomeProjectKey('t', 'mobile')),
      );
    });
  });

  group("what the person chose for Home, kept on this phone", () {
    const key = 'swarm_home.$me';

    Future<SwarmHomePrefs> prefs(MemoryKeyValueStore store) async {
      final prefs = SwarmHomePrefs(accountId: me, store: store);
      addTearDown(prefs.dispose);
      await settle();
      return prefs;
    }

    test('a pin is kept, and read back by the next start', () async {
      final store = MemoryKeyValueStore();
      final first = await prefs(store);
      var told = 0;
      first.addListener(() => told++);

      first.pin(tab, 'p1', true);
      first.pin(tab, 'p2', true);
      first.pin(tab, 'p1', false);
      await settle();

      expect(told, 3);
      expect(first.pinned(tab, 'p2'), isTrue);
      expect(first.pinned(tab, 'p1'), isFalse);
      final again = await prefs(store);
      expect(again.pins, {swarmHomeProjectKey(tab, 'p2')});
    });

    test('keeps ids only, nothing read of a Swarm', () async {
      final store = MemoryKeyValueStore();
      final prefs0 = await prefs(store);

      prefs0
        ..pin(tab, 'p1', true)
        ..show(tab);
      await settle();

      expect(jsonDecode(store.values[key]!), {
        'pins': [swarmHomeProjectKey(tab, 'p1')],
        'swarm': tab,
      });
    });

    test('keeps at most a bound of pins, the oldest going first', () async {
      final store = MemoryKeyValueStore();
      final prefs0 = await prefs(store);

      for (var i = 0; i < SwarmHomePrefs.keptPins + 3; i++) {
        prefs0.pin(tab, 'p$i', true);
      }
      await settle();

      expect(prefs0.pins, hasLength(SwarmHomePrefs.keptPins));
      expect(prefs0.pinned(tab, 'p0'), isFalse);
      expect(prefs0.pinned(tab, 'p${SwarmHomePrefs.keptPins + 2}'), isTrue);
    });

    test('the one Swarm Home shows is kept; none shows them all', () async {
      final store = MemoryKeyValueStore();
      final first = await prefs(store);

      first.show('tab-2');
      await settle();
      expect((await prefs(store)).swarmId, 'tab-2');

      first.show(null);
      await settle();
      expect((await prefs(store)).swarmId, isNull);
    });

    test('a Swarm the account no longer has: its pins and its choice go, '
        'from the phone too', () async {
      final store = MemoryKeyValueStore();
      final prefs0 = await prefs(store);
      prefs0
        ..pin(tab, 'p1', true)
        ..pin('tab-2', 'p1', true)
        ..show('tab-2');
      await settle();

      prefs0.keepOnly({tab});
      await settle();

      expect(prefs0.pins, {swarmHomeProjectKey(tab, 'p1')});
      expect(prefs0.swarmId, isNull);
      expect(jsonDecode(store.values[key]!), {
        'pins': [swarmHomeProjectKey(tab, 'p1')],
      });
    });

    test('what is chosen before the phone has read its choices back is not '
        'lost', () async {
      final store = _SlowStore()
        ..values[key] = jsonEncode({
          'pins': [swarmHomeProjectKey(tab, 'old')],
        });
      final prefs0 = SwarmHomePrefs(accountId: me, store: store);
      addTearDown(prefs0.dispose);

      prefs0.pin(tab, 'new', true);
      store.answer();
      await settle();

      expect(prefs0.pins, {
        swarmHomeProjectKey(tab, 'old'),
        swarmHomeProjectKey(tab, 'new'),
      });
    });

    test('another account reads none of them', () async {
      final store = MemoryKeyValueStore();
      (await prefs(store)).pin(tab, 'p1', true);
      await settle();

      final other = SwarmHomePrefs(accountId: 'someone-else', store: store);
      addTearDown(other.dispose);
      await settle();

      expect(other.pins, isEmpty);
    });

    test('a damaged record reads as nothing chosen', () async {
      final store = MemoryKeyValueStore()..values[key] = '{"pins": 4';

      expect((await prefs(store)).pins, isEmpty);
    });
  });
}

/// A store whose reads answer only when told.
class _SlowStore extends MemoryKeyValueStore {
  final _pending = <(String, Completer<String?>)>[];

  @override
  Future<String?> read(String key) {
    final answer = Completer<String?>();
    _pending.add((key, answer));
    return answer.future;
  }

  void answer() {
    for (final (key, answer) in _pending) {
      answer.complete(values[key]);
    }
    _pending.clear();
  }
}
