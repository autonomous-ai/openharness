import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Rename your Buddy from its chat's ⋮ (the desktop's Rename Buddy…,
/// `buddy.rename`): by the chat's id, a name or empty for the default, the
/// server's refusal said in the dialog, and nothing for anyone else's Buddy.
void main() {
  const chat = 'buddy-me';
  const commands = '/api/super-tabs/$tab/commands';

  /// One Swarm where the person has their Buddy chat [chatId] in Mobile,
  /// owned by [owner], named [named] (null for the default), with Wren
  /// running in it unless [running] is false; each command answers [command].
  FakeSwarm backend({
    String chatId = chat,
    String owner = me,
    String? named,
    bool running = true,
    String role = 'owner',
    FutureOr<Object?> Function(Map<String, dynamic>? body)? command,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          {
            ...buddyChatData(
              chatId,
              owner: owner,
              agentIds: [if (running) 'agent-wren'],
            ),
            'buddyName': ?named,
          },
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          if (running)
            buddyData('agent-wren', owner: owner, displayName: named ?? 'Wren'),
        ],
      ),
      'members': [
        part(me, 1, person(me, role: role)),
        part('person-dee', 1, person('person-dee', role: 'member')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$chatId/messages'] = (_) =>
        {'messages': <Object>[], 'next': null};
    fake.routes[commands] = command ?? (_) => {'result': <String, dynamic>{}};
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String chatId = chat,
  }) async {
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmConversationPage(swarmId: tab, conversationId: chatId),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  List<Map<String, dynamic>> renames(FakeSwarm fake) => [
    for (final c in fake.commands)
      if (c['type'] == 'buddy.rename') c,
  ];

  /// ⋮, then Rename Buddy: the dialog.
  Future<void> openRename(WidgetTester tester) async {
    await tester.tap(key('swarm-buddy-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rename Buddy'));
    await tester.pumpAndSettle();
  }

  String field(WidgetTester tester) =>
      tester.widget<TextField>(key('swarm-buddy-name')).controller!.text;

  group('the dialog', () {
    testWidgets('shows the name chosen, and the default as the empty '
        "field's hint", (tester) async {
      await pump(tester, backend(named: 'Juniper'));
      await openRename(tester);

      expect(find.text('Rename your Buddy'), findsOneWidget);
      expect(field(tester), 'Juniper');
      expect(
        tester.widget<TextField>(key('swarm-buddy-name')).decoration!.hintText,
        "person-me's Buddy",
      );
      expect(
        tester.widget<TextField>(key('swarm-buddy-name')).maxLength,
        32,
        reason: "the server's limit",
      );
    });

    testWidgets('Rename is offered before a Buddy runs; Remove is not', (
      tester,
    ) async {
      await pump(tester, backend(running: false));
      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      expect(find.text('Rename Buddy'), findsOneWidget);
      expect(find.text('Remove Buddy'), findsNothing);
    });
  });

  group('each case', () {
    testWidgets('Save sends the name by the chat, then the dialog closes', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), '  Juniper ');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();

      expect(renames(fake), [
        {'type': 'buddy.rename', 'conversationId': chat, 'name': 'Juniper'},
      ]);
      expect(find.text('Rename your Buddy'), findsNothing);
      expect(
        fake.paths.last,
        startsWith('/api/super-tabs/$tab/changes'),
        reason: 'the Swarm read again, so the new name shows',
      );
    });

    testWidgets('empty goes back to the default', (tester) async {
      final fake = backend(named: 'Juniper');
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), '   ');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();

      expect(renames(fake), [
        {'type': 'buddy.rename', 'conversationId': chat, 'name': null},
      ]);
      expect(find.text('Rename your Buddy'), findsNothing);
    });

    testWidgets('a name past 32 characters goes cut at 32', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), 'a' * 40);
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();
      expect(renames(fake).single['name'], 'a' * 32);
    });

    testWidgets('a name the server refuses: its words show, the dialog '
        'stays, and Save works again', (tester) async {
      var refuse = true;
      final fake = backend(
        command: (_) {
          if (refuse) {
            throw const SuperTabFailure(
              'BUDDY_NAME_TAKEN',
              'Wren is taken in this Swarm. Choose another.',
              statusCode: 409,
            );
          }
          return {'result': <String, dynamic>{}};
        },
      );
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), 'Wren');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();

      expect(
        tester.widget<Text>(key('swarm-buddy-name-error')).data,
        'Wren is taken in this Swarm. Choose another.',
      );
      expect(find.text('Rename your Buddy'), findsOneWidget);
      expect(field(tester), 'Wren', reason: 'kept to correct');
      expect(key('swarm-buddy-error'), findsNothing, reason: 'said once');

      refuse = false;
      await tester.enterText(key('swarm-buddy-name'), 'Juniper');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();
      expect(renames(fake), hasLength(2));
      expect(find.text('Rename your Buddy'), findsNothing);
    });

    testWidgets('an older server without the command: its refusal shows and '
        'the dialog stays', (tester) async {
      final fake = backend(
        command: (_) => throw const SuperTabFailure(
          'VALIDATION_ERROR',
          'Invalid discriminator value.',
          statusCode: 400,
        ),
      );
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), 'Juniper');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-buddy-name-error')).data,
        'Invalid discriminator value.',
      );
      expect(find.text('Rename your Buddy'), findsOneWidget);
    });

    testWidgets('no answer at all says to try again', (tester) async {
      final fake = backend(command: (_) => throw Exception('reset'));
      await pump(tester, fake);
      await openRename(tester);
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-buddy-name-error')).data,
        "Couldn't rename your Buddy. Try again.",
      );
    });

    testWidgets('while it saves, a second Save sends nothing more', (
      tester,
    ) async {
      final answer = Completer<Object?>();
      final fake = backend(command: (_) => answer.future);
      await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), 'Juniper');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pump();
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(renames(fake), hasLength(1));

      answer.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();
      expect(find.text('Rename your Buddy'), findsNothing);
    });
  });

  group('privacy', () {
    testWidgets("someone else's Buddy chat shows no ⋮", (tester) async {
      final fake = backend(chatId: 'buddy-dee', owner: 'person-dee');
      await pump(tester, fake, chatId: 'buddy-dee');
      expect(key('swarm-buddy-menu'), findsNothing);
      expect(find.text('Rename Buddy'), findsNothing);
      expect(renames(fake), isEmpty);
    });

    testWidgets('a viewer has no ⋮', (tester) async {
      await pump(tester, backend(role: 'viewer'));
      expect(key('swarm-buddy-menu'), findsNothing);
    });
  });

  group('lifecycle', () {
    testWidgets('access lost while the dialog is open closes it, and the '
        'late refusal says nothing', (tester) async {
      final answer = Completer<Object?>();
      final fake = backend(command: (_) => answer.future);
      final host = await pump(tester, fake);
      await openRename(tester);
      await tester.enterText(key('swarm-buddy-name'), 'Juniper');
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pump();

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(find.text('Rename your Buddy'), findsNothing);

      answer.completeError(
        const SuperTabFailure('NOT_FOUND', 'This conversation is unavailable.'),
      );
      await tester.pumpAndSettle();
      expect(find.text('This conversation is unavailable.'), findsNothing);
      expect(key('swarm-buddy-error'), findsNothing);
    });

    testWidgets('losing write access while it is open closes it', (
      tester,
    ) async {
      var role = 'owner';
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => {
        ...parts(body)! as Map<String, dynamic>,
        'members': [part(me, 1, person(me, role: role))],
      };
      final host = await pump(tester, fake);
      await openRename(tester);
      expect(find.text('Rename your Buddy'), findsOneWidget);

      role = 'viewer';
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'members': [part(me, 2, person(me, role: 'viewer'))],
      };
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(find.text('Rename your Buddy'), findsNothing);
      expect(renames(fake), isEmpty);
    });

    testWidgets('a refusal after the Swarm was read anew from nothing says '
        'nothing', (tester) async {
      final answer = Completer<Object?>();
      final fake = backend(command: (_) => answer.future);
      final host = await pump(tester, fake);
      await openRename(tester);
      await tester.tap(key('swarm-buddy-name-save'));
      await tester.pump();

      host.session!.inbox.reader(tab)!.generation++;
      answer.completeError(
        const SuperTabFailure(
          'BUDDY_NAME_TAKEN',
          'Wren is taken in this Swarm. Choose another.',
          statusCode: 409,
        ),
      );
      await tester.pumpAndSettle();
      expect(key('swarm-buddy-name-error'), findsNothing);
    });
  });
}
