import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

// Literal server payloads: expectations below come from Desktop's contract.
Map<String, dynamic> taskLine({
  String state = 'working',
  Object? title = 'Fix login',
  Object? target = 'task-1',
  String? answerFor,
  String id = 'line-1',
  int sequence = 2,
}) => {
  'id': id,
  'conversationId': leadChat,
  'sequence': sequence,
  'text': 'Fix login · $state',
  'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
  'createdAt': DateTime.utc(2026, 11, 2, 17, sequence).toIso8601String(),
  'source': {
    'kind': 'task-line',
    'state': state,
    'title': title,
    'taskId': target,
    'answerFor': ?answerFor,
  },
};

Map<String, dynamic> legacyShip(String target, int sequence) => {
  ...taskLine(id: 'ship-$target', sequence: sequence),
  'text': 'Shipped: $target',
  'source': {'kind': 'ship', 'conversationId': target, 'title': target},
};

FakeSwarm taskLineBackend(
  List<Map<String, dynamic>> page, {
  bool target = true,
}) {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
    groups: [
      groupData(leadChat, title: 'Project chat', lastMessageSequence: 10),
      if (target) groupData('task-1', title: 'Fix login'),
    ],
  );
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['/api/super-tabs/$tab/decisions'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (_) =>
      {'messages': page.reversed.toList(), 'threads': <Object>[], 'next': null};
  fake.routes['/api/super-tabs/$tab/conversations/task-1/messages'] = (_) => {
    'messages': [
      {
        ...taskLine(),
        'id': 'task-message',
        'conversationId': 'task-1',
        'text': 'Inside the task chat',
        'source': {'kind': 'message'},
      },
    ],
    'threads': <Object>[],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
    'result': <String, dynamic>{},
  };
  return fake;
}

Future<SwarmHost> pumpTaskChat(WidgetTester tester, FakeSwarm fake) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
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
      home: const SwarmConversationPage(swarmId: tab, conversationId: leadChat),
    ),
  );
  await tester.pumpAndSettle();
  return host;
}

Future<void> pumpRow(
  WidgetTester tester,
  Map<String, dynamic> data, {
  String readerId = me,
  double width = 390,
  double scale = 1,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: ListView(
          children: [
            SwarmMessageRow(
              message: SuperTabMessage.fromJson(data),
              name: 'River',
              look: (picture: null, status: null),
              role: 'PM',
              readerId: readerId,
              mentions: SwarmMentions(const []),
              grouped: false,
              lit: false,
              quote: null,
              actions: false,
              onTap: () {},
              onReply: null,
            ),
          ],
        ),
      ),
    ),
  );
}

