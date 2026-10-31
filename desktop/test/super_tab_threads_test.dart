import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Threads in Swarm chat: a reply files under its root and opens in a panel
/// beside the chat (Dee, 2026-10-29).
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    String account = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: account);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

  /// A root by the owner, two replies to it (one by [replyAuthor]), and a
  /// later top-level note.
  ConversationServer threaded({
    Map<String, Object> replyAuthor = peer,
    bool alsoSend = false,
  }) {
    final server = ConversationServer()..threads = true;
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = peer;
    server.append('Agreed.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-2'
      ..['author'] = replyAuthor;
    if (alsoSend) server.messages.last['alsoInChat'] = true;
    server.append('Next topic.');
    return server;
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder line(String root) => find.byKey(ValueKey('super-thread-line-$root'));
  Finder panel() => find.byKey(const ValueKey('super-thread-panel'));
  Finder inPanel(Finder finder) =>
      find.descendant(of: panel(), matching: finder);
  FontWeight? countWeight(WidgetTester tester, String root) => tester
      .widget<Text>(find.byKey(ValueKey('super-thread-count-$root')))
      .style
      ?.fontWeight;

  testWidgets('the main chat shows a root once with its reply line and '
      'leaves its thread replies out', (tester) async {
    await show(tester, threaded());
    expect(row('message-1'), findsOneWidget);
    expect(row('message-2'), findsNothing);
    expect(row('message-3'), findsNothing);
    expect(row('message-4'), findsOneWidget);
    expect(
      find.descendant(of: line('message-1'), matching: find.text('2 replies')),
      findsOneWidget,
    );
    expect(line('message-4'), findsNothing);
  });

  testWidgets('a reply also sent to the chat shows in both, marked as a '
      'thread reply', (tester) async {
    await show(tester, threaded(alsoSend: true));
    expect(row('message-3'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-thread-also-message-3')),
      findsOneWidget,
    );
    // Counted once in the thread.
    expect(
      find.descendant(of: line('message-1'), matching: find.text('2 replies')),
      findsOneWidget,
    );
  });

  testWidgets('the reply line opens the thread beside the chat, and its '
      'close button closes it', (tester) async {
    await show(tester, threaded());
    expect(panel(), findsNothing);
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    expect(inPanel(find.text('Thread')), findsOneWidget);
    expect(inPanel(find.text('Should we do thread replies?')), findsOneWidget);
    expect(inPanel(find.text('2 replies')), findsOneWidget);
    expect(inPanel(find.text('Yes, like Slack.')), findsOneWidget);
    expect(inPanel(find.text('Agreed.')), findsOneWidget);
    // The main chat still shows the root, not its replies.
    expect(row('message-2'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-thread-close')));
    await tester.pumpAndSettle();
    expect(panel(), findsNothing);
  });

  testWidgets('lost access closes the thread and forgets its rows and '
      'summaries', (tester) async {
    final c = await show(tester, threaded());
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    c.revokeAccess('Access removed.');
    await tester.pumpAndSettle();
    expect(panel(), findsNothing);
    expect(c.openedThread, isNull);
    expect(c.threadMessages('message-1'), isEmpty);
    expect(c.thread('lead', 'message-1'), isNull);
    expect(find.text('Agreed.'), findsNothing);
  });

  testWidgets('a thread read answered after access was lost is dropped', (
    tester,
  ) async {
    final server = threaded();
    final c = await show(tester, server);
    server.holdReads = Completer<void>();
    await tester.tap(line('message-1'));
    await tester.pump();
    c.revokeAccess('Access removed.');
    // The answer arrives as the thread is reopened, before the next frame.
    c.openedThread = (conversationId: 'lead', root: 'message-1');
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    c.openedThread = null;
    expect(c.threadMessages('message-1'), isEmpty);
    expect(c.thread('lead', 'message-1'), isNull);
  });

  testWidgets('a long thread reads back on opening, and "Show earlier '
      'replies" reads the rest', (tester) async {
    final server = threaded()..messagePage = 2;
    for (var i = 1; i <= 12; i++) {
      server.append('Reply $i');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
    }
    final c = await show(tester, server);
    // The root is older than the chat's newest page.
    c.openThread('message-1');
    await tester.pumpAndSettle();
    List<String> texts() =>
        c.threadMessages('message-1').map((m) => m.text).toList();
    // Five pages of two, newest first, and the root read on its own.
    expect(texts().first, 'Should we do thread replies?');
    expect(texts(), containsAllInOrder(['Reply 3', 'Reply 12']));
    expect(texts(), isNot(contains('Reply 2')));
    final earlier = find.byKey(const ValueKey('super-thread-earlier'));
    for (var i = 0; i < 5 && earlier.evaluate().isNotEmpty; i++) {
      await tester.ensureVisible(earlier);
      await tester.tap(earlier);
      await tester.pumpAndSettle();
    }
    expect(earlier, findsNothing);
    expect(
      texts(),
      containsAllInOrder([
        'Should we do thread replies?',
        'Yes, like Slack.',
        'Agreed.',
        'Reply 1',
        'Reply 12',
      ]),
    );
    expect(texts(), hasLength(15));
  });

  testWidgets('review: revoking access removes the open thread content', (
    tester,
  ) async {
    final c = await show(tester, threaded());
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(inPanel(find.text('Agreed.')), findsOneWidget);
    c.revokeAccess('Access removed');
    await tester.pumpAndSettle();
    expect(find.text('Agreed.'), findsNothing);
    expect(panel(), findsNothing);
    expect(c.threadMessages('message-1'), isEmpty);
  });

  testWidgets('review: an older thread reply remains reachable', (
    tester,
  ) async {
    final server = threaded()..messagePage = 3;
    // Keep the root in the main feed while the thread exceeds a page.
    final c = await show(tester, server);
    await c.loadMessages('lead', older: true);
    await tester.pumpAndSettle();
    for (var i = 0; i < 8; i++) {
      server.append('Later thread reply $i');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
    }
    c.openThread('message-1');
    await tester.pumpAndSettle();
    // A thread needs a way to read replies between the cached page and its
    // newest page.
    expect(
      c
          .threadMessages('message-1')
          .any((m) => m.text == 'Later thread reply 0'),
      isTrue,
    );
  });

  testWidgets('review: reply line exposes an accessible activation', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabThreadLine(
            thread: SuperTabThread.fromJson({
              'id': 'root',
              'replies': 2,
              'lastSequence': 4,
              'authors': [],
              'people': [],
            }),
            unread: true,
            onOpen: () {},
          ),
        ),
      ),
    );
    final node = tester.getSemantics(
      find.bySemanticsLabel('2 replies, unread'),
    );
    expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    // Released inside the test: Flutter checks for a live handle before
    // tear-down runs.
    semantics.dispose();
  });

  testWidgets('the reply line and "Replied in thread" are reached by Tab and '
      'open the thread with Enter or Space', (tester) async {
    final c = await show(tester, threaded(alsoSend: true));
    Future<void> focus(Finder link) async {
      final node = Focus.of(
        tester.element(
          find.descendant(of: link, matching: find.byType(Text)).first,
        ),
      );
      node.requestFocus();
      await tester.pump();
      expect(node.hasFocus, isTrue);
    }

    await focus(line('message-1'));
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, 'message-1');
    c.closeThread();
    await tester.pumpAndSettle();

    await focus(find.byKey(const ValueKey('super-thread-also-message-3')));
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, 'message-1');
  });

  group('the replies row shows each replier as their own messages do', () {
    const river = {
      'kind': 'agent',
      'id': 'river',
      'name': 'Lead',
      'displayName': 'River',
    };
    const gone = {'kind': 'person', 'id': 'gone', 'name': 'gone@example.com'};
    Map<String, dynamic> riverRow({String displayName = 'River'}) => {
      'id': 'river',
      'projectId': 'lead',
      'name': 'Lead',
      'displayName': displayName,
      'machineId': 'm',
      'harnessId': 'h-river',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude', 'model': 'opus'},
      'avatar': {'kind': 'preset', 'key': 'owl'},
    };

    /// A root by the owner answered by [peer], who has a picture and a
    /// status, the agent River, and someone no longer in the Swarm.
    ConversationServer answered({
      Map<String, Object> peerAvatar = const {
        'kind': 'upload',
        'url': 'https://storage.googleapis.com/avatars/peer?X-Goog-Expires=3600&X-Goog-Signature=fixture',
      },
    }) {
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'username': 'pia',
        'role': 'collaborator',
        'avatar': peerAvatar,
        'status': {'text': 'Coffee break', 'emoji': '☕'},
      });
      (server.state['agents'] as List).add(riverRow());
      server.append('Who wants this?');
      for (final author in [gone, river, peer]) {
        server.append('Me.');
        server.messages.last
          ..['thread'] = 'message-1'
          ..['replyTo'] = 'message-1'
          ..['author'] = author;
      }
      return server;
    }

    List<SuperTabAvatar> faces(WidgetTester tester) => tester
        .widgetList<SuperTabAvatar>(
          find.descendant(
            of: line('message-1'),
            matching: find.byType(SuperTabAvatar),
          ),
        )
        .toList();

    testWidgets('a person their uploaded picture and status, an agent its '
        'avatar, and someone who left the face their name gives', (
      tester,
    ) async {
      await show(tester, answered());
      final [person, agent, left] = faces(tester);
      expect(person.identity, 'person:peer');
      expect(person.name, 'pia');
      expect(person.picture, isA<SuperTabUploadedAvatar>());
      expect(person.status?.text, 'Coffee break');
      expect(agent.identity, 'agent:river');
      expect(agent.name, 'River');
      expect(agent.picture, isA<SuperTabPresetAvatar>());
      expect(agent.pattern, isTrue);
      // The row names the engine already where an agent writes; its reply
      // line does not badge it either.
      expect(agent.engine, isNull);
      expect(left.identity, 'person:gone');
      expect(left.name, 'gone');
      expect(left.picture, isNull);
      expect(left.status, isNull);
      // Its size is unchanged.
      expect(
        tester.getSize(find.byWidget(person)).width,
        grid.AppDesktop.iconSize,
      );
    });

    testWidgets('a person with a preset shows it', (tester) async {
      await show(
        tester,
        answered(peerAvatar: const {'kind': 'preset', 'key': 'fox'}),
      );
      expect(
        find.descendant(of: line('message-1'), matching: find.text('🦊')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: line('message-1'), matching: find.text('🦉')),
        findsOneWidget,
      );
    });

    testWidgets('a person who leaves and an agent removed while the chat is '
        'open fall back on the next read, and a renamed agent follows', (
      tester,
    ) async {
      final server = answered(
        peerAvatar: const {'kind': 'preset', 'key': 'fox'},
      );
      final c = await show(tester, server);
      expect(faces(tester).first.picture, isNotNull);
      (server.state['people'] as List).removeWhere(
        (p) => (p as Map)['id'] == 'peer',
      );
      server.state['agents'] = [riverRow(displayName: 'Rio')];
      await c.refresh();
      await tester.pumpAndSettle();
      var [person, agent, _] = faces(tester);
      expect(person.picture, isNull);
      expect(person.status, isNull);
      expect(person.name, 'peer');
      expect(agent.name, 'Rio');
      expect(agent.picture, isA<SuperTabPresetAvatar>());
      server.state['agents'] = <dynamic>[];
      await c.refresh();
      await tester.pumpAndSettle();
      [_, agent, _] = faces(tester);
      expect(agent.picture, isNull);
      expect(agent.pattern, isTrue);
      expect(agent.name, 'River');
      expect(find.text('🦊'), findsNothing);
      expect(find.text('🦉'), findsNothing);
    });
  });

  testWidgets('the reply line is a button assistive technology can press', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    var opened = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabThreadLine(
            thread: SuperTabThread.fromJson({
              'id': 'm1',
              'replies': 2,
              'lastSequence': 3,
              'authors': [peer],
              'people': ['peer'],
            }),
            unread: true,
            onOpen: () => opened++,
          ),
        ),
      ),
    );
    final node = find.semantics.byLabel('2 replies, unread');
    expect(node, findsOne);
    expect(
      tester.getSemantics(find.bySemanticsLabel('2 replies, unread')),
      isSemantics(
        isButton: true,
        hasTapAction: true,
        label: '2 replies, unread',
      ),
    );
    tester.semantics.tap(node);
    expect(opened, 1);
    handle.dispose();
  });

  testWidgets('a link to a reply that lives only in its thread opens that '
      'thread', (tester) async {
    final c = await show(tester, threaded());
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'lead',
        messageId: 'message-3',
      ),
    );
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, 'message-1');
    expect(inPanel(find.text('Agreed.')), findsOneWidget);
    expect(find.text('Message unavailable'), findsNothing);
  });

  testWidgets('in a window too narrow for the side, the thread opens over '
      'the chat and a click beside it closes it', (tester) async {
    await show(tester, threaded());
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    await tester.pumpAndSettle();
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    expect(inPanel(find.text('Agreed.')), findsOneWidget);
    await tester.tapAt(const Offset(40, 400));
    await tester.pumpAndSettle();
    expect(panel(), findsNothing);
  });

  testWidgets('a reply from the thread composer goes to the root, and '
      '"Also send to the project chat" sends it to both', (tester) async {
    final server = threaded();
    final c = await show(tester, server);
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(inPanel(find.text('Also send')), findsOneWidget);
    expect(
      inPanel(find.byTooltip('Also send to the project chat')),
      findsOneWidget,
    );
    await tester.enterText(
      find.byKey(const ValueKey('super-thread-composer')),
      'In the thread only.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('super-thread-send')));
    await tester.pumpAndSettle();
    Map sentLast() => server.posts
        .map((post) => post['command'] as Map)
        .lastWhere((command) => command['type'] == 'message.send');
    final sent = sentLast();
    expect(sent['replyTo'], 'message-1');
    expect(sent.containsKey('alsoSend'), isFalse);
    expect(inPanel(find.text('In the thread only.')), findsOneWidget);
    expect(row('message-5'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('super-thread-also-send')));
    await tester.enterText(
      find.byKey(const ValueKey('super-thread-composer')),
      'Everyone should see this.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('super-thread-send')));
    await tester.pumpAndSettle();
    expect(sentLast()['alsoSend'], isTrue);
    expect(inPanel(find.text('Everyone should see this.')), findsOneWidget);
    expect(row('message-6'), findsOneWidget);
    expect(
      find.descendant(of: line('message-1'), matching: find.text('4 replies')),
      findsOneWidget,
    );
    expect(c.messages('lead').map((m) => m.id), contains('message-6'));
    // The read mark's save.
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('Reply on a message opens its thread; on a message from before '
      'threads it keeps the inline reply', (tester) async {
    final server = threaded();
    server.append('Written before threads.');
    server.messages.last['thread'] = null;
    await show(tester, server);
    await tester.tap(
      find.descendant(of: row('message-4'), matching: find.byTooltip('Reply')),
      warnIfMissed: false,
    );
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    expect(inPanel(find.text('Next topic.')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-thread-close')));
    await tester.pumpAndSettle();

    await tester.tap(
      find.descendant(of: row('message-5'), matching: find.byTooltip('Reply')),
      warnIfMissed: false,
    );
    await tester.pumpAndSettle();
    expect(panel(), findsNothing);
    expect(find.text('Replying to owner'), findsOneWidget);
  });

  testWidgets('a reply from someone else marks the thread unread for a '
      'person who wrote in it, until they open it', (tester) async {
    await show(tester, threaded());
    expect(countWeight(tester, 'message-1'), FontWeight.w700);
    await tester.tap(line('message-1'));
    await tester.pumpAndSettle();
    expect(countWeight(tester, 'message-1'), isNot(FontWeight.w700));
  });

  testWidgets('a thread opened only on another device draws its reply line '
      'unbolded here, and bold again for a newer reply', (tester) async {
    final server = threaded();
    server.markThreadReadElsewhere('lead', 'message-1', 3);
    final c = await show(tester, server);
    expect(countWeight(tester, 'message-1'), isNot(FontWeight.w700));
    server.append('Another thought.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = peer;
    await c.refresh();
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(countWeight(tester, 'message-1'), FontWeight.w700);
    // The device's save waits on a timer.
    await tester.pump(const Duration(minutes: 1));
  });

  testWidgets('a thread the reader neither wrote in nor was tagged in is '
      'never bold', (tester) async {
    final server = threaded();
    (server.state['people'] as List).add({
      'id': 'third',
      'email': 'third@example.com',
      'role': 'collaborator',
    });
    await show(tester, server, account: 'third');
    expect(countWeight(tester, 'message-1'), isNot(FontWeight.w700));
  });

  testWidgets('the reader\'s own last reply leaves the thread read', (
    tester,
  ) async {
    await show(
      tester,
      threaded(
        replyAuthor: {
          'kind': 'person',
          'id': 'owner',
          'name': 'owner@example.com',
        },
      ),
    );
    expect(countWeight(tester, 'message-1'), isNot(FontWeight.w700));
  });

  test('a thread read on another device, with no mark kept here, shows as '
      'read', () async {
    final server = threaded();
    // The reader read the whole chat elsewhere, up to its last message.
    server.markReadElsewhere('lead', server.revision);
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await c.loadMessages('lead');
    final thread = c.thread('lead', 'message-1')!;
    // The last reply is the peer's, so only the read mark keeps it quiet.
    expect(thread.authors.first['id'], 'peer');
    expect(thread.lastSequence, 3);
    expect(c.readMark('lead'), server.revision);
    expect(c.threadUnread(thread), isFalse);
  });

  test(
    'a reply past the mark read on another device is still unread',
    () async {
      final server = threaded();
      server.markReadElsewhere('lead', 2);
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await c.loadMessages('lead');
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isTrue);
    },
  );

  test(
    'another person\'s read mark never reads the reader\'s thread',
    () async {
      final server = threaded();
      server.markReadElsewhere('lead', server.revision, reader: 'peer');
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await c.loadMessages('lead');
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isTrue);
    },
  );

  group('thread marks kept on the server', () {
    Future<SuperTabController> read(ConversationServer server) async {
      final c = server.controller();
      addTearDown(() async {
        await pumpEventQueue();
        c.dispose();
      });
      await c.refresh();
      await c.loadMessages('lead');
      return c;
    }

    /// A reply in message-1's thread from the peer, as a poll brings it.
    Future<void> peerReplies(
      ConversationServer server,
      SuperTabController c,
    ) async {
      server.append('One more thing.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
      await c.refresh();
      await c.loadMessages('lead');
    }

    test('a thread opened only on another device reads as read here; a later '
        'reply past it is unread', () async {
      final server = threaded();
      // The chat itself was not read anywhere past the root.
      server.markReadElsewhere('lead', 1);
      server.markThreadReadElsewhere('lead', 'message-1', 3);
      final c = await read(server);
      expect(c.threadReadMark('message-1'), 3);
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isFalse);
      await peerReplies(server, c);
      expect(c.thread('lead', 'message-1')!.lastSequence, 5);
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isTrue);
    });

    test(
      'another person\'s thread mark never reads the reader\'s thread',
      () async {
        final server = threaded();
        server.markReadElsewhere('lead', 1);
        server.markThreadReadElsewhere('lead', 'message-1', 3, reader: 'peer');
        final c = await read(server);
        expect(c.snapshot!.threadMarks, isEmpty);
        expect(c.threadUnread(c.thread('lead', 'message-1')!), isTrue);
      },
    );

    test('opening a thread sends its mark once, forward only', () async {
      final server = threaded();
      server.markReadElsewhere('lead', 1);
      final c = await read(server);
      c.select('lead');
      c.openThread('message-1');
      await pumpEventQueue();
      c.closeThread();
      c.openThread('message-1');
      await pumpEventQueue();
      expect(server.threadMarkPosts, [
        {'conversationId': 'lead', 'root': 'message-1', 'sequence': 3},
      ]);
      c.closeThread();
      await peerReplies(server, c);
      c.openThread('message-1');
      await pumpEventQueue();
      expect(server.threadMarkPosts.last, {
        'conversationId': 'lead',
        'root': 'message-1',
        'sequence': 5,
      });
      expect(server.threadMarkPosts, hasLength(2));
      // Read back on the next poll as every device gets it.
      await c.refresh();
      expect(c.snapshot!.threadMarks['lead'], {'message-1': 5});
    });

    test('a lower server mark never makes a thread read here unread', () async {
      final server = threaded();
      server.markReadElsewhere('lead', 1);
      final c = await read(server);
      c.select('lead');
      server.failThreadMarks = true;
      c.openThread('message-1');
      await pumpEventQueue();
      c.closeThread();
      server.failThreadMarks = false;
      // Another device marked it read only through its first reply.
      server.markThreadReadElsewhere('lead', 'message-1', 2);
      await c.refresh();
      expect(c.threadReadMark('message-1'), 3);
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isFalse);
    });

    test('on a server without thread marks, a thread opened here still reads '
        'as read here, and the next one opened is tried again', () async {
      final server = threaded()..oldServer = true;
      server.markReadElsewhere('lead', 1);
      final c = await read(server);
      c.select('lead');
      c.openThread('message-1');
      await pumpEventQueue();
      expect(server.threadMarkPosts, hasLength(1));
      expect(c.threadUnread(c.thread('lead', 'message-1')!), isFalse);
      c.closeThread();
      await peerReplies(server, c);
      c.openThread('message-1');
      await pumpEventQueue();
      expect(server.threadMarkPosts, hasLength(2));
      expect(c.snapshot!.threadMarks, isEmpty);
    });

    test('once access is lost, an open thread sends no mark', () async {
      final server = threaded();
      server.markReadElsewhere('lead', 1);
      final c = await read(server);
      c.select('lead');
      c.accessRevoked = true;
      c.openThread('message-1');
      await peerReplies(server, c);
      await pumpEventQueue();
      expect(server.threadMarkPosts, isEmpty);
    });
  });

  testWidgets('the read mark passes thread replies after the last row shown', (
    tester,
  ) async {
    final server = threaded();
    server.append('A reply at the end.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = peer;
    final c = await show(tester, server);
    expect(row('message-5'), findsNothing);
    expect(c.unread(c.snapshot!.conversation('lead')!), isFalse);
  });

  test('a reply only in its thread leaves the chat neither bold nor counted; '
      'an also-sent reply makes it bold and counts once', () async {
    final server = ConversationServer()..threads = true;
    final offline = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'offline');
    void reply(String text, {bool alsoSend = false}) {
      server.append(text, conversationId: 'offline');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
      if (alsoSend) {
        server.messages.last['alsoInChat'] = true;
        offline['lastMainSequence'] = server.revision;
      }
    }

    server.append('Root', conversationId: 'offline');
    offline['lastMainSequence'] = 1;
    reply('Only in the thread.');
    final c = server.controller(
      initial: {
        'tabId': 'tab',
        'accountId': 'owner',
        'readAt': {'offline': 1},
      },
    );
    addTearDown(c.dispose);
    await c.refresh();
    await c.loadMessages('offline');
    SuperTabConversation group() => c.snapshot!.conversation('offline')!;
    expect(c.unread(group()), isFalse);
    expect(c.unreadCount(group()), 0);

    reply('For everyone.', alsoSend: true);
    await c.refresh();
    await c.loadMessages('offline');
    expect(c.unread(group()), isTrue);
    expect(c.unreadCount(group()), 1);
  });

  test('a summary reads as the backend sends it', () {
    final thread = SuperTabThread.fromJson({
      'id': 'm1',
      'replies': 3,
      'lastSequence': 9,
      'lastAt': '2026-10-29T05:00:00Z',
      'authors': [peer],
      'people': ['owner', 'peer'],
    });
    expect(thread.replies, 3);
    expect(thread.lastAt, DateTime.utc(2026, 10, 29, 5));
    expect(thread.authors.single['id'], 'peer');
    expect(thread.people, ['owner', 'peer']);
  });

  testWidgets('the reply line names the reply count and when the last came', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabThreadLine(
            thread: SuperTabThread.fromJson({
              'id': 'm1',
              'replies': 1,
              'lastSequence': 2,
              'lastAt': DateTime.now()
                  .toUtc()
                  .subtract(const Duration(minutes: 2))
                  .toIso8601String(),
              'authors': [peer],
              'people': ['peer'],
            }),
            unread: false,
            onOpen: () {},
          ),
        ),
      ),
    );
    expect(find.text('1 reply'), findsOneWidget);
    expect(find.text('Last reply 2 min ago'), findsOneWidget);
  });
}
