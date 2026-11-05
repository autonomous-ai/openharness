import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/pulse_model.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The board pulse on the phone (task #3384, plan Task 4): a strip on top of
/// a project's task list — the Team sheet's open tasks, and the Tasks tab —
/// drawn from the read's `derived.pulse[projectId]`: what waits for the PM,
/// who works, what is next up, lost and held. Each count opens its list; a
/// segment is red by the server's `redAt` alone. Over a scripted backend: one
/// Swarm, project Mobile, River its PM, Huy a person who asked.
void main() {
  const huy = 'person-huy';
  const minute = Duration(minutes: 1);

  /// The pulse the server sends for project Mobile, ages from [now].
  Map<String, dynamic> pulseData(
    DateTime now, {
    int asks = 2,
    Map<String, Object?> redAt = const {},
  }) {
    int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
    return {
      'pmId': 'agent-lead',
      'asks': {
        'count': asks,
        'oldestAt': asks == 0 ? null : ago(minute * 14),
        'personId': asks == 0 ? null : huy,
        'list': [
          if (asks > 0) ...[
            {
              'conversationId': leadChat,
              'messageId': 'm-huy',
              'personId': huy,
              'at': ago(minute * 14),
            },
            {
              'conversationId': 'g-work',
              'messageId': 'm-me',
              'personId': me,
              'at': ago(minute * 3),
            },
          ],
        ],
      },
      'working': {
        'count': 6,
        'crew': 10,
        'agentIds': ['agent-atlas'],
      },
      'nextUp': {
        'count': 7,
        'conversationIds': ['g-next'],
      },
      'lost': {'count': 0, 'since': null, 'conversationIds': <String>[]},
      'held': {
        'count': 3,
        'withoutReason': 1,
        'list': [
          {'conversationId': 'g-held', 'reason': 'Waiting on the API key'},
          {'conversationId': 'g-later', 'reason': null},
        ],
      },
      'idleSince': null,
      'redAt': {
        'asks': null,
        'idle': null,
        'lost': null,
        'held': null,
        ...redAt,
      },
      'limits': {'askMinutes': 15, 'idleMinutes': 10, 'lostMinutes': 10},
    };
  }

  /// [pulse] null: a server from before the pulse.
  FakeSwarm backend(Map<String, dynamic>? pulse) {
    final fake = FakeSwarm();
    Map<String, dynamic> task(
      String id,
      String title,
      int number, {
      String? status,
      String worker = 'agent-atlas',
    }) => groupData(
      id,
      title: title,
      number: number,
      agentIds: [if (status != null) worker],
      status: status,
      workerId: worker,
      lastMessageSequence: 1,
    );
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
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
          task('g-work', 'Search page', 6, status: 'working'),
          task('g-next', 'Docs', 7),
          task('g-held', 'Billing', 9, status: 'needs_human'),
          task('g-later', 'Later', 10),
        ],
        derived: {
          if (pulse != null) 'pulse': {project: pulse},
        },
      ),
      'members': [
        part(me, 1, person(me)),
        part(huy, 1, {...person(huy, role: 'member'), 'name': 'Huy'}),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// Project Mobile's page, on [tabs].
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmProjectTab tab_ = SwarmProjectTab.chat,
    List<SwarmProjectTab> tabs = SwarmProjectTab.homeC,
  }) async {
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
        home: SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tab: tab_,
          tabs: tabs,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The Team sheet, its open tasks on top (Swarm Home C).
  Future<void> openTeam(WidgetTester tester) async {
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-project-menu-team'));
    await tester.pumpAndSettle();
  }

  /// The words of the strip's segment [name].
  String words(WidgetTester tester, String name) =>
      tester.widget<Text>(key('swarm-pulse-$name-text')).textSpan!
          .toPlainText();

  bool red(WidgetTester tester, String name) {
    final shown = key('swarm-pulse-$name-red').evaluate().isNotEmpty;
    final style = tester.widget<Text>(key('swarm-pulse-$name-text')).style;
    final inRed = style?.color == AppColors.danger;
    expect(inRed, shown, reason: '$name: its colour and its mark agree');
    if (shown) {
      expect(style?.fontWeight, FontWeight.w600, reason: '$name: bold');
    }
    return shown;
  }

  const segments = ['asks', 'working', 'next-up', 'lost', 'held'];

  group('derived.pulse', () {
    test('is read into each project of the snapshot', () {
      final now = DateTime.utc(2026, 11, 5, 12);
      final parts = SuperTabParts.firstLoad(
        firstLoad(
          derived: {
            'pulse': {
              project: pulseData(
                now,
                redAt: {'asks': now.millisecondsSinceEpoch + 60000},
              ),
            },
          },
        ),
      );
      final pulse = SuperTabSnapshot.fromJson(parts.state).pulseOf(project)!;
      expect(pulse.pmId, 'agent-lead');
      expect(pulse.asks.count, 2);
      expect(pulse.asks.oldestAt, now.subtract(minute * 14));
      expect(pulse.asks.personId, huy);
      expect(pulse.asks.list.map((a) => a.messageId), ['m-huy', 'm-me']);
      expect(pulse.asks.list.first.conversationId, leadChat);
      expect(pulse.asks.list.first.at, now.subtract(minute * 14));
      expect(pulse.working.count, 6);
      expect(pulse.working.crew, 10);
      expect(pulse.working.agentIds, ['agent-atlas']);
      expect(pulse.nextUp.count, 7);
      expect(pulse.nextUp.conversationIds, ['g-next']);
      expect(pulse.lost.count, 0);
      expect(pulse.lost.conversationIds, isEmpty);
      expect(pulse.held.count, 3);
      expect(pulse.held.withoutReason, 1);
      expect(pulse.held.list.map((h) => (h.conversationId, h.reason)), [
        ('g-held', 'Waiting on the API key'),
        ('g-later', null),
      ]);
      expect(pulse.redAt[SuperTabPulseRule.asks], now.add(minute));
      expect(pulse.redAt[SuperTabPulseRule.idle], isNull);
      expect(pulse.isRed(SuperTabPulseRule.asks, now), isFalse);
      expect(pulse.isRed(SuperTabPulseRule.asks, now.add(minute)), isTrue);
      expect(pulse.nextRedAfter(now), now.add(minute));
      expect(pulse.nextRedAfter(now.add(minute)), isNull);

      // A change read moves it.
      parts.apply(
        changes(
          cursor: 'c2',
          derived: {
            'pulse': {project: pulseData(now, asks: 0)},
          },
        ),
      );
      expect(
        SuperTabSnapshot.fromJson(parts.state).pulseOf(project)!.asks.count,
        0,
      );
    });

    test('none from an older server, and none for a pulse it cannot read', () {
      expect(
        SuperTabSnapshot.fromJson(
          SuperTabParts.firstLoad(firstLoad()).state,
        ).pulseOf(project),
        isNull,
      );
      for (final odd in <Object?>['soon', 3, null]) {
        final parts = SuperTabParts.firstLoad(
          firstLoad(
            derived: {
              'pulse': {project: odd},
            },
          ),
        );
        expect(
          SuperTabSnapshot.fromJson(parts.state).pulseOf(project),
          isNull,
          reason: '$odd',
        );
      }
    });
  });

  group('the strip on the Team sheet', () {
    testWidgets('says what waits for the PM and who works, as the server '
        'counts it', (tester) async {
      await pump(tester, backend(pulseData(clock.now())));
      await openTeam(tester);

      expect(key('swarm-pulse'), findsOneWidget);
      expect(
        words(tester, 'asks'),
        'Waiting for River: 2 asks · oldest 14m (Huy)',
      );
      expect(words(tester, 'working'), 'Working 6 of 10');
      expect(words(tester, 'next-up'), 'Next up 7');
      expect(words(tester, 'lost'), 'Lost 0');
      expect(words(tester, 'held'), 'Held 3 (1 no reason)');
      // On top of the open tasks.
      expect(
        tester.getBottomLeft(key('swarm-pulse')).dy,
        lessThanOrEqualTo(
          tester.getTopLeft(key('swarm-team-working-caption')).dy,
        ),
      );
      for (final name in segments) {
        expect(red(tester, name), isFalse, reason: name);
      }
      // A segment is a thumb's touch tall.
      for (final name in segments) {
        expect(
          tester.getSize(key('swarm-pulse-$name')).height,
          greaterThanOrEqualTo(44),
          reason: name,
        );
      }
    });

    testWidgets('with nothing asked: "Nothing waiting for River"', (
      tester,
    ) async {
      await pump(tester, backend(pulseData(clock.now(), asks: 0)));
      await openTeam(tester);
      expect(words(tester, 'asks'), 'Nothing waiting for River');
    });

    testWidgets('its ages keep moving while it is open', (tester) async {
      await pump(tester, backend(pulseData(clock.now())));
      await openTeam(tester);
      await tester.pump(minute);
      expect(
        words(tester, 'asks'),
        'Waiting for River: 2 asks · oldest 15m (Huy)',
      );
    });

    testWidgets('no strip from a server without the pulse', (tester) async {
      await pump(tester, backend(null));
      await openTeam(tester);
      expect(key('swarm-pulse'), findsNothing);
      expect(key('swarm-team-working-caption'), findsOneWidget);
    });

    testWidgets('each segment is red once its redAt has come, with a mark '
        'and bold, never by colour alone', (tester) async {
      final past = clock.now().subtract(minute).millisecondsSinceEpoch;
      await pump(
        tester,
        backend(
          pulseData(
            clock.now(),
            redAt: {'asks': past, 'idle': past, 'lost': past, 'held': past},
          ),
        ),
      );
      await openTeam(tester);
      for (final name in ['asks', 'working', 'lost', 'held']) {
        expect(red(tester, name), isTrue, reason: name);
      }
      // No rule turns Next up red.
      expect(red(tester, 'next-up'), isFalse);
    });

    testWidgets('a redAt still to come is not red, and turns red when it '
        'passes', (tester) async {
      final soon = clock.now().add(const Duration(seconds: 30));
      await pump(
        tester,
        backend(
          pulseData(
            clock.now(),
            redAt: {
              'asks': soon.millisecondsSinceEpoch,
              'held': clock.now().add(minute * 30).millisecondsSinceEpoch,
            },
          ),
        ),
      );
      await openTeam(tester);
      expect(red(tester, 'asks'), isFalse);
      expect(red(tester, 'held'), isFalse);

      // Before the minute's tick: the redAt itself wakes the strip.
      await tester.pump(const Duration(seconds: 31));
      expect(red(tester, 'asks'), isTrue);
      expect(red(tester, 'held'), isFalse);
    });

    testWidgets('the asks open their list: who asked and how long ago; one '
        'opens its message in its conversation', (tester) async {
      await pump(tester, backend(pulseData(clock.now())));
      await openTeam(tester);

      await tester.tap(key('swarm-pulse-asks'));
      await tester.pumpAndSettle();
      expect(key('swarm-pulse-sheet'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-pulse-sheet'),
          matching: find.text('Waiting for River'),
        ),
        findsOneWidget,
      );
      final huyRow = key('swarm-pulse-ask-m-huy');
      expect(
        find.descendant(of: huyRow, matching: find.text('Huy')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: huyRow, matching: find.textContaining('14m')),
        findsOneWidget,
      );
      expect(key('swarm-pulse-ask-m-me'), findsOneWidget);

      await tester.tap(huyRow);
      await tester.pumpAndSettle();
      final opened = tester.widget<SwarmOpenedChat>(
        find.byType(SwarmOpenedChat),
      );
      expect(opened.conversationId, leadChat);
      expect(opened.messageId, 'm-huy');
    });

    testWidgets('Working opens the working agents', (tester) async {
      await pump(tester, backend(pulseData(clock.now())));
      await openTeam(tester);

      await tester.tap(key('swarm-pulse-working'));
      await tester.pumpAndSettle();
      final row = key('swarm-pulse-agent-agent-atlas');
      expect(
        find.descendant(of: row, matching: find.text('Atlas')),
        findsOneWidget,
      );
      // With the task it holds, which a tap opens.
      expect(
        find.descendant(
          of: row,
          matching: find.textContaining('Search page'),
        ),
        findsOneWidget,
      );
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SwarmOpenedChat>(find.byType(SwarmOpenedChat))
            .conversationId,
        'g-work',
      );
    });

    testWidgets('Next up, Lost and Held open their tasks; Held says each '
        "one's reason, or no reason", (tester) async {
      await pump(tester, backend(pulseData(clock.now())));
      await openTeam(tester);

      await tester.tap(key('swarm-pulse-next-up'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-pulse-task-g-next'),
          matching: find.textContaining('Docs', findRichText: true),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-pulse-close'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-pulse-lost'));
      await tester.pumpAndSettle();
      expect(key('swarm-pulse-sheet'), findsOneWidget);
      expect(find.text('No lost tasks.'), findsOneWidget);
      await tester.tap(key('swarm-pulse-close'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-pulse-held'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-pulse-task-g-held'),
          matching: find.text('Waiting on the API key'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-pulse-task-g-later'),
          matching: find.text('no reason'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-pulse-task-g-held'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SwarmOpenedChat>(find.byType(SwarmOpenedChat))
            .conversationId,
        'g-held',
      );
    });
  });

  testWidgets('the Tasks tab has the strip on top too', (tester) async {
    await pump(
      tester,
      backend(pulseData(clock.now())),
      tab_: SwarmProjectTab.tasks,
      tabs: const [SwarmProjectTab.chat, SwarmProjectTab.tasks],
    );
    expect(
      find.descendant(
        of: key('swarm-project-tasks'),
        matching: key('swarm-pulse'),
      ),
      findsOneWidget,
    );
    expect(words(tester, 'working'), 'Working 6 of 10');

    await tester.tap(key('swarm-pulse-next-up'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-pulse-task-g-next'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<SwarmOpenedChat>(find.byType(SwarmOpenedChat))
          .conversationId,
      'g-next',
    );
  });
}
