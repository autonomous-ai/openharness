import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';
import 'package:harness/super_tabs/pulse.dart';
import 'package:harness/super_tabs/tasks_view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final pulseNow = DateTime(2026, 11, 4, 9);

int _ago(Duration age) => pulseNow.subtract(age).millisecondsSinceEpoch;

/// A project's pulse as the server sends it in `derived.pulse` (plan
/// 2026-11-05-board-pulse-plan.md, Contract): two asks waiting for River, the
/// oldest Scholes's 14 minutes ago; one of two agents working; two tasks next
/// up; none lost; one held without a reason.
Map<String, dynamic> pulseFixture({
  Map<String, Object?> redAt = const {},
  int asks = 2,
  Duration oldest = const Duration(minutes: 14),
  int lost = 0,
}) => {
  'pmId': 'river',
  'asks': {
    'count': asks,
    'oldestAt': asks == 0 ? null : _ago(oldest),
    'personId': asks == 0 ? null : 'scholes',
    'list': [
      if (asks > 0)
        {
          'conversationId': 'lead',
          'messageId': 'm-old',
          'personId': 'scholes',
          'at': _ago(oldest),
        },
      if (asks > 1)
        {
          'conversationId': 'tag',
          'messageId': 'm-new',
          'personId': 'tony',
          'at': _ago(const Duration(minutes: 3)),
        },
    ],
  },
  'working': {
    'count': 1,
    'crew': 2,
    'agentIds': ['finch'],
  },
  'nextUp': {
    'count': 2,
    'conversationIds': ['shipped-means', 'preview'],
  },
  'lost': {
    'count': lost,
    'since': lost == 0 ? null : _ago(const Duration(minutes: 4)),
    'conversationIds': [if (lost > 0) 'preview'],
  },
  'held': {
    'count': 2,
    'withoutReason': 1,
    'list': [
      {'conversationId': 'test-copy', 'reason': null},
      {'conversationId': 'tag', 'reason': 'Waiting on the design review'},
    ],
  },
  'idleSince': null,
  'redAt': {'asks': null, 'idle': null, 'lost': null, 'held': null, ...redAt},
  'limits': {'askMinutes': 15, 'idleMinutes': 10, 'lostMinutes': 10},
};

/// The Tasks view's project with River as its PM, and [pulse] on its read.
ConversationServer pulseServer(Map<String, dynamic>? pulse) {
  final server = tasksServer();
  (server.state['agents'] as List).add({
    'id': 'river',
    'name': 'Product Manager',
    'displayName': 'River',
    'machineId': 'studio',
    'harnessId': 'h2',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
  });
  if (pulse != null) server.state['pulse'] = {'lead': pulse};
  return server;
}

typedef Opened = ({List<String> tasks, List<(String, String)> messages});

