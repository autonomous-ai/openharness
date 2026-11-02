import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_chat_manage.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Rename and Archive on the phone, as the desktop's chat menu has them
/// (Tony 11-01, task 11): in the chat's ⋮, for someone who may write, in an
/// ordinary project chat; Archive asks first, and the chat goes to "Older".
void main() {
  const chat = 'g1';
  late FakeSwarm swarm;
  late SwarmHost host;
  late String title;
  late bool archived;
  String? status;
  var version = 2;

  /// What the next command answers instead of the server, once.
  FutureOr<Object?> Function()? answer;

  /// The parts read fails while this is set.
  SuperTabFailure? partsFail;

  Map<String, dynamic> chatData() => {
    ...groupData(chat, title: title, number: 7, status: status),
    'archived': archived,
  };

  Future<void> pump(
    WidgetTester tester, {
    String role = 'owner',
    String conversationId = chat,
    String? taskStatus,
    bool firstLoadFails = false,
    bool settle = true,
  }) async {
    title = 'Fix login flake';
    archived = false;
    status = taskStatus;
    version = 2;
    answer = null;
    partsFail = firstLoadFails
        ? const SuperTabFailure(
            'UNAVAILABLE',
            'Swarm is busy.',
            statusCode: 503,
          )
        : null;
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) {
      if (partsFail case final failure?) throw failure;
      return {
        ...firstLoad(groups: [chatData()]),
        'members': [part(me, 1, person(me, role: role))],
      };
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) {
      version++;
      return changes(
        cursor: 'c$version',
        groups: [part(chat, version, chatData())],
      );
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    for (final id in [chat, leadChat]) {
      swarm.routes['/api/super-tabs/$tab/conversations/$id/messages'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
    }
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (answer case final once?) {
        answer = null;
        return once();
      }
      switch (command['type']) {
        case 'conversation.rename':
          if (archived) {
            throw const SuperTabFailure(
              'ARCHIVED',
              'Reopen this conversation before changing its work.',
            );
          }
          title = command['title'] as String;
        case 'conversation.archive':
          archived = command['archived'] as bool;
      }
      return {'ok': true};
    };
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
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
        home: Scaffold(
          body: SwarmConversationPage(
            swarmId: tab,
            conversationId: conversationId,
          ),
        ),
      ),
    );
    // A failed read keeps its placeholders moving: no settling then.
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }
  }

  SwarmReader reader() => host.session!.inbox.reader(tab)!;
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> menu(WidgetTester tester) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
  }

  Future<void> rename(WidgetTester tester) async {
    await menu(tester);
    await tester.tap(find.text('Rename'));
    await tester.pumpAndSettle();
    expect(key('swarm-chat-title'), findsOneWidget);
  }

  List<Map<String, dynamic>> sent(String type) => [
    for (final c in swarm.commands)
      if (c['type'] == type) c,
  ];

  group('who may', () {
    testWidgets('an owner of an ordinary chat gets Rename and Archive above '
        'Notifications', (tester) async {
      await pump(tester);
      await menu(tester);
      expect(find.text('Rename'), findsOneWidget);
      expect(find.text('Archive'), findsOneWidget);
      expect(find.text('All new messages'), findsOneWidget);
    });

    testWidgets('a viewer gets Notifications alone', (tester) async {
      await pump(tester, role: 'viewer');
      await menu(tester);
      expect(find.text('Rename'), findsNothing);
      expect(find.text('Archive'), findsNothing);
      expect(find.text('All new messages'), findsOneWidget);
    });

    testWidgets('the project\'s own chat is neither renamed nor archived '
        'here', (tester) async {
      await pump(tester);
      expect(swarmChatManage(reader(), leadChat), isNull);
      expect(swarmChatManage(reader(), chat), isNotNull);
    });

    testWidgets('a Buddy chat is neither renamed nor archived here', (
      tester,
    ) async {
      await pump(tester);
      final buddyChat = reader().snapshot!.conversation(chat)!;
      expect(buddyChat.isBuddyChat, isFalse);
      // The same chat, sent as the reader's Buddy chat.
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            {...chatData(), 'kind': 'buddy', 'buddyOwnerId': me},
          ],
        ),
      };
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c9'),
        'reload': true,
      };
      await reader().refresh();
      await tester.pumpAndSettle();
      expect(reader().snapshot!.conversation(chat)!.isBuddyChat, isTrue);
      expect(swarmChatManage(reader(), chat), isNull);
    });

    testWidgets('Archive is off while the chat\'s task still runs, and on '
        'once it is done', (tester) async {
      await pump(tester, taskStatus: 'working');
      expect(swarmChatManage(reader(), chat)!.archiveOn, isFalse);
      await menu(tester);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(key('swarm-archive-confirm'), findsNothing);

      status = 'done';
      await reader().refresh();
      await tester.pumpAndSettle();
      expect(swarmChatManage(reader(), chat)!.archiveOn, isTrue);
    });
  });

  group('rename', () {
    testWidgets('a new title is the server\'s at once, in the header', (
      tester,
    ) async {
      await pump(tester);
      await rename(tester);
      expect(
        tester.widget<TextField>(key('swarm-chat-title')).controller!.text,
        'Fix login flake',
      );
      await tester.enterText(key('swarm-chat-title'), '  Login flake fix ');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await settle(tester);

      expect(sent('conversation.rename'), [
        {
          'type': 'conversation.rename',
          'conversationId': chat,
          'title': 'Login flake fix',
        },
      ]);
      expect(key('swarm-chat-title'), findsNothing);
      expect(reader().snapshot!.conversation(chat)!.title, 'Login flake fix');
      // The header says it as the chat's number and title.
      expect(find.text('#7 Login flake fix'), findsOneWidget);
    });

    testWidgets('a refused title says why under the field and stays open', (
      tester,
    ) async {
      await pump(tester);
      await rename(tester);
      answer = () => throw const SuperTabFailure(
        'INVALID_COMMAND',
        'Use a title of 160 characters or fewer.',
        statusCode: 400,
      );
      await tester.enterText(key('swarm-chat-title'), 'Another');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await settle(tester);

      expect(
        tester.widget<Text>(key('swarm-chat-title-error')).data,
        'Use a title of 160 characters or fewer.',
      );
      expect(key('swarm-chat-title'), findsOneWidget);
      expect(reader().snapshot!.conversation(chat)!.title, 'Fix login flake');
    });

    testWidgets('an empty title cannot be saved', (tester) async {
      await pump(tester);
      await rename(tester);
      await tester.enterText(key('swarm-chat-title'), '   ');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await settle(tester);
      expect(sent('conversation.rename'), isEmpty);
    });

    testWidgets('offline: a call lost on the way says so, never stays '
        'Saving', (tester) async {
      await pump(tester);
      await rename(tester);
      answer = () => throw TimeoutException('no answer');
      await tester.enterText(key('swarm-chat-title'), 'Another');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await settle(tester);
      expect(find.text('Could not reach this Swarm. Try again.'), findsOne);
      expect(find.text('Saving…'), findsNothing);
    });

    testWidgets('a title at the 160-character limit saves; one longer is cut '
        'to fit', (tester) async {
      await pump(tester);
      await rename(tester);
      final longest = 'a' * 160;
      await tester.enterText(key('swarm-chat-title'), '');
      await tester.enterText(key('swarm-chat-title'), '${longest}b');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await settle(tester);
      expect(sent('conversation.rename').single['title'], longest);
      expect(reader().snapshot!.conversation(chat)!.title, longest);
    });
  });

  group('archive', () {
    testWidgets('asks first; Cancel changes nothing', (tester) async {
      await pump(tester);
      await menu(tester);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(find.text('Archive “Fix login flake”?'), findsOneWidget);
      expect(
        find.text('It leaves your chat lists. You can reopen it from Older.'),
        findsOneWidget,
      );
      await tester.tap(key('swarm-archive-cancel'));
      await settle(tester);
      expect(sent('conversation.archive'), isEmpty);
      expect(reader().snapshot!.conversation(chat)!.archived, isFalse);
    });

    testWidgets('Archive archives: the chat leaves the lists for Older, '
        'and its page says so', (tester) async {
      await pump(tester);
      await menu(tester);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-archive-confirm'));
      await settle(tester);

      expect(sent('conversation.archive'), [
        {
          'type': 'conversation.archive',
          'conversationId': chat,
          'archived': true,
        },
      ]);
      final snapshot = reader().snapshot!;
      final work = swarmProjectWork(snapshot, snapshot.projects.single);
      expect(work.active.map((g) => g.id), isNot(contains(chat)));
      expect(work.older.map((g) => g.id), contains(chat));
      expect(find.text('This chat is archived.'), findsOneWidget);

      // Reopen from its ⋮, with no Rename while archived.
      await menu(tester);
      expect(find.text('Rename'), findsNothing);
      await tester.tap(find.text('Reopen'));
      await settle(tester);
      expect(sent('conversation.archive').last['archived'], isFalse);
      expect(reader().snapshot!.conversation(chat)!.archived, isFalse);
    });

    testWidgets('a refusal says why at the foot of the screen', (tester) async {
      await pump(tester);
      await menu(tester);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      answer = () => throw const SuperTabFailure(
        'WORK_ACTIVE',
        'Resolve the active assignment before archiving this conversation.',
      );
      await tester.tap(key('swarm-archive-confirm'));
      await settle(tester);
      expect(
        find.text(
          'Resolve the active assignment before archiving this conversation.',
        ),
        findsOneWidget,
      );
      expect(reader().snapshot!.conversation(chat)!.archived, isFalse);
    });
  });

  group('elsewhere and lost', () {
    testWidgets('archived on another screen while Rename is open: the '
        'dialog goes, and the page says it is archived', (tester) async {
      await pump(tester);
      await rename(tester);
      archived = true;
      await reader().refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-chat-title'), findsNothing);
      expect(find.text('This chat is archived.'), findsOneWidget);
    });

    testWidgets('archived on another screen while the confirm is open: '
        'it goes, and nothing is sent', (tester) async {
      await pump(tester);
      await menu(tester);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      // Taken away from this person meanwhile: no longer theirs to archive.
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) {
        version++;
        return {
          ...changes(cursor: 'c$version'),
          'members': [part(me, version, person(me, role: 'viewer'))],
        };
      };
      await reader().refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-archive-confirm'), findsNothing);
      expect(sent('conversation.archive'), isEmpty);
    });

    testWidgets('access lost with Rename open: it closes, and nothing of '
        'the chat stays', (tester) async {
      await pump(tester);
      await rename(tester);
      reader().revoke();
      await tester.pumpAndSettle();
      expect(key('swarm-chat-title'), findsNothing);
      expect(key('swarm-chat-menu'), findsNothing);
      expect(find.textContaining('Fix login flake'), findsNothing);
    });

    testWidgets('an answer that lands after access was lost shows nothing '
        'and reads nothing', (tester) async {
      await pump(tester);
      await rename(tester);
      final held = Completer<Object?>();
      answer = () => held.future;
      await tester.enterText(key('swarm-chat-title'), 'Another');
      await tester.pump();
      await tester.tap(key('swarm-chat-title-save'));
      await tester.pump();
      reader().revoke();
      await tester.pumpAndSettle();
      final calls = swarm.calls.length;
      held.completeError(
        const SuperTabFailure('FORBIDDEN', 'You cannot read this Swarm.'),
      );
      await settle(tester);
      expect(find.text('You cannot read this Swarm.'), findsNothing);
      expect(swarm.calls.length, calls);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an archive that lands after access was lost says nothing', (
      tester,
    ) async {
      await pump(tester);
      // Asked from a screen that stays (the page's own Scaffold), so only the
      // lost access keeps the late refusal off it.
      final screen = tester.element(find.byType(Scaffold).first);
      unawaited(confirmSwarmArchiveChat(screen, reader(), chat));
      await tester.pumpAndSettle();
      final held = Completer<Object?>();
      answer = () => held.future;
      await tester.tap(key('swarm-archive-confirm'));
      await tester.pump();
      reader().revoke();
      held.completeError(
        const SuperTabFailure('FORBIDDEN', 'You cannot read this Swarm.'),
      );
      await settle(tester);
      expect(find.text('You cannot read this Swarm.'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a first read that failed and then recovers still offers '
        'Rename', (tester) async {
      await pump(tester, firstLoadFails: true, settle: false);
      expect(key('swarm-chat-menu'), findsNothing);
      partsFail = null;
      await reader().refresh();
      await tester.pumpAndSettle();
      await rename(tester);
    });
  });
}
