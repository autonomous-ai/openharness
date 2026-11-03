import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_work_details_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A task's Work details on the phone (Tony's mobile list, task 31): from the
/// chat's ⋮, where Desktop's chat menu has it, a read-only page of the task's
/// brief, its linked steps, who has it, each acceptance check with its
/// evidence, and the result (desktop `work_details.dart`).
void main() {
  const chat = 'g1';
  const brief =
      'Goal:\nPeople signed out on a phone get sent back to sign-in in a loop.\n\n'
      'Changes:\nKeep the session through the redirect.\n\n'
      'Constraints:\nNo new dependency.';
  const refused = SuperTabFailure(
    'FORBIDDEN',
    'You cannot read this Swarm.',
    statusCode: 403,
  );

  Map<String, dynamic> task({String text = brief}) => {
    ...groupData(
      chat,
      title: 'Fix the login loop',
      number: 14,
      status: 'review',
      agentIds: ['agent-builder'],
    ),
    'brief': text,
    'checks': [
      {
        'id': 'check-1',
        'description': 'The new test fails on main and passes',
        'evidence': 'Failed at abc123, passes at def456.',
        'passedBy': 'agent-builder',
      },
      {'id': 'check-2', 'description': 'Tried on a real phone'},
    ],
    'assignment': {
      'id': 'attempt-$chat',
      'agentId': 'agent-builder',
      'status': 'review',
      'result': 'PR 12 at def456.',
    },
  };

  Map<String, dynamic> step() => {
    ...groupData(
      'g2',
      title: 'Review: PR 12',
      number: 15,
      status: 'done',
      workerId: 'agent-lead',
    ),
    'reviewOf': chat,
    'step': 'Review',
    'checks': [
      {'id': 'check-r', 'description': 'Reads well', 'passedBy': 'agent-lead'},
    ],
  };

  FakeSwarm backend(List<Map<String, dynamic>> groups) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: groups);
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String conversationId = chat,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmConversationPage(
          swarmId: tab,
          conversationId: conversationId,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> openDetails(WidgetTester tester) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Work details'));
    await tester.pumpAndSettle();
  }

  testWidgets('⋮ → Work details shows the brief, the linked step, who has it, '
      'each check with its evidence, and the result', (tester) async {
    await pump(tester, backend([task(), step()]));
    await openDetails(tester);

    final page = find.byType(SwarmWorkDetailsPage);
    expect(page, findsOneWidget);
    Finder on(String text) =>
        find.descendant(of: page, matching: find.textContaining(text));
    expect(on('Fix the login loop'), findsWidgets);
    expect(on('Goal:'), findsOneWidget);
    expect(on('sent back to sign-in in a loop'), findsOneWidget);
    expect(on('Changes:'), findsOneWidget);
    expect(on('Keep the session through the redirect.'), findsOneWidget);
    expect(on('Constraints:'), findsOneWidget);
    expect(on('No new dependency.'), findsOneWidget);
    expect(on('Review (River): passed'), findsOneWidget);
    expect(on('Nova · review'), findsOneWidget);
    expect(on('Acceptance checks'), findsOneWidget);
    expect(on('The new test fails on main and passes'), findsOneWidget);
    expect(on('Failed at abc123, passes at def456.'), findsOneWidget);
    expect(on('Tried on a real phone'), findsOneWidget);
    expect(
      find.descendant(of: page, matching: find.text('Verified')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: page, matching: find.text('Not verified')),
      findsOneWidget,
    );
    expect(on('Result'), findsOneWidget);
    expect(on('PR 12 at def456.'), findsOneWidget);
    // Read only: the phone records no check.
    expect(on('Record check'), findsNothing);
    expect(
      find.descendant(of: page, matching: find.byType(TextField)),
      findsNothing,
    );
  });

  testWidgets('a task with no brief says so, as Desktop does', (tester) async {
    await pump(tester, backend([task(text: '')]));
    await openDetails(tester);

    expect(find.text('This task has no description yet.'), findsOneWidget);
    expect(find.text('Goal:'), findsNothing);
  });

  testWidgets('offered where Desktop offers it: a task chat, never a private '
      "conversation, a project's own chat or a Buddy chat", (tester) async {
    final private = {
      ...groupData('p1', title: 'Just us', audience: [me]),
    };
    final host = await pump(
      tester,
      backend([task(), private, buddyChatData('b1')]),
    );
    final reader = host.session!.inbox.reader(tab)!;

    expect(swarmHasWorkDetails(reader, chat), isTrue);
    expect(swarmHasWorkDetails(reader, 'p1'), isFalse);
    expect(swarmHasWorkDetails(reader, leadChat), isFalse);
    expect(swarmHasWorkDetails(reader, 'b1'), isFalse);
    expect(swarmHasWorkDetails(reader, 'gone'), isFalse);

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('no Work details row in a private conversation’s ⋮', (
    tester,
  ) async {
    final private = {
      ...groupData('p1', title: 'Just us', audience: [me]),
    };
    await pump(tester, backend([private]), conversationId: 'p1');
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();

    expect(find.text('Work details'), findsNothing);
  });

  testWidgets('access lost while it is open: the page goes', (tester) async {
    final fake = backend([task()]);
    final host = await pump(tester, fake);
    await openDetails(tester);
    expect(find.byType(SwarmWorkDetailsPage), findsOneWidget);

    fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
    unawaited(host.session!.inbox.reader(tab)!.refresh());
    await tester.pumpAndSettle();

    expect(find.byType(SwarmWorkDetailsPage), findsNothing);
    expect(find.text('No new dependency.'), findsNothing);
  });
}
