import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_home_view.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_task_status.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The task status line on the phone's work rows (#2125, the mockup Tony
/// approved 10-29): after its agent's name under each task's name, on the
/// project's Tasks tab and on its sheet's work. Over a scripted backend: one
/// Swarm, project Mobile, where Nova waits on Tony in g-ask, waits for review
/// in g-review, Atlas works in g-work, and g-stranger waits on a person this
/// Swarm does not hold. With [second], another Swarm reuses the project's
/// id, Nova's agent id (as Orion) and g-ask's id, and does not hold Tony.
/// With [plain], Nova also waits on the person in g-plain, as an older
/// backend sends it: with no state.
void main() {
  const tony = 'person-tony';
  const other = 'tab-2';

  /// [now] is the test's clock: every age is from it.
  FakeSwarm backend(DateTime now, {bool second = false, bool plain = false}) {
    int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
    const minute = Duration(minutes: 1);
    Map<String, dynamic> task(
      String id,
      String title,
      int number, {
      required String status,
      String worker = 'agent-builder',
      String? result,
      Duration? progress,
      Map<String, dynamic>? liveness,
      Map<String, dynamic>? leadAction,
      int sequence = 1,
    }) => {
      ...groupData(
        id,
        title: title,
        number: number,
        agentIds: [worker],
        lastMessageSequence: sequence,
      ),
      'assignment': {
        'id': 'attempt-$id',
        'agentId': worker,
        'status': status,
        'result': result,
        'progressAt': ?(progress == null ? null : ago(progress)),
      },
      'liveness': ?liveness,
      'leadAction': ?leadAction,
    };
    Map<String, dynamic> wait(String why, Duration since, {String? personId}) =>
        {
          'state': 'waiting',
          'why': why,
          'since': ago(since),
          'personId': ?personId,
        };

    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        if (second) {'id': other, 'name': 'Web Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          agent('agent-atlas', displayName: 'Atlas'),
        ],
        groups: [
          task(
            'g-ask',
            'Fix login',
            4,
            status: 'needs_human',
            result: 'Ship it behind a flag?',
            liveness: wait('person', minute * 12, personId: tony),
            sequence: 9,
          ),
          task(
            'g-review',
            'Sync',
            5,
            status: 'review',
            liveness: wait('review', minute * 3),
            leadAction: {'kind': 'post', 'at': ago(minute)},
            sequence: 8,
          ),
          task(
            'g-work',
            'Search page',
            6,
            status: 'working',
            worker: 'agent-atlas',
            progress: minute * 4,
            sequence: 7,
          ),
          task(
            'g-stranger',
            'Docs',
            7,
            status: 'needs_human',
            liveness: wait('person', minute * 2, personId: 'person-elsewhere'),
            sequence: 6,
          ),
          if (plain)
            groupData(
              'g-plain',
              title: 'Plain',
              number: 8,
              status: 'needs_human',
              lastMessageSequence: 5,
            ),
        ],
      ),
      'members': [part(me, 1, person(me)), part(tony, 1, person(tony))],
    };
    fake.routes['/api/super-tabs/$other/parts'] = (_) => {
      ...firstLoad(
        tabId: other,
        head: headData(id: other, name: 'Web Swarm'),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'Cleo'),
          agent('agent-builder', displayName: 'Orion'),
        ],
        groups: [
          task(
            'g-ask',
            'Other login',
            4,
            status: 'needs_human',
            liveness: wait('person', minute * 30, personId: tony),
          ),
        ],
      ),
    };
    for (final id in [tab, other]) {
      fake.routes['/api/super-tabs/$id/changes'] = (_) => changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$id/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$id/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$id/conversations/'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
    }
    return fake;
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmPage(),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  double y(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

  /// Task [id]'s line as it reads, after its dot, under [within].
  String? line(WidgetTester tester, String id, {Finder? within}) {
    final found = within == null
        ? key('swarm-task-line-$id')
        : find.descendant(of: within, matching: key('swarm-task-line-$id'));
    if (found.evaluate().isEmpty) return null;
    return tester
        .widgetList<Text>(
          find.descendant(of: found, matching: find.byType(Text)),
        )
        .where((text) => text.key != ValueKey('swarm-task-mark-$id'))
        .map((text) => text.data!)
        .join();
  }

  /// [swarm]'s project sheet, over Home.
  Future<void> openSheet(WidgetTester tester, {String swarm = tab}) async {
    showSwarmProjectSheet(
      tester.element(find.byType(SwarmPage)),
      swarmId: swarm,
      projectId: project,
    );
    await tester.pumpAndSettle();
  }

  /// [swarm]'s project Mobile, from Home, on its Tasks tab.
  Future<void> openTasks(WidgetTester tester, {String swarm = tab}) async {
    await tester.tap(key('swarm-project-$swarm-$project'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-project-tab-tasks'));
    await tester.pumpAndSettle();
  }

  /// The row of the project's tasks that holds [words].
  Finder rowOf(String words) => find.ancestor(
    of: find.textContaining(words, findRichText: true),
    matching: find.byType(SwarmRow),
  );

  group('the Tasks tab', () {
    testWidgets('each task has its line under its name, its dot unheard; '
        'work waiting on the person has its line without a dot of its own', (
      tester,
    ) async {
      await pump(tester, backend(clock.now()));
      await openTasks(tester);

      for (final (id, text) in [
        ('g-review', 'Nova · Waiting for review · 3m · PM posted 1m ago'),
        ('g-work', 'Atlas · Working · 4m ago'),
      ]) {
        final row = key('swarm-task-$id');
        expect(line(tester, id, within: row), text, reason: id);
        expect(
          tester.getTopLeft(key('swarm-task-line-$id')).dy,
          greaterThan(
            tester
                    .getBottomLeft(
                      find.descendant(
                        of: row,
                        matching: find.textContaining('#'),
                      ),
                    )
                    .dy -
                1,
          ),
          reason: '$id: the line is under the name',
        );
      }
      // Waiting on the person: under Waiting on you, with its line, and the
      // row's own dot alone.
      expect(
        line(tester, 'g-ask', within: rowOf('Fix login')),
        'Nova · Waiting on person-tony · Ship it behind a flag? · 12m',
      );
      expect(key('swarm-task-mark-g-ask'), findsNothing);
      expect(key('swarm-task-g-ask'), findsNothing, reason: 'not in Working');
      expect(
        tester.getTopLeft(rowOf('Fix login')).dy,
        lessThan(y(tester, 'swarm-task-g-review')),
      );
      expect(key('swarm-task-line-$leadChat'), findsNothing);
      final handle = tester.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp('●')), findsNothing);
      handle.dispose();
    });

    testWidgets('a person the Swarm does not hold is "a person": no name '
        'from anywhere else', (tester) async {
      await pump(tester, backend(clock.now()));
      await openTasks(tester);

      expect(
        line(tester, 'g-stranger', within: rowOf('Docs')),
        'Nova · Waiting on a person · 2m',
      );
      expect(find.textContaining('person-elsewhere'), findsNothing);
    });

    testWidgets('its ages keep moving while it is open', (tester) async {
      await pump(tester, backend(clock.now()));
      await openTasks(tester);
      expect(
        line(tester, 'g-review'),
        'Nova · Waiting for review · 3m · PM posted 1m ago',
      );

      await tester.pump(const Duration(minutes: 1));
      expect(
        line(tester, 'g-review'),
        'Nova · Waiting for review · 4m · PM posted 2m ago',
      );
      expect(line(tester, 'g-work'), 'Atlas · Working · 5m ago');
    });

    testWidgets('access revoked while it is open: every task goes with its '
        'Swarm, and no timer is left', (tester) async {
      final fake = backend(clock.now());
      final host = await pump(tester, fake);
      await openTasks(tester);
      expect(find.byType(SwarmTaskLine), findsWidgets);

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'You cannot read this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(find.byType(SwarmTaskLine), findsNothing);
      expect(key('swarm-project-tasks'), findsNothing);
      expect(find.textContaining('Fix login'), findsNothing);
      expect(find.textContaining('Ship it behind a flag?'), findsNothing);
      expect(find.textContaining('person-tony'), findsNothing);
      // A minute on, nothing wakes for a row that is gone.
      await tester.pump(const Duration(minutes: 2));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a read that fails keeps the tasks it had, with no Loading, '
        'and the next read moves them on', (tester) async {
      final fake = backend(clock.now());
      final host = await pump(tester, fake);
      await openTasks(tester);
      final reader = host.session!.inbox.reader(tab)!;

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503);
      unawaited(reader.refresh());
      await tester.pumpAndSettle();
      expect(
        line(tester, 'g-review'),
        'Nova · Waiting for review · 3m · PM posted 1m ago',
      );
      expect(find.byType(Skeleton), findsNothing);
      expect(key('swarm-project-loading'), findsNothing);

      // The task went quiet: the next read says so at once.
      final at = clock.now();
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part('g-review', 40, {
            ...groupData('g-review', title: 'Sync', number: 5),
            'assignment': {
              'id': 'attempt-g-review',
              'agentId': 'agent-builder',
              'status': 'working',
            },
            'liveness': {
              'state': 'quiet',
              'why': 'silent',
              'since': at
                  .subtract(const Duration(minutes: 20))
                  .millisecondsSinceEpoch,
            },
            'lastMessageSequence': 8,
          }),
        ],
      );
      unawaited(reader.refresh());
      await tester.pumpAndSettle();
      expect(line(tester, 'g-review'), 'Nova · Quiet 20m');
    });

    testWidgets('with two Swarms, each project names only who its own Swarm '
        'holds, though they share ids', (tester) async {
      await pump(tester, backend(clock.now(), second: true));
      await openTasks(tester);
      expect(
        line(tester, 'g-ask', within: rowOf('Fix login')),
        'Nova · Waiting on person-tony · Ship it behind a flag? · 12m',
      );
      expect(find.textContaining('Orion'), findsNothing);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      await openTasks(tester, swarm: other);
      expect(
        line(tester, 'g-ask', within: rowOf('Other login')),
        'Orion · Waiting on a person · 30m',
      );
      for (final name in ['Nova', 'person-tony', 'Fix login', 'Sync']) {
        expect(
          find.descendant(
            of: key('swarm-project-tasks'),
            matching: find.textContaining(name, findRichText: true),
          ),
          findsNothing,
          reason: name,
        );
      }
    });
  });

  group('the project sheet', () {
    testWidgets("each task's row leads with its agent, then its line; "
        'work with no status keeps its words', (tester) async {
      await pump(tester, backend(clock.now(), plain: true));
      await openSheet(tester);

      for (final (id, text) in [
        (
          'g-ask',
          'Nova · Waiting on person-tony · Ship it behind a flag? · 12m',
        ),
        ('g-review', 'Nova · Waiting for review · 3m · PM posted 1m ago'),
        ('g-work', 'Atlas · Working · 4m ago'),
      ]) {
        expect(
          line(tester, id, within: key('swarm-conversation-$id')),
          text,
          reason: id,
        );
      }
      // An older backend's wait has no state: its words as before.
      expect(key('swarm-task-line-g-plain'), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-conversation-g-plain'),
          matching: find.text('Nova · Needs human'),
        ),
        findsOneWidget,
      );
    });

    testWidgets("another Swarm's sheet names its own agent for a reused id, "
        'and not a person it does not hold', (tester) async {
      await pump(tester, backend(clock.now(), second: true));
      await openSheet(tester, swarm: other);

      expect(
        line(tester, 'g-ask', within: key('swarm-conversation-g-ask')),
        'Orion · Waiting on a person · 30m',
      );
      // Home under the sheet is the first Swarm's; the sheet is the other's.
      for (final name in ['Nova', 'person-tony']) {
        expect(
          find.descendant(
            of: find.byType(SwarmProjectSheet),
            matching: find.textContaining(name),
          ),
          findsNothing,
          reason: name,
        );
      }
    });

    testWidgets('its ages keep moving while it is open', (tester) async {
      await pump(tester, backend(clock.now()));
      await openSheet(tester);

      await tester.pump(const Duration(minutes: 1));
      expect(line(tester, 'g-work'), 'Atlas · Working · 5m ago');
    });
  });

  test('a Home kept for a cold start keeps no task status: no question, no '
      'state, no stale line', () {
    final now = DateTime.utc(2026, 10, 29, 12);
    final snapshot = SuperTabSnapshot.fromJson({
      ...headData(),
      'people': [person(me)],
      'agents': [agent('agent-builder', displayName: 'Nova')],
      'conversations': [
        {
          ...groupData('g-ask', title: 'Fix login', number: 4),
          'assignment': {
            'id': 'attempt-g-ask',
            'agentId': 'agent-builder',
            'status': 'working',
            'result': 'Ship it behind a flag?',
            'progressAt': now.millisecondsSinceEpoch,
          },
          'liveness': {
            'state': 'waiting',
            'why': 'person',
            'since': now.millisecondsSinceEpoch,
            'personId': me,
          },
          'leadAction': {'kind': 'post', 'at': now.millisecondsSinceEpoch},
        },
      ],
    });
    expect(swarmTaskStatus(snapshot.conversations.single, now), isNotNull);

    final kept = SuperTabSnapshot.fromJson(
      swarmHomeSwarm(snapshot, const {}).state,
    );
    final chat = kept.conversations.single;
    expect(swarmTaskStatus(chat, now), isNull);
    expect(chat.liveness, isNull);
    expect(chat.leadAction, isNull);
    expect(chat.assignment?['result'], isNull);
  });
}