Future<(SuperTabController, Opened)> showPulse(
  WidgetTester tester,
  ConversationServer server, {
  DateTime Function()? now,
  Brightness brightness = Brightness.light,
  Size size = const Size(1400, 700),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  final opened = (tasks: <String>[], messages: <(String, String)>[]);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabTasksView(
          controller: c,
          project: c.snapshot!.projects.single,
          storage: MemoryKeyValueStore(),
          needsHuman: (_) => 0,
          onOpenTask: opened.tasks.add,
          onOpenProposal: (_) {},
          onOpenMessage: (conversation, message) =>
              opened.messages.add((conversation, message)),
          now: now ?? () => pulseNow,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (c, opened);
}

Future<void> closePulse(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Finder segment(String name) => find.byKey(ValueKey('super-pulse-$name'));

String segmentText(WidgetTester tester, String name) => tester
    .widget<Text>(
      find.descendant(of: segment(name), matching: find.byType(Text)),
    )
    .data!;

/// Red shows three ways, never by color alone: the error ink, a bold label and
/// the alert icon.
bool isRed(WidgetTester tester, String name) {
  final text = tester.widget<Text>(
    find.descendant(of: segment(name), matching: find.byType(Text)),
  );
  final error = Theme.of(tester.element(segment(name))).colorScheme.error;
  final icon = find
      .descendant(
        of: segment(name),
        matching: find.byIcon(AppIcons.circleAlert),
      )
      .evaluate()
      .isNotEmpty;
  final red = text.style?.color == error;
  final bold = (text.style?.fontWeight?.value ?? 400) >= 600;
  expect(
    [red, bold, icon],
    anyOf(everyElement(isTrue), everyElement(isFalse)),
    reason: '$name is red by ink, weight and icon together',
  );
  return red;
}

Color stripRim(WidgetTester tester) {
  final box = tester.widget<DecoratedBox>(
    find.byKey(const ValueKey('super-pulse')),
  );
  return ((box.decoration as BoxDecoration).border! as Border).top.color;
}

const segments = ['asks', 'working', 'nextUp', 'lost', 'held'];

/// The board's pulse (task #3384): what waits for the PM and who works, on
/// top of a project's Tasks board, red by the server's `redAt` alone.
void main() {
  group('parsing derived.pulse', () {
    Map<String, dynamic> load(Object? pulse) {
      final answer = jsonDecode(
        File('test/super_tab_read_fixtures/first_load.json').readAsStringSync(),
      ) as Map<String, dynamic>;
      final derived = Map<String, dynamic>.of(
        answer['derived'] as Map<String, dynamic>? ?? const {},
      );
      if (pulse != null) derived['pulse'] = pulse;
      answer['derived'] = derived;
      return SuperTabParts.firstLoad(answer).state;
    }

    test('each project\'s pulse reaches the snapshot', () {
      final snapshot = SuperTabSnapshot.fromJson(
        load({
          '5701': pulseFixture(
            redAt: {'asks': _ago(const Duration(minutes: 1))},
            lost: 1,
          ),
        }),
      );
      final pulse = snapshot.pulseOf('5701')!;
      expect(pulse.pmId, 'river');
      expect(pulse.asks.count, 2);
      expect(
        pulse.asks.oldestAt,
        pulseNow.subtract(const Duration(minutes: 14)),
      );
      expect(pulse.asks.personId, 'scholes');
      expect(
        [
          for (final ask in pulse.asks.list)
            (ask.conversationId, ask.messageId, ask.personId),
        ],
        [('lead', 'm-old', 'scholes'), ('tag', 'm-new', 'tony')],
      );
      expect(pulse.working.count, 1);
      expect(pulse.working.crew, 2);
      expect(pulse.working.agentIds, ['finch']);
      expect(pulse.nextUp.count, 2);
      expect(pulse.nextUp.conversationIds, ['shipped-means', 'preview']);
      expect(pulse.lost.count, 1);
      expect(pulse.lost.conversationIds, ['preview']);
      expect(pulse.held.count, 2);
      expect(pulse.held.withoutReason, 1);
      expect(
        [
          for (final hold in pulse.held.list)
            (hold.conversationId, hold.reason),
        ],
        [('test-copy', null), ('tag', 'Waiting on the design review')],
      );
      expect(
        pulse.redAt[SuperTabPulseRule.asks],
        pulseNow.subtract(const Duration(minutes: 1)),
      );
      expect(pulse.redAt[SuperTabPulseRule.idle], isNull);
      expect(pulse.isRed(SuperTabPulseRule.asks, pulseNow), isTrue);
      expect(pulse.isRed(SuperTabPulseRule.lost, pulseNow), isFalse);
    });

    test('an older server sends no pulse, and one that cannot be read is '
        'left out rather than drawn wrong', () {
      expect(SuperTabSnapshot.fromJson(load(null)).pulseOf('5701'), isNull);
      final broken = SuperTabSnapshot.fromJson(
        load({
          '5701': {'pmId': 'river', 'asks': 'two'},
        }),
      );
      expect(broken.pulseOf('5701'), isNull);
    });

    test('a pulse is red at its redAt, not before', () {
      final pulse = SuperTabPulse.read(
        pulseFixture(redAt: {'held': pulseNow.millisecondsSinceEpoch}),
      )!;
      expect(pulse.isRed(SuperTabPulseRule.held, pulseNow), isTrue);
      expect(
        pulse.isRed(
          SuperTabPulseRule.held,
          pulseNow.subtract(const Duration(milliseconds: 1)),
        ),
        isFalse,
      );
    });
  });

  testWidgets('the strip reads what waits for the PM and who works', (
    tester,
  ) async {
    final (c, _) = await showPulse(tester, pulseServer(pulseFixture()));
    expect(find.byKey(const ValueKey('super-pulse')), findsOneWidget);
    expect(
      segmentText(tester, 'asks'),
      'Waiting for River: 2 asks · oldest 14m (scholes)',
    );
    expect(segmentText(tester, 'working'), 'Working 1 of 2');
    expect(segmentText(tester, 'nextUp'), 'Next up 2');
    expect(segmentText(tester, 'lost'), 'Lost 0');
    expect(segmentText(tester, 'held'), 'Held 2 (1 no reason)');
    // It sits on top of the board.
    expect(
      tester.getBottomLeft(find.byKey(const ValueKey('super-pulse'))).dy,
      lessThanOrEqualTo(
        tester.getTopLeft(find.byKey(const ValueKey('super-tasks-board'))).dy,
      ),
    );
    for (final name in segments) {
      expect(isRed(tester, name), isFalse, reason: name);
    }
    expect(
      stripRim(tester),
      isNot(Theme.of(tester.element(segment('asks'))).colorScheme.error),
    );
    await closePulse(tester, c);
  });

  testWidgets('with nothing waiting, and one ask hours old', (tester) async {
    final server = pulseServer(pulseFixture(asks: 0));
    final (c, _) = await showPulse(tester, server);
    expect(segmentText(tester, 'asks'), 'Nothing waiting for River');
    server.state['pulse'] = {
      'lead': pulseFixture(
        asks: 1,
        oldest: const Duration(hours: 3, minutes: 5),
      ),
    };
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
      segmentText(tester, 'asks'),
      'Waiting for River: 1 ask · oldest 3h (scholes)',
    );
    await closePulse(tester, c);
  });

  testWidgets('a held count with every reason given says nothing more', (
    tester,
  ) async {
    final pulse = pulseFixture();
    pulse['held'] = {
      'count': 1,
      'withoutReason': 0,
      'list': [
        {'conversationId': 'tag', 'reason': 'Waiting on the design review'},
      ],
    };
    final (c, _) = await showPulse(tester, pulseServer(pulse));
    expect(segmentText(tester, 'held'), 'Held 1');
    await closePulse(tester, c);
  });

  for (final (rule, name) in [
    ('asks', 'asks'),
    ('idle', 'working'),
    ('lost', 'lost'),
    ('held', 'held'),
  ]) {
    testWidgets('$name is red once its $rule redAt has passed', (tester) async {
      final (c, _) = await showPulse(
        tester,
        pulseServer(
          pulseFixture(redAt: {rule: _ago(const Duration(minutes: 1))}),
        ),
      );
      for (final other in segments) {
        expect(isRed(tester, other), other == name, reason: other);
      }
      expect(
        stripRim(tester),
        Theme.of(tester.element(segment(name))).colorScheme.error,
      );
      await closePulse(tester, c);
    });
  }

  testWidgets(
    'a redAt still ahead turns red when it passes, with no new read',
    (tester) async {
      var now = pulseNow;
      final (c, _) = await showPulse(
        tester,
        pulseServer(
          pulseFixture(
            redAt: {
              'asks': pulseNow
                  .add(const Duration(minutes: 1))
                  .millisecondsSinceEpoch,
            },
          ),
        ),
        now: () => now,
      );
      expect(isRed(tester, 'asks'), isFalse);
      expect(
        segmentText(tester, 'asks'),
        'Waiting for River: 2 asks · oldest 14m (scholes)',
      );
      now = now.add(const Duration(minutes: 1));
      await tester.pump(const Duration(minutes: 1));
      expect(isRed(tester, 'asks'), isTrue);
      // The age moved on with the clock too.
      expect(
        segmentText(tester, 'asks'),
        'Waiting for River: 2 asks · oldest 15m (scholes)',
      );
      await closePulse(tester, c);
    },
  );

  testWidgets('no strip from a server without the pulse', (tester) async {
    final (c, _) = await showPulse(tester, pulseServer(null));
    expect(find.byKey(const ValueKey('super-pulse')), findsNothing);
    expect(find.byKey(const ValueKey('super-tasks-board')), findsOneWidget);
    await closePulse(tester, c);
  });

  group('each count opens its list', () {
    testWidgets('asks: who and how long, opening the message', (tester) async {
      final (c, opened) = await showPulse(tester, pulseServer(pulseFixture()));
      await tester.tap(segment('asks'));
      await tester.pumpAndSettle();
      final old = find.byKey(const ValueKey('super-pulse-ask-m-old'));
      final recent = find.byKey(const ValueKey('super-pulse-ask-m-new'));
      expect(
        find.descendant(of: old, matching: find.text('scholes')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: old, matching: find.text('14m')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: recent, matching: find.text('tony')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: recent, matching: find.text('3m')),
        findsOneWidget,
      );
      await tester.tap(old);
      await tester.pumpAndSettle();
      expect(opened.messages, [('lead', 'm-old')]);
      expect(old, findsNothing);
      await closePulse(tester, c);
    });

    testWidgets('working: the agents on work, opening the task', (
      tester,
    ) async {
      final (c, opened) = await showPulse(tester, pulseServer(pulseFixture()));
      await tester.tap(segment('working'));
      await tester.pumpAndSettle();
      final finch = find.byKey(const ValueKey('super-pulse-agent-finch'));
      expect(
        find.descendant(of: finch, matching: find.text('Finch2')),
        findsOneWidget,
      );
      await tester.tap(finch);
      await tester.pumpAndSettle();
      expect(opened.tasks, ['tag']);
      await closePulse(tester, c);
    });

    testWidgets('next up: the tasks by title and number', (tester) async {
      final (c, opened) = await showPulse(tester, pulseServer(pulseFixture()));
      await tester.tap(segment('nextUp'));
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-pulse-task-preview'));
      expect(
        find.descendant(
          of: row,
          matching: find.text('Remove the old preview route'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('#11')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('super-pulse-task-shipped-means')),
        findsOneWidget,
      );
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(opened.tasks, ['preview']);
      await closePulse(tester, c);
    });

    testWidgets('lost: the tasks with no agent, or that none are', (
      tester,
    ) async {
      final server = pulseServer(pulseFixture());
      final (c, opened) = await showPulse(tester, server);
      await tester.tap(segment('lost'));
      await tester.pumpAndSettle();
      expect(find.text('No lost tasks'), findsOneWidget);
      await tester.tapAt(Offset.zero);
      await tester.pumpAndSettle();
      server.state['pulse'] = {'lead': pulseFixture(lost: 1)};
      await c.refresh();
      await tester.pumpAndSettle();
      await tester.tap(segment('lost'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-pulse-task-preview')));
      await tester.pumpAndSettle();
      expect(opened.tasks, ['preview']);
      await closePulse(tester, c);
    });

    testWidgets('held: each task with its reason, or no reason', (
      tester,
    ) async {
      final (c, opened) = await showPulse(tester, pulseServer(pulseFixture()));
      await tester.tap(segment('held'));
      await tester.pumpAndSettle();
      final none = find.byKey(const ValueKey('super-pulse-task-test-copy'));
      final given = find.byKey(const ValueKey('super-pulse-task-tag'));
      expect(
        find.descendant(
          of: none,
          matching: find.text('First run of the test copy'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: none, matching: find.text('No reason')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: given,
          matching: find.text('Waiting on the design review'),
        ),
        findsOneWidget,
      );
      await tester.tap(given);
      await tester.pumpAndSettle();
      expect(opened.tasks, ['tag']);
      await closePulse(tester, c);
    });
  });
}