void main() {
  // Removing dispatch, using fallback text, or mapping any state incorrectly
  // breaks these consumer-visible widget assertions.
  for (final (state, word, mark) in [
    ('planned', 'planned', LucideIcons.circleDashed),
    ('working', 'working', LucideIcons.circleDot),
    ('waiting', 'working', LucideIcons.circleDot),
    ('review', 'in review', LucideIcons.circleDot),
    ('ready', 'ready', LucideIcons.circleDot),
    ('shipped', 'shipped', LucideIcons.check),
    ('done', 'done', LucideIcons.check),
    ('stopped', 'stopped', LucideIcons.circleSlash),
  ]) {
    testWidgets('$state shows the task name, Desktop word and mark', (
      tester,
    ) async {
      await pumpRow(tester, taskLine(state: state));
      expect(find.text('Fix login'), findsOneWidget);
      expect(find.text(word), findsOneWidget);
      expect(find.byIcon(mark), findsOneWidget);
      expect(find.text('River'), findsNothing);
      expect(find.text('Fix login · $state'), findsNothing);
    });
  }

  testWidgets('waiting asks only the named reader to Answer', (tester) async {
    final semantics = tester.ensureSemantics();
    addTearDown(semantics.dispose);
    final data = taskLine(state: 'waiting', answerFor: me);
    await pumpRow(tester, data);
    expect(find.text('Answer'), findsOneWidget);
    expect(find.bySemanticsLabel('Fix login, Answer'), findsOneWidget);
    expect(
      tester.widget<Text>(find.text('Answer')).style?.fontWeight,
      FontWeight.w600,
    );
    await pumpRow(tester, data, readerId: 'someone-else');
    expect(find.text('Answer'), findsNothing);
    expect(find.text('working'), findsOneWidget);
  });

  testWidgets('unknown state keeps fallback text without inventing a word', (
    tester,
  ) async {
    await pumpRow(tester, taskLine(state: 'future', title: null));
    expect(find.text('Fix login · future'), findsOneWidget);
    expect(find.byIcon(LucideIcons.circleDot), findsOneWidget);
    expect(find.text('working'), findsNothing);
    expect(find.text('River'), findsNothing);
  });

  testWidgets(
    'long name keeps the word and thumb target on a narrow large-text phone',
    (tester) async {
      final name = List.filled(12, 'A long task name').join(' ');
      await pumpRow(
        tester,
        taskLine(title: name, state: 'review'),
        width: 320,
        scale: 2,
      );
      expect(find.text(name), findsOneWidget);
      expect(find.text('in review'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final row = find.byKey(const ValueKey('swarm-message-line-1'));
      expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
    },
  );

  testWidgets('tapping a line opens its task chat without a reply action', (
    tester,
  ) async {
    await pumpTaskChat(tester, taskLineBackend([taskLine()]));
    await tester.tap(find.byKey(const ValueKey('swarm-message-line-1')));
    await tester.pumpAndSettle();
    expect(find.text('Inside the task chat'), findsOneWidget);
    expect(
      tester
          .widget<SwarmConversationPage>(
            find.byType(SwarmConversationPage).last,
          )
          .conversationId,
      'task-1',
    );
    expect(find.text('Reply in thread'), findsNothing);
  });

  for (final target in <Object?>['task-1', 7, null]) {
    testWidgets(
      'a target absent from the read stays readable without navigation: $target',
      (tester) async {
        final semantics = tester.ensureSemantics();
        addTearDown(semantics.dispose);
        final fake = taskLineBackend([taskLine(target: target)], target: false);
        await pumpTaskChat(tester, fake);
        expect(find.text('Fix login'), findsOneWidget);
        expect(
          tester
              .getSemantics(find.bySemanticsLabel('Fix login, working'))
              .getSemanticsData()
              .hasAction(SemanticsAction.tap),
          isFalse,
        );
        await tester.tap(find.byKey(const ValueKey('swarm-message-line-1')));
        await tester.pumpAndSettle();
        expect(find.byType(SwarmConversationPage), findsOneWidget);
        expect(
          fake.paths.any((p) => p.contains('/conversations/task-1/messages')),
          isFalse,
        );
        expect(find.text('Copy'), findsNothing);
      },
    );
  }

  for (final lineFirst in [true, false]) {
    testWidgets('a line hides only its task’s legacy ship, order $lineFirst', (
      tester,
    ) async {
      final line = taskLine(sequence: lineFirst ? 1 : 3);
      final ship = legacyShip('task-1', 2);
      await pumpTaskChat(
        tester,
        taskLineBackend([
          if (lineFirst) line,
          ship,
          if (!lineFirst) line,
          legacyShip('other-task', 4),
        ]),
      );
      expect(find.text('Fix login'), findsOneWidget);
      expect(find.text('Shipped: task-1'), findsNothing);
      expect(find.text('Shipped: other-task'), findsOneWidget);
    });
  }

  testWidgets('a legacy ship stays when no line replaces it', (tester) async {
    await pumpTaskChat(tester, taskLineBackend([legacyShip('task-1', 2)]));
    expect(find.text('Shipped: task-1'), findsOneWidget);
  });

  test('a normal message after a task line keeps its author header', () {
    final line = taskLine(sequence: 1);
    final normal = {
      ...taskLine(id: 'normal', sequence: 2),
      'source': {'kind': 'message'},
      'text': 'A normal follow-up',
    };
    expect(
      swarmGroupedMessages([
        SuperTabMessage.fromJson(line),
        SuperTabMessage.fromJson(normal),
      ]),
      isEmpty,
    );
  });
}
