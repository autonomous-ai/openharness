import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_mark.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Swarm's screens on the phone, over a scripted backend: what needs the
/// person first, a decision answered with one tap and Undo, a project's
/// conversations in order, and a post with a mention.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const dormant = '/api/super-tabs/$tab/groups?dormant=1&projectId=$project';

  /// One Swarm, project Mobile: work g1 (Nova needs the person), someone
  /// else's private chat, and one open decision and tag. Its closed work,
  /// g-old and older g-spike, is in no first load: the dormant list has it.
  FakeSwarm backend({String role = 'owner'}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        derived: derived,
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'needs_human',
            lastMessageSequence: 9,
          ),
          groupData('g-busy', title: 'Sync', lastMessageSequence: 20),
          groupData(
            'g-private',
            title: 'Their chat',
            audience: ['person-other', 'person-third'],
          ),
          groupData('g-pm', title: 'me', audience: [me]),
        ],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    final oldWork = part(
      'g-old',
      7,
      groupData('g-old', title: 'Old work', dormant: true),
    );
    fake.routes[dormant] = (_) => {
      'groups': [oldWork],
      'next': 'page-2',
    };
    fake.routes['$dormant&before=page-2'] = (_) => {
      'groups': [
        part('g-spike', 6, groupData('g-spike', title: 'Spike', dormant: true)),
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/groups/g-old'] = (_) => {
      'group': oldWork,
    };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'askerName': 'River',
          'question': 'Ship it behind a flag?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'messageId': 'msg-1',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'msg-1',
          'conversationId': 'g1',
          'text': 'Which name should the flag have?',
          'sequence': 9,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'createdAt': '2026-10-27T01:00:00.000Z',
        },
      ],
      'next': null,
    };
    return fake;
  }

  /// [home] under a signed-in shell's Swarm, with Swarm turned on.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake,
    Widget home, {
    bool on = true,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {if (on) PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  group('the Swarm page', () {
    testWidgets('what needs the person comes first, then the Swarms', (
      tester,
    ) async {
      await pump(tester, backend(), const SwarmPage());

      expect(find.text('River asks you'), findsOneWidget);
      expect(find.text('River tagged you'), findsOneWidget);
      expect(find.text('Nova needs you'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('River asks you')).dy,
        lessThan(tester.getTopLeft(key('swarm-project-$tab-$project')).dy),
      );
      expect(find.text('phone swarm'), findsOneWidget, reason: 'its caption');
      expect(
        find.text('Open chat'),
        findsOneWidget,
        reason: 'the Naming System: a Swarm chat, not a conversation',
      );
      expect(find.text('1 waiting'), findsOneWidget, reason: 'the team line');
    });

    testWidgets('an answer is held for Undo, and undone is never sent', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());

      await tester.tap(key('swarm-option-d1-0'));
      await tester.pump();
      expect(find.text('Sending “Yes”…'), findsOneWidget);

      await tester.tap(key('swarm-undo-d1'));
      await tester.pump(const Duration(seconds: 5));
      expect(fake.commands, isEmpty);
      expect(key('swarm-option-d1-0'), findsOneWidget);
    });

    testWidgets('one tap answers once the Undo window has passed', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());

      await tester.tap(key('swarm-option-d1-1'));
      await tester.pump(const Duration(seconds: 2));
      expect(fake.commands, isEmpty);
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 1,
      });
    });

    testWidgets(
      'an answer not confirmed offers only to send the same one again',
      (tester) async {
        final fake = backend();
        var lost = true;
        fake.routes['/api/super-tabs/$tab/commands'] = (_) => lost
            ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
            : {'result': <String, dynamic>{}};
        await pump(tester, fake, const SwarmPage());

        await tester.tap(key('swarm-option-d1-1'));
        await tester.pump(const Duration(seconds: 4));
        await tester.pumpAndSettle();

        expect(key('swarm-option-d1-0'), findsNothing);
        expect(key('swarm-option-d1-1'), findsNothing);
        expect(find.text('“No” is not confirmed.'), findsOneWidget);

        lost = false;
        await tester.tap(key('swarm-resend-d1'));
        await tester.pumpAndSettle();

        expect([for (final c in fake.commands) c['choice']], [1, 1]);
        final operations = {
          for (final call in fake.calls)
            if (call.method == 'POST') call.body!['operationId'],
        };
        expect(operations, hasLength(1));
      },
    );

    testWidgets('a tag is marked done from its row', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());

      await tester.tap(key('swarm-done-m1'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {'type': 'mention.done', 'mentionId': 'm1'});
    });

    testWidgets('a need opens the conversation it was asked in', (
      tester,
    ) async {
      await pump(tester, backend(), const SwarmPage());

      await tester.tap(find.text('Nova needs you'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmConversationPage), findsOneWidget);
      expect(find.text('Which name should the flag have?'), findsOneWidget);
    });

    testWidgets('with Swarm off, says where to turn it on', (tester) async {
      await pump(tester, backend(), const SwarmPage(), on: false);

      expect(key('swarm-unavailable'), findsOneWidget);
    });
  });

  group('a project', () {
    testWidgets(
      'Chat with PM and the Lead first, then work by latest, older folded',
      (tester) async {
        await pump(
          tester,
          backend(),
          const SwarmProjectPage(swarmId: tab, projectId: project),
        );
        // The project page reads what the inbox has read.
        await tester.pumpAndSettle();

        double y(String k) => tester.getTopLeft(key(k)).dy;
        expect(y('swarm-pm-chat'), lessThan(y('swarm-lead-chat')));
        expect(
          find.descendant(
            of: key('swarm-lead-chat'),
            matching: find.text('Product Manager'),
          ),
          findsOneWidget,
          reason: 'the Naming System: Product Manager on screen, never Lead',
        );
        expect(y('swarm-lead-chat'), lessThan(y('swarm-conversation-g-busy')));
        expect(
          y('swarm-conversation-g-busy'),
          lessThan(y('swarm-conversation-g1')),
          reason: 'the latest activity first',
        );
        expect(key('swarm-conversation-g-old'), findsNothing);
        expect(
          key('swarm-conversation-g-private'),
          findsNothing,
          reason: 'a private chat is for its people only',
        );
        expect(
          key('swarm-conversation-g-pm'),
          findsNothing,
          reason: 'Chat with PM is pinned, not listed again',
        );

        await tester.tap(key('swarm-older'));
        await tester.pumpAndSettle();
        expect(key('swarm-conversation-g-old'), findsOneWidget);
        expect(key('swarm-conversation-g-spike'), findsNothing);

        await tester.tap(key('swarm-older-earlier'));
        await tester.pumpAndSettle();
        expect(key('swarm-conversation-g-spike'), findsOneWidget);
        expect(key('swarm-older-earlier'), findsNothing);
      },
    );

    testWidgets('the team line opens each agent in a word', (tester) async {
      await pump(
        tester,
        backend(),
        const SwarmProjectPage(swarmId: tab, projectId: project),
      );
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-team-line'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmTeamPage), findsOneWidget);
      expect(key('swarm-agent-agent-builder'), findsOneWidget);
      expect(find.text('Waiting'), findsOneWidget);
    });
  });

  group('a conversation', () {
    testWidgets('posts text to the agent it mentions', (tester) async {
      final fake = backend();
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-mention'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nova').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '@Nova use beta');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': '@Nova use beta',
        'replyTo': null,
        'recipientIds': ['agent-builder'],
      });
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
    });

    testWidgets('a refused post says why, even before any message', (
      tester,
    ) async {
      final fake = backend();
      fake.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure(
            'READ_ONLY',
            'This conversation is read only.',
            statusCode: 403,
          );
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'hello');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(key('swarm-post-error'), findsOneWidget);
      expect(find.text('This conversation is read only.'), findsOneWidget);
    });

    testWidgets('the decision asked in it is answered in it', (tester) async {
      await pump(
        tester,
        backend(),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ship it behind a flag?'), findsOneWidget);
      expect(key('swarm-option-d1-0'), findsOneWidget);
    });

    testWidgets('a viewer reads it and cannot post', (tester) async {
      await pump(
        tester,
        backend(role: 'viewer'),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsOneWidget);
      expect(key('swarm-send'), findsNothing);
      expect(key('swarm-read-only'), findsOneWidget);
      expect(
        find.text('You can read this chat, not post in it.'),
        findsOneWidget,
      );
    });

    testWidgets('one the person can no longer read shows nothing of it, '
        'its decision included', (tester) async {
      final fake = backend();
      final host = await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'my reply');
      expect(find.text('Which name should the flag have?'), findsOneWidget);
      expect(find.text('Ship it behind a flag?'), findsOneWidget);

      // Taken out of g1: the Swarm is read again in full without it, and
      // the decision list has not caught up yet.
      final full = fake.routes['/api/super-tabs/$tab/parts']!(null)! as Map;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...full,
        'groups': [
          for (final g in full['groups'] as List)
            if ((g as Map)['key'] != 'g1') g,
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsNothing);
      expect(find.text('Ship it behind a flag?'), findsNothing);
      expect(find.text('my reply'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
    });

    testWidgets('its Swarm is read often only while the chat is on screen '
        'and Harness is in front', (tester) async {
      final host = await pump(
        tester,
        backend(),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      final reader = host.session!.inbox.reader(tab)!;
      expect(reader.shown, isFalse, reason: 'Harness is behind');

      host.foreground = true;
      expect(reader.shown, isTrue);

      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      unawaited(
        navigator.push(
          MaterialPageRoute<void>(builder: (_) => const Scaffold()),
        ),
      );
      await tester.pumpAndSettle();
      expect(reader.shown, isFalse, reason: 'another screen covers it');

      navigator.pop();
      await tester.pumpAndSettle();
      expect(reader.shown, isTrue);

      host.foreground = false;
      expect(reader.shown, isFalse);
    });

    testWidgets('a closed one opened from a notice reads its name', (
      tester,
    ) async {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/conversations/g-old/messages'] = (_) =>
          {'messages': <Object>[], 'next': null};
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g-old'),
      );
      await tester.pumpAndSettle();

      expect(fake.paths, contains('/api/super-tabs/$tab/groups/g-old'));
      expect(find.text('Old work'), findsOneWidget);
      expect(find.text('This chat is not open to you.'), findsNothing);
    });

    testWidgets('one in a Swarm the person left shows nothing of it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'my reply');

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsNothing);
      expect(find.text('my reply'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
    });
  });

  group("Home's Swarm mark", () {
    testWidgets('counts what needs the person, and opens Swarm', (
      tester,
    ) async {
      final host = await pump(
        tester,
        backend(),
        const Scaffold(body: Center(child: SwarmMark())),
      );
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('3'), findsOneWidget);

      await tester.tap(key('swarm-mark'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmPage), findsOneWidget);
    });

    testWidgets('is not there while Swarm is off', (tester) async {
      await pump(
        tester,
        backend(),
        const Scaffold(body: Center(child: SwarmMark())),
        on: false,
      );

      expect(key('swarm-mark'), findsNothing);
    });
  });
}
