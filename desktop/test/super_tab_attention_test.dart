import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/threads_view.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';

/// A message from the Lead agent, never the reader's own.
void fromLead(
  ConversationServer server,
  String text, {
  String conversationId = 'lead',
}) {
  server.append(text, conversationId: conversationId);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

Map<String, dynamic> conversation(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

/// One project, "web-project", whose chat is `lead` and whose workgroup is
/// `offline`.
ConversationServer projectServer() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  conversation(server, 'offline')
    ..['projectId'] = 'lead'
    ..['number'] = 12;
  return server;
}

Map<String, dynamic> preview(String id, int sequence, String text) => {
  'id': id,
  'sequence': sequence,
  'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'text': text,
  'createdAt': '2026-10-31T01:00:00Z',
  'attachments': 0,
};

Map<String, dynamic> unreadThread(
  String root,
  int lastReply, {
  String conversationId = 'lead',
  int unread = 1,
  String text = 'Root text',
}) => {
  'conversationId': conversationId,
  'rootId': root,
  'root': preview(root, 1, text),
  'lastReplyAt': '2026-10-31T02:00:00Z',
  'lastReplySequence': lastReply,
  'lastReplier': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'unreadReplies': unread,
  'follow': null,
};

Map<String, dynamic> readThread(
  String root,
  int lastReply, {
  String conversationId = 'lead',
  String text = 'Older root',
  bool? follow,
}) => {
  'conversationId': conversationId,
  'rootId': root,
  'root': preview(root, 1, text),
  'replies': 3,
  'lastReplyAt': '2026-10-30T02:00:00Z',
  'lastReplySequence': lastReply,
  'lastReplier': null,
  'follow': follow,
};

/// A controller for a widget test, closed by [close] inside the test so no
/// save is left pending.
Future<SuperTabController> openHere(ConversationServer server) async {
  final c = server.controller();
  await c.refresh();
  return c;
}

Future<void> close(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Future<SuperTabController> open(ConversationServer server) async {
  final c = server.controller();
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  await c.refresh();
  return c;
}

/// Lets the tag, decision and thread reads the last state read set off
/// answer.
Future<void> settle(SuperTabController c) async {
  for (var i = 0; i < 5; i++) {
    await pumpEventQueue();
  }
}

Future<void> pumpSidebar(
  WidgetTester tester,
  SuperTabController c,
  SuperTabAttention attention, {
  Brightness brightness = Brightness.dark,
  bool threadsSelected = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(300, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) => ProjectSidebar(
            controller: c,
            onAddAgent: (_) {},
            needsHuman: (_) => 0,
            onSelect: c.select,
            attention: attention,
            onThreads: () {},
            threadsSelected: threadsSelected,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder inRow(String key, Finder finder) =>
    find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

Text rowText(WidgetTester tester, String key, String text) =>
    tester.widget<Text>(inRow(key, find.text(text)));

void main() {
  group('the red number counts only what is for the reader', () {
    testWidgets('a tag in the chat counts on its row; a tag in a thread on '
        'Threads; a decision on its row; plain unread is bold with no '
        'number', (tester) async {
      final server = projectServer();
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      fromLead(server, 'Plain news', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline', threadId: 'message-1');
      server.ask(['Ship it?'], conversationId: 'offline');
      fromLead(server, 'Plain news in the project chat');
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.decisions.load();
      c.toggleProject('lead');
      await pumpSidebar(tester, c, attention);
      // The workgroup: one tag in its chat and one decision, not the tag in
      // its thread.
      expect(
        inRow('super-group-offline', find.byType(SuperTabCountBadge)),
        findsOneWidget,
      );
      expect(inRow('super-group-offline', find.text('2')), findsOneWidget);
      // Threads carries the tag inside a thread.
      expect(inRow('super-threads', find.text('1')), findsOneWidget);
      // The project chat: unread, nothing for the reader, so no number.
      expect(
        inRow('super-group-lead', find.byType(SuperTabCountBadge)),
        findsNothing,
      );
      expect(
        rowText(tester, 'super-group-lead', 'web-project').style?.fontWeight,
        grid.AppFont.semibold,
      );
      await close(tester, c);
    });

    testWidgets('a collapsed project counts the tags of the workgroups it '
        'hides', (tester) async {
      final server = projectServer();
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      fromLead(server, 'News', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline');
      server.tag('message-1');
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await pumpSidebar(tester, c, attention);
      expect(inRow('super-group-lead', find.text('2')), findsOneWidget);
      c.toggleProject('lead');
      await tester.pumpAndSettle();
      expect(inRow('super-group-lead', find.text('1')), findsOneWidget);
      expect(inRow('super-group-offline', find.text('1')), findsOneWidget);
      await close(tester, c);
    });
  });

  group('read rows are muted, unread rows full strength and bold', () {
    for (final brightness in Brightness.values) {
      testWidgets('in $brightness', (tester) async {
        final server = projectServer();
        server.followedThreads = {
          'unread': [unreadThread('message-1', 2)],
          'read': [],
          'more': false,
        };
        // A second workgroup, open on screen, so the project's row is
        // neither selected nor unread.
        (server.state['conversations'] as List).add({
          ...conversationFixture('open', 'Open now'),
          'projectId': 'lead',
          'number': 13,
        });
        fromLead(server, 'Read news');
        server.markReadElsewhere('lead', server.revision);
        fromLead(server, 'Unread news', conversationId: 'offline');
        final c = await openHere(server);
        final attention = SuperTabAttention.of(c);
        await attention.load();
        c.select('open');
        if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
        await pumpSidebar(tester, c, attention, brightness: brightness);
        final read = rowText(tester, 'super-group-lead', 'web-project');
        expect(read.style?.color, DesktopChrome.muted);
        expect(read.style?.fontWeight, isNot(grid.AppFont.semibold));
        final unread = tester.widget<Text>(
          find
              .descendant(
                of: find.byKey(const ValueKey('super-group-offline')),
                matching: find.byType(Text),
              )
              .first,
        );
        expect(unread.style?.color, DesktopChrome.foreground);
        expect(unread.style?.fontWeight, grid.AppFont.semibold);
        // Threads: a followed thread has new replies.
        final threads = rowText(tester, 'super-threads', 'Threads');
        expect(threads.style?.color, DesktopChrome.foreground);
        expect(threads.style?.fontWeight, grid.AppFont.semibold);
        await close(tester, c);
      });
    }

    testWidgets('Threads is muted with nothing new', (tester) async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-1', 2)],
        'more': false,
      };
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      await pumpSidebar(tester, c, attention);
      final threads = rowText(tester, 'super-threads', 'Threads');
      expect(threads.style?.color, DesktopChrome.muted);
      expect(threads.style?.fontWeight, isNot(grid.AppFont.semibold));
      await close(tester, c);
    });
  });

  testWidgets('a project row lights whole on hover, chevron included, as wide '
      'as its selected highlight', (tester) async {
    final server = projectServer();
    server.followedThreads = {'unread': [], 'read': [], 'more': false};
    final c = await openHere(server);
    final attention = SuperTabAttention.of(c);
    c.select('offline');
    await pumpSidebar(tester, c, attention);
    final toggle = find.byKey(const ValueKey('super-project-toggle-lead'));
    final groundFinder = find
        .ancestor(of: toggle, matching: find.byType(Material))
        .first;
    Material ground() => tester.widget<Material>(groundFinder);
    expect(ground().color, Colors.transparent);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(toggle));
    await tester.pumpAndSettle();
    // The whole row's ground, the one that holds the chevron too.
    expect(ground().color, grid.AppSurface.hoverFill);
    await mouse.moveTo(
      tester.getCenter(inRow('super-group-lead', find.text('web-project'))),
    );
    await tester.pumpAndSettle();
    expect(ground().color, grid.AppSurface.hoverFill);
    final hovered = tester.getRect(groundFinder);
    expect(hovered.right, greaterThanOrEqualTo(tester.getRect(toggle).right));
    c.select('lead');
    await tester.pumpAndSettle();
    expect(ground().color, grid.AppSurface.selectedFill);
    expect(tester.getRect(groundFinder), hovered);
    await close(tester, c);
  });

  group('the Threads list', () {
    test('lists threads with new replies first, then the rest; showing one '
        'reads its new replies and marks it read on every device', () async {
      final server = projectServer();
      fromLead(server, 'Root');
      fromLead(server, 'Old reply');
      server.messages.last['thread'] = 'message-1';
      fromLead(server, 'New reply');
      server.messages.last['thread'] = 'message-1';
      server.followedThreads = {
        'unread': [unreadThread('message-1', 3)],
        'read': [readThread('message-9', 7, follow: true)],
        'more': false,
      };
      conversation(server, 'lead')['lastMainSequence'] = 1;
      server.markThreadReadElsewhere('lead', 'message-1', 2);
      final c = await open(server);
      final attention = SuperTabAttention.of(c)..opened();
      await attention.load();
      expect(attention.shown.map((t) => t.rootId), ['message-1', 'message-9']);
      expect(attention.isNew(attention.shown.first), isTrue);
      expect(attention.isNew(attention.shown.last), isFalse);
      await attention.showReplies(attention.shown.first);
      expect(attention.newReplies['lead/message-1']!.map((m) => m.text), [
        'New reply',
      ]);
      expect(server.threadMarkPosts.last, {
        'conversationId': 'lead',
        'root': 'message-1',
        'sequence': 3,
      });
      // Read now, it stays new until the view is left.
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-1', 3), readThread('message-9', 7)],
        'more': false,
      };
      await attention.load();
      expect(attention.isNew(attention.shown.first), isTrue);
      attention.closed();
      expect(attention.shown.every((t) => !attention.isNew(t)), isTrue);
    });

    test('Unfollow is kept on the server and the list read again', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-9', 7)],
        'more': false,
      };
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      final reads = server.threadListReads.length;
      expect(await attention.setFollow(attention.read.single, false), isTrue);
      await pumpEventQueue();
      expect(server.followPosts.single, {
        'conversationId': 'lead',
        'root': 'message-9',
        'follow': false,
      });
      expect(server.threadListReads.length, greaterThan(reads));
    });

    test('a server before followed threads lists the inbox\'s unread ones '
        'and offers no Follow', () async {
      final server = projectServer()
        ..inbox = {
          'threads': [unreadThread('message-1', 3)],
          'latest': [],
          'more': false,
        };
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      expect(attention.unread.single.rootId, 'message-1');
      expect(attention.followSupported, isFalse);
      expect(
        await attention.setFollow(attention.unread.single, false),
        isFalse,
      );
      expect(server.followPosts, isEmpty);
      // It does not ask the missing route again.
      await attention.load();
      expect(
        server.threadListReads.where((p) => p.endsWith('/threads')),
        hasLength(1),
      );
    });

    test('a thread in a chat the reader no longer has is not listed', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 3, conversationId: 'elsewhere')],
        'read': [readThread('message-2', 3, conversationId: 'gone')],
        'more': false,
      };
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      expect(attention.loaded, isTrue);
      expect(attention.shown, isEmpty);
    });

    test(
      'access lost clears the list, and an answer on its way is dropped',
      () async {
        final server = projectServer();
        server.followedThreads = {
          'unread': [unreadThread('message-1', 3)],
          'read': [],
          'more': false,
        };
        var revoked = false;
        final c = SuperTabController(
          tabId: 'tab',
          accountId: 'owner',
          request: (method, path, {body}) {
            if (revoked &&
                (path.contains('/parts') || path.contains('/changes'))) {
              throw const SuperTabFailure(
                'FORBIDDEN',
                'No access.',
                statusCode: 403,
              );
            }
            return server.request(method, path, body: body);
          },
          save: server.save,
          pollInterval: Duration.zero,
        );
        addTearDown(() async {
          await c.flush();
          c.dispose();
        });
        await c.refresh();
        final attention = SuperTabAttention.of(c);
        await attention.load();
        expect(attention.unread, hasLength(1));
        server.holdThreadLists = Completer<void>();
        final late = attention.load();
        await pumpEventQueue();
        // The Swarm refuses the reader: their access is gone.
        revoked = true;
        fromLead(server, 'After access went');
        await c.refresh();
        expect(c.accessRevoked, isTrue);
        expect(attention.unread, isEmpty);
        expect(attention.loaded, isFalse);
        server.holdThreadLists!.complete();
        await late;
        expect(attention.unread, isEmpty);
        expect(attention.threadsUnread, isFalse);
      },
    );

    test('an answer from before the audience changed is dropped, and the '
        'list is read again', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 3)],
        'read': [],
        'more': false,
      };
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      final first = server.holdThreadLists = Completer<void>();
      final stale = attention.load();
      await pumpEventQueue();
      // Who may read what changes: the next state read reloads under a new
      // epoch, which clears the list and asks for it again.
      server.parts.epoch++;
      await c.refresh();
      await settle(c);
      expect(attention.unread, isEmpty);
      // The read asked before the change answers with the old list, while
      // the one asked after it is still out.
      final second = server.holdThreadLists = Completer<void>();
      first.complete();
      await settle(c);
      expect(attention.unread, isEmpty);
      expect(attention.loaded, isFalse);
      second.complete();
      await stale;
      await settle(c);
      expect(attention.loaded, isTrue);
      expect(attention.unread, hasLength(1));
    });

    test(
      'a failed first read shows the failure, and a later read recovers',
      () async {
        final server = projectServer()..failThreadLists = true;
        server.followedThreads = {
          'unread': [unreadThread('message-1', 3)],
          'read': [],
          'more': false,
        };
        final c = await open(server);
        final attention = SuperTabAttention.of(c);
        await attention.load();
        expect(attention.loaded, isFalse);
        expect(attention.error, isNotNull);
        server.failThreadLists = false;
        await attention.load();
        expect(attention.error, isNull);
        expect(attention.loaded, isTrue);
        expect(attention.threadsUnread, isTrue);
      },
    );

    test('asked too often, it waits before reading again, even with the '
        'Threads view open', () async {
      var now = DateTime(2026, 10, 31, 9);
      final server = projectServer()
        ..failThreadLists = true
        ..threadListStatus = 429;
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      final c = await open(server);
      final attention = SuperTabAttention.forTest(c, now: () => now);
      addTearDown(attention.dispose);
      // The view open reads every few seconds as the Swarm moves.
      attention.opened();
      await settle(c);
      expect(attention.error, isNotNull);
      final reads = server.threadListReads.length;
      server.failThreadLists = false;
      // Past the open view's pace, short of the wait the refusal asked for.
      now = now.add(const Duration(seconds: 4));
      fromLead(server, 'More');
      await c.refresh();
      await settle(c);
      expect(server.threadListReads.length, reads);
      now = now.add(const Duration(seconds: 2));
      fromLead(server, 'More again');
      await c.refresh();
      await settle(c);
      expect(server.threadListReads.length, reads + 1);
      expect(attention.error, isNull);
    });
  });

  test('reading a chat leaves a reply that lives only in its thread unread: '
      'the chat\'s mark stops at its newest main-stream message', () async {
    final server = projectServer();
    fromLead(server, 'Root');
    conversation(server, 'lead')['lastMainSequence'] = 1;
    fromLead(server, 'Reply only in the thread');
    server.messages.last['thread'] = 'message-1';
    final c = await open(server);
    await c.loadMessages('lead');
    c.markRead('lead');
    await pumpEventQueue();
    expect(server.readMarkPosts.last, {
      'conversationId': 'lead',
      'sequence': 1,
    });
  });

  testWidgets('the Threads view shows new replies under their root with a '
      'reply box, the rest after, and Unfollow', (tester) async {
    final server = projectServer();
    fromLead(server, 'Root');
    fromLead(server, 'Fresh reply');
    server.messages.last['thread'] = 'message-1';
    conversation(server, 'lead')['lastMainSequence'] = 1;
    server.followedThreads = {
      'unread': [unreadThread('message-1', 2, text: 'Root')],
      'read': [readThread('message-7', 5, text: 'Settled question')],
      'more': false,
    };
    final c = await openHere(server);
    final attention = SuperTabAttention.of(c);
    await attention.load();
    String? opened;
    await tester.binding.setSurfaceSize(const Size(700, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabThreadsView(
            attention: attention,
            onOpen: (id, root) => opened = '$id/$root',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('New replies'), findsOneWidget);
    expect(find.text('Earlier'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Root')).dy,
      lessThan(tester.getTopLeft(find.text('Settled question')).dy),
    );
    expect(find.text('Fresh reply'), findsOneWidget);
    expect(find.text('1 new reply'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-thread-reply-lead/message-1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('super-thread-reply-lead/message-7')),
      findsNothing,
    );
    expect(server.threadMarkPosts.last['root'], 'message-1');
    await tester.tap(find.text('Root'));
    expect(opened, 'lead/message-1');
    // The reply box is the thread pane's own: attach and the arrow send.
    final box = find.byKey(
      const ValueKey('super-thread-reply-surface-lead/message-1'),
    );
    expect(
      find.descendant(of: box, matching: find.byTooltip('Send reply')),
      findsOneWidget,
    );
    expect(find.text('Send'), findsNothing);
    await tester.enterText(
      find.byKey(const ValueKey('super-thread-reply-lead/message-1')),
      'On it',
    );
    await tester.pump();
    await tester.tap(
      find.byKey(const ValueKey('super-thread-send-lead/message-1')),
    );
    await tester.pumpAndSettle();
    final sent = server.posts.last['command'] as Map;
    expect(sent['type'], 'message.send');
    expect(sent['conversationId'], 'lead');
    expect(sent['replyTo'], 'message-1');
    expect(sent['text'], 'On it');
    Opacity more(String key) => tester.widget<Opacity>(
      find
          .ancestor(
            of: find.byKey(ValueKey('super-thread-more-$key')),
            matching: find.byType(Opacity),
          )
          .first,
    );
    // Unfollow is quiet: its ⋯ shows only while the card is pointed at, or
    // focused (the reply box focused shows its card's).
    expect(more('lead/message-1').opacity, 1);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    expect(find.text('Unfollow'), findsNothing);
    expect(more('lead/message-7').opacity, 0);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.text('Settled question')));
    await tester.pumpAndSettle();
    expect(more('lead/message-7').opacity, 1);
    expect(more('lead/message-1').opacity, 0);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('super-thread-more-lead/message-7')),
        matching: find.byTooltip('More'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Unfollow thread'));
    await tester.pumpAndSettle();
    expect(server.followPosts.single['follow'], isFalse);
    await close(tester, c);
  });
}
