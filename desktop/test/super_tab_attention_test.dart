import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
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
            needsHuman: (_) => 0,
            onSelect: c.select,
            attention: attention,
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
    // Dee: the 7, 7 and 3 on project rows never cleared, and opening them showed none of what they counted.
    group('a project row counts only what opening it shows', () {
      Future<(SuperTabController, SuperTabAttention)> opened(
        ConversationServer server,
      ) async {
        final c = await openHere(server);
        final attention = SuperTabAttention.of(c);
        await attention.mentions.load();
        await attention.decisions.load();
        await attention.load();
        return (c, attention);
      }

      testWidgets('a tag in a task conversation shows no number on the '
          'collapsed row, which is still bold and kept by the unread filter', (
        tester,
      ) async {
        final server = projectServer();
        fromLead(server, 'Please look', conversationId: 'offline');
        server.tag('message-1', conversationId: 'offline');
        final (c, attention) = await opened(server);
        await pumpSidebar(tester, c, attention);
        expect(attention.mentionsIn('offline'), 1);
        expect(
          inRow('super-group-lead', find.byType(SuperTabCountBadge)),
          findsNothing,
        );
        expect(
          rowText(tester, 'super-group-lead', 'web-project').style?.fontWeight,
          FontWeight.w600,
        );
        c.toggleUnreadOnly();
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('super-group-lead')), findsOneWidget);
        // Still listed where it can be opened, and on its own row once expanded.
        expect(attention.mentions.waiting, hasLength(1));
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(inRow('super-group-offline', find.text('1')), findsOneWidget);
        await close(tester, c);
      });

      testWidgets('a tag in the project chat counts collapsed or open, and '
          'reading it clears it', (tester) async {
        final server = projectServer();
        server.tag('message-1', messageSequence: 1);
        fromLead(server, 'Please look');
        final (c, attention) = await opened(server);
        await pumpSidebar(tester, c, attention);
        expect(inRow('super-group-lead', find.text('1')), findsOneWidget);
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(inRow('super-group-lead', find.text('1')), findsOneWidget);
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        c.select('lead');
        await tester.pumpAndSettle();
        c.markRead('lead');
        await tester.pumpAndSettle();
        expect(
          inRow('super-group-lead', find.byType(SuperTabCountBadge)),
          findsNothing,
        );
        await close(tester, c);
      });

      testWidgets('a tag in a reply that lives only in a thread counts on '
          'Threads, not on the project row', (tester) async {
        final server = projectServer();
        server.followedThreads = {
          'unread': [unreadThread('message-1', 2, conversationId: 'lead')],
          'read': [],
          'more': false,
        };
        server.tag('message-1', threadId: 'message-1');
        final (c, attention) = await opened(server);
        await pumpSidebar(tester, c, attention);
        expect(inRow('super-threads', find.text('1')), findsOneWidget);
        expect(
          inRow('super-group-lead', find.byType(SuperTabCountBadge)),
          findsNothing,
        );
        await close(tester, c);
      });

      testWidgets('every number shown clears by reading what it counts', (
        tester,
      ) async {
        final server = projectServer();
        fromLead(server, 'In the task', conversationId: 'offline');
        server.tag('message-1', conversationId: 'offline');
        server.tag('message-1', messageSequence: 1);
        fromLead(server, 'In the chat');
        final (c, attention) = await opened(server);
        await pumpSidebar(tester, c, attention);
        expect(inRow('super-group-lead', find.text('1')), findsOneWidget);
        c.select('lead');
        await tester.pumpAndSettle();
        c.markRead('lead');
        await tester.pumpAndSettle();
        expect(find.byType(SuperTabCountBadge), findsNothing);
        await close(tester, c);
      });

      testWidgets('a muted project chat shows no number', (tester) async {
        final server = projectServer();
        server.tag('message-1', messageSequence: 1);
        fromLead(server, 'Please look');
        final (c, attention) = await opened(server);
        await c.setNotify('lead', SuperTabNotify.muted);
        await pumpSidebar(tester, c, attention);
        expect(
          inRow('super-group-lead', find.byType(SuperTabCountBadge)),
          findsNothing,
        );
        await close(tester, c);
      });
    });

    testWidgets('a tag in the chat counts on its row; a tag in a thread on '
        'Threads; a decision on its row; plain unread is bold with no '
        'number', (tester) async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2, conversationId: 'offline')],
        'read': [],
        'more': false,
      };
      fromLead(server, 'Plain news', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline', threadId: 'message-1');
      server.ask(['Ship it?'], conversationId: 'offline');
      fromLead(server, 'Plain news in the project chat');
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.decisions.load();
      await attention.load();
      c.toggleProject('lead');
      await pumpSidebar(tester, c, attention);
      // The workgroup: one tag in its chat and one decision, not the tag in
      // its thread.
      expect(
        inRow('super-group-offline', find.byType(SuperTabCountBadge)),
        findsOneWidget,
      );
      expect(inRow('super-group-offline', find.text('2')), findsOneWidget);
      // The tag inside a thread is counted apart from the row.
      expect(attention.threadMentions, 1);
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

    testWidgets('a collapsed project counts its own chat\'s tags, not those of '
        'the workgroups it hides', (tester) async {
      final server = projectServer();
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      fromLead(server, 'News', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline');
      server.tag('message-1');
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await pumpSidebar(tester, c, attention);
      expect(inRow('super-group-lead', find.text('1')), findsOneWidget);
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
        await close(tester, c);
      });
    }
  });

  testWidgets('a project row lights whole on hover, as wide as its selected '
      'highlight', (tester) async {
    final server = projectServer();
    server.followedThreads = {'unread': [], 'read': [], 'more': false};
    final c = await openHere(server);
    final attention = SuperTabAttention.of(c);
    c.select('offline');
    await pumpSidebar(tester, c, attention);
    final row = find.byKey(const ValueKey('super-group-lead'));
    final groundFinder = find
        .ancestor(of: row, matching: find.byType(Material))
        .first;
    Material ground() => tester.widget<Material>(groundFinder);
    expect(ground().color, Colors.transparent);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getRect(row).centerRight - const Offset(4, 0));
    await tester.pumpAndSettle();
    // The whole row's ground, out to its end.
    expect(ground().color, grid.AppSurface.hoverFill);
    await mouse.moveTo(
      tester.getCenter(inRow('super-group-lead', find.text('web-project'))),
    );
    await tester.pumpAndSettle();
    expect(ground().color, grid.AppSurface.hoverFill);
    final hovered = tester.getRect(groundFinder);
    expect(hovered.right, greaterThanOrEqualTo(tester.getRect(row).right));
    c.select('lead');
    await tester.pumpAndSettle();
    expect(ground().color, grid.AppSurface.selectedFill);
    expect(tester.getRect(groundFinder), hovered);
    await close(tester, c);
  });

  group('review of 99b8018', () {
    test('a thread read during the visit keeps its new-reply count after '
        'the list is read again', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 3, unread: 2)],
        'read': [],
        'more': false,
      };
      final c = await open(server);
      final attention = SuperTabAttention.of(c)..opened();
      await attention.load();
      final thread = attention.shown.single;
      expect(attention.newCount(thread), 2);
      // Read now: the server lists it among the read ones, with no count.
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-1', 3)],
        'more': false,
      };
      await attention.load();
      final reloaded = attention.shown.single;
      expect(attention.isNew(reloaded), isTrue);
      expect(attention.newCount(reloaded), 2);
      attention.closed();
      expect(attention.newCount(reloaded), 0);
    });

    test('a change inside the gap is read once the gap is over, and the '
        'wait stops with the controller', () {
      fakeAsync((async) {
        var now = DateTime(2026, 10, 31, 9);
        final server = projectServer();
        server.followedThreads = {'unread': [], 'read': [], 'more': false};
        final c = server.controller();
        unawaited(c.refresh());
        async.flushMicrotasks();
        final attention = SuperTabAttention.forTest(c, now: () => now);
        // On screen, as the sidebar shows it.
        void shown() {}
        attention.addListener(shown);
        async.flushMicrotasks();
        final reads = server.threadListReads.length;
        expect(reads, greaterThan(0));
        // A change 5 s after the read: inside the 15 s gap.
        now = now.add(const Duration(seconds: 5));
        async.elapse(const Duration(seconds: 5));
        fromLead(server, 'News');
        unawaited(c.refresh());
        async.flushMicrotasks();
        expect(server.threadListReads.length, reads);
        // The gap ends: the change is read without another one.
        now = now.add(const Duration(seconds: 11));
        async.elapse(const Duration(seconds: 11));
        expect(server.threadListReads.length, reads + 1);
        // Another change in the next gap, then the controller goes.
        now = now.add(const Duration(seconds: 1));
        fromLead(server, 'More');
        unawaited(c.refresh());
        async.flushMicrotasks();
        expect(async.pendingTimers, isNotEmpty);
        // Nothing shows it any more: nothing is waited for.
        attention.removeListener(shown);
        expect(async.pendingTimers, isEmpty);
        attention.addListener(shown);
        fromLead(server, 'Again');
        unawaited(c.refresh());
        async.flushMicrotasks();
        expect(async.pendingTimers, isNotEmpty);
        unawaited(c.flush());
        async.flushMicrotasks();
        c.dispose();
        expect(async.pendingTimers, isEmpty);
        async.elapse(const Duration(seconds: 30));
        expect(server.threadListReads.length, reads + 1);
        expect(attention.unread, isEmpty);
      });
    });

    test('no red number once access is gone, nor for a tag in a chat the '
        'Swarm no longer lists', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2)],
        'read': [],
        'more': false,
      };
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      server.tag(
        'message-9',
        conversationId: 'gone',
        threadId: 'message-9',
        messageSequence: 2,
      );
      server.tag('message-1', conversationId: 'offline', messageSequence: 2);
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
      await attention.mentions.load();
      await attention.load();
      // The tag in a chat the Swarm does not list counts nowhere.
      expect(attention.threadMentions, 1);
      expect(attention.mentionsIn('offline'), 1);
      // The moment access is gone, before anything is cleared.
      c.accessRevoked = true;
      expect(attention.threadMentions, 0);
      expect(attention.mentionsIn('offline'), 0);
      c.accessRevoked = false;
      revoked = true;
      fromLead(server, 'After access went');
      await c.refresh();
      expect(c.accessRevoked, isTrue);
      expect(attention.threadMentions, 0);
      expect(attention.mentionsIn('offline'), 0);
    });

    test('a tag stops counting once the reader has read past it, answered '
        'or not; a decision once its chat is read', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-1', 2, follow: true)],
        'more': false,
      };
      fromLead(server, 'Please look', conversationId: 'offline');
      server.tag(
        'message-1',
        conversationId: 'offline',
        messageSequence: server.revision,
      );
      server.ask(['Ship it?'], conversationId: 'offline');
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.decisions.load();
      await attention.load();
      expect(attention.mentionsIn('offline'), 2);
      // Read on another device, past the tagged message.
      server.markReadElsewhere('offline', server.revision);
      await c.refresh();
      expect(attention.mentions.waiting, hasLength(1));
      expect(attention.mentionsIn('offline'), 0);
      // A tag in a thread clears once the thread is read past it.
      server.tag(
        'message-1',
        threadId: 'message-1',
        messageSequence: server.revision,
      );
      await c.refresh();
      await attention.mentions.load();
      await attention.load();
      expect(attention.threadMentions, 1);
      server.markThreadReadElsewhere('lead', 'message-1', server.revision);
      await c.refresh();
      expect(attention.threadMentions, 0);
    });
  });

  group('the Threads number counts only threads the Threads view lists', () {
    // Scholes 11-02: the sidebar said Threads 1 while the page said "No
    // threads yet" and "Older threads are not listed."
    test('a tag in a thread the list leaves out (past the server\'s bounds) '
        'counts nothing, and the sidebar row shows no number', () async {
      final server = projectServer();
      server.followedThreads = {'unread': [], 'read': [], 'more': true};
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.load();
      expect(attention.loaded, isTrue);
      expect(attention.shown, isEmpty);
      expect(attention.more, isTrue);
      // The tag is waiting, but the thread is not listed: no number.
      expect(attention.mentions.waiting, hasLength(1));
      expect(attention.threadMentions, 0);
    });

    test('a tag in a thread the reader unfollowed (never listed) counts '
        'nothing; in a thread the list shows it counts', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [],
        'read': [readThread('message-1', 2, follow: true)],
        'more': false,
      };
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      server.tag('message-7', threadId: 'message-7', messageSequence: 3);
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.load();
      expect(attention.mentions.waiting, hasLength(2));
      expect(attention.threadMentions, 1);
    });

    test('a thread with the same root id in another chat is not the listed '
        'one', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2)],
        'read': [],
        'more': false,
      };
      server.tag(
        'message-1',
        conversationId: 'offline',
        threadId: 'message-1',
        messageSequence: 2,
      );
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.load();
      expect(attention.threadMentions, 0);
    });

    test('no number before the list has answered; a failed first read that '
        'recovers then counts', () async {
      final server = projectServer()..failThreadLists = true;
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2)],
        'read': [],
        'more': false,
      };
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      expect(attention.threadMentions, 0);
      await attention.load();
      expect(attention.error, isNotNull);
      expect(attention.threadMentions, 0);
      server.failThreadLists = false;
      await attention.load();
      expect(attention.error, isNull);
      expect(attention.threadMentions, 1);
    });

    test('when who may read what changes, the number is gone until the list '
        'is read again; access lost clears it at once', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2)],
        'read': [],
        'more': false,
      };
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.load();
      expect(attention.threadMentions, 1);
      // The next read answers with the thread gone from the list.
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      await attention.load();
      expect(attention.threadMentions, 0);
      c.accessRevoked = true;
      expect(attention.threadMentions, 0);
    });
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

  // Scholes, 2026-11-02: a reply sent from a card did not show until an agent
  // answered, so it looked unsent.
  group('a reply sent from the Threads view', () {
    const field = ValueKey('super-thread-reply-lead/message-1');
    const send = ValueKey('super-thread-send-lead/message-1');
    const own = ValueKey('super-thread-own-reply-lead/message-1');

    Future<(ConversationServer, SuperTabController, SuperTabAttention)> shown(
      WidgetTester tester,
    ) async {
      final server = projectServer();
      fromLead(server, 'Root');
      fromLead(server, 'Fresh reply');
      server.messages.last['thread'] = 'message-1';
      conversation(server, 'lead')['lastMainSequence'] = 1;
      server.followedThreads = {
        'unread': [unreadThread('message-1', 2, text: 'Root')],
        'read': const [],
        'more': false,
      };
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      await tester.binding.setSurfaceSize(const Size(700, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabThreadsView(attention: attention, onOpen: (_, _) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return (server, c, attention);
    }

    Finder inOwn(Finder what) =>
        find.descendant(of: find.byKey(own), matching: what);

    testWidgets('shows at once as sending, then sent, and stays', (
      tester,
    ) async {
      final (server, c, attention) = await shown(tester);
      final hold = server.holdCommands = Completer<void>();
      await tester.enterText(find.byKey(field), 'On it');
      await tester.pump();
      await tester.tap(find.byKey(send));
      await tester.pump();
      await tester.pump();
      // Before any answer, and before the server has answered at all.
      expect(inOwn(find.text('On it')), findsOneWidget);
      expect(inOwn(find.text('Sending…')), findsOneWidget);
      expect(inOwn(find.text('Sent')), findsNothing);
      expect(tester.widget<TextField>(find.byKey(field)).controller!.text, '');
      hold.complete();
      server.holdCommands = null;
      await tester.pumpAndSettle();
      expect(inOwn(find.text('On it')), findsOneWidget);
      expect(inOwn(find.text('Sent')), findsOneWidget);
      expect(inOwn(find.text('Sending…')), findsNothing);
      // An agent answers, and the transcript holds the reply: it stays, once.
      await c.loadMessages('lead');
      fromLead(server, 'Answer');
      server.messages.last['thread'] = 'message-1';
      await c.refresh();
      await attention.load();
      await tester.pumpAndSettle();
      expect(find.text('On it'), findsOneWidget);
      expect(inOwn(find.text('Sent')), findsOneWidget);
      await close(tester, c);
    });

    testWidgets('failed: its text stays, with Retry, and Retry sends it', (
      tester,
    ) async {
      final (server, c, _) = await shown(tester);
      server.refuse = {'code': 'SWARM_BUSY', 'message': 'Busy, try again.'};
      await tester.enterText(find.byKey(field), 'On it');
      await tester.pump();
      await tester.tap(find.byKey(send));
      await tester.pumpAndSettle();
      expect(inOwn(find.text('On it')), findsOneWidget);
      expect(inOwn(find.text('Not sent')), findsOneWidget);
      expect(inOwn(find.text('Sent')), findsNothing);
      // Why it failed is said once, on the reply, not again in the box.
      expect(find.text('Busy, try again.'), findsOneWidget);
      server.refuse = null;
      final posts = server.posts.length;
      await tester.tap(inOwn(find.text('Retry')));
      await tester.pumpAndSettle();
      expect(server.posts.length, posts + 1);
      expect((server.posts.last['command'] as Map)['text'], 'On it');
      expect(inOwn(find.text('Sent')), findsOneWidget);
      expect(inOwn(find.text('Not sent')), findsNothing);
      await close(tester, c);
    });

    testWidgets('failed: Delete takes it away, and it is never called sent', (
      tester,
    ) async {
      final (server, c, _) = await shown(tester);
      server.refuse = {'code': 'SWARM_BUSY', 'message': 'Busy, try again.'};
      await tester.enterText(find.byKey(field), 'On it');
      await tester.pump();
      await tester.tap(find.byKey(send));
      await tester.pumpAndSettle();
      await tester.tap(inOwn(find.text('Delete')));
      await tester.pumpAndSettle();
      expect(find.text('On it'), findsNothing);
      expect(find.text('Sent'), findsNothing);
      await close(tester, c);
    });

    // Review of #2555: a sent reply stays in the controller's list until its
    // chat's transcript loads, and must not come back as new on a later visit.
    testWidgets('a reply from an earlier visit does not come back as new', (
      tester,
    ) async {
      // A chat that is not open: its transcript never loads here.
      final server = projectServer();
      fromLead(server, 'Root', conversationId: 'offline');
      fromLead(server, 'Fresh reply', conversationId: 'offline');
      server.messages.last['thread'] = 'message-1';
      conversation(server, 'offline')['lastMainSequence'] = 1;
      Map<String, dynamic> listed(int lastReply) => {
        'unread': [
          unreadThread(
            'message-1',
            lastReply,
            conversationId: 'offline',
            text: 'Root',
          ),
        ],
        'read': const [],
        'more': false,
      };
      server.followedThreads = listed(2);
      final c = await openHere(server);
      final attention = SuperTabAttention.of(c);
      await attention.load();
      await tester.binding.setSurfaceSize(const Size(700, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabThreadsView(attention: attention, onOpen: (_, _) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      const reply = ValueKey('super-thread-reply-offline/message-1');
      const ownHere = ValueKey('super-thread-own-reply-offline/message-1');
      await tester.enterText(find.byKey(reply), 'On it');
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey('super-thread-send-offline/message-1')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(ownHere), findsOneWidget);
      // Still in the list: this chat's transcript has not loaded.
      expect(c.outgoing('offline').where((m) => m.text == 'On it'), isNotEmpty);
      attention.closed();
      server.followedThreads = listed(9);
      attention.opened();
      await attention.load();
      await tester.pumpAndSettle();
      expect(attention.isNew(attention.shown.single), isTrue);
      expect(find.byKey(ownHere), findsNothing);
      await close(tester, c);
    });

    test('a reply with only files says so', () {
      expect(const SuperTabOwnReply('', null).shownText, 'Files');
      expect(const SuperTabOwnReply('On it', null).shownText, 'On it');
    });

    testWidgets('failed: its whole text shows, not cut short', (tester) async {
      final (server, c, _) = await shown(tester);
      server.refuse = {'code': 'SWARM_BUSY', 'message': 'Busy, try again.'};
      final long = List.generate(9, (i) => 'line $i').join('\n');
      await tester.enterText(find.byKey(field), long);
      await tester.pump();
      await tester.tap(find.byKey(send));
      await tester.pumpAndSettle();
      final row = tester.renderObject<RenderParagraph>(inOwn(find.text(long)));
      expect(row.didExceedMaxLines, isFalse);
      await close(tester, c);
    });

    testWidgets('a reply the card already read back is not shown twice', (
      tester,
    ) async {
      final (server, c, attention) = await shown(tester);
      await tester.enterText(find.byKey(field), 'On it');
      await tester.pump();
      await tester.tap(find.byKey(send));
      await tester.pumpAndSettle();
      final thread = attention.shown.single;
      final operationId = server.posts.last['operationId'] as String;
      final id = superTabMessageId(
        tabId: c.tabId,
        accountId: c.accountId,
        operationId: operationId,
      );
      attention.newReplies[thread.key] = [
        ...attention.newReplies[thread.key]!,
        SuperTabMessage.fromJson({
          'id': id,
          'conversationId': 'lead',
          'sequence': 90,
          'author': {'kind': 'person', 'id': c.accountId, 'name': 'Me'},
          'text': 'On it',
          'thread': 'message-1',
          'replyTo': 'message-1',
          'createdAt': '2026-11-02T00:00:00Z',
        }),
      ];
      await attention.load();
      await tester.pumpAndSettle();
      expect(find.text('On it'), findsOneWidget);
      expect(find.byKey(own), findsNothing);
      await close(tester, c);
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

  testWidgets('a read workgroup with a tag of the reader is never behind '
      '"… N more"', (tester) async {
    final server = projectServer();
    server.followedThreads = {'unread': [], 'read': [], 'more': false};
    final groups = server.state['conversations'] as List;
    // Nine newer workgroups than "offline" (number 12), all read.
    for (var n = 20; n < 29; n++) {
      groups.add({
        ...conversationFixture('g$n', 'Work $n'),
        'projectId': 'lead',
        'number': n,
      });
    }
    fromLead(server, 'Please look', conversationId: 'offline');
    // From a server that does not say where the tag is: it counts until
    // answered, though the chat is read.
    server.tag('message-1', conversationId: 'offline');
    server.markReadElsewhere('offline', server.revision);
    final c = await openHere(server);
    final attention = SuperTabAttention.of(c);
    await attention.mentions.load();
    expect(c.unread(c.snapshot!.conversation('offline')!), isFalse);
    c.toggleProject('lead');
    await pumpSidebar(tester, c, attention);
    expect(
      find.byKey(const ValueKey('super-project-more-lead')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('super-group-offline')), findsOneWidget);
    expect(inRow('super-group-offline', find.text('1')), findsOneWidget);
    await close(tester, c);
  });

  testWidgets('a thread in the reader\'s Buddy chat offers Open thread to '
      'reply, not a box its ended session would refuse', (tester) async {
    final server = projectServer();
    (server.state['conversations'] as List).add({
      ...conversationFixture('buddy-owner-lead', "owner's Buddy"),
      'kind': 'buddy',
      'projectId': 'lead',
      'buddyOwnerId': 'owner',
    });
    server.followedThreads = {
      'unread': [
        unreadThread(
          'message-1',
          2,
          conversationId: 'buddy-owner-lead',
          text: 'Plan the week',
        ),
      ],
      'read': [],
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
    expect(
      find.byKey(
        const ValueKey('super-thread-reply-buddy-owner-lead/message-1'),
      ),
      findsNothing,
    );
    await tester.tap(find.text('Open thread to reply'));
    expect(opened, 'buddy-owner-lead/message-1');
    await close(tester, c);
  });

  group('tags from the Threads view (merge check of 67c32a3)', () {
    /// Kestrel is an agent of "offline", not of "lead"; "offline" has a
    /// thread at message-1 with a new reply.
    ConversationServer tagged() {
      final server = projectServer();
      server.state['agents'] = [
        {
          'id': 'kestrel',
          'name': 'Builder',
          'displayName': 'Kestrel',
          'machineId': 'host',
          'harnessId': 'session',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      conversation(server, 'offline')['agentIds'] = ['kestrel'];
      fromLead(server, 'Root', conversationId: 'offline');
      fromLead(server, 'Reply', conversationId: 'offline');
      server.messages.last['thread'] = 'message-1';
      conversation(server, 'offline')['lastMainSequence'] = 1;
      server.followedThreads = {
        'unread': [
          unreadThread('message-1', 2, conversationId: 'offline', text: 'Root'),
        ],
        'read': [],
        'more': false,
      };
      return server;
    }

    test('a reply tagging an agent of the thread\'s own chat goes, whichever '
        'chat is selected', () async {
      final server = tagged();
      final c = await open(server);
      c.select('lead');
      const to = (conversationId: 'offline', root: 'message-1');
      c.setThreadDraft('message-1', '@Kestrel please look');
      c.threadMention('kestrel', '@Kestrel', to: to);
      expect(c.threadMentions('offline', 'message-1'), {'kestrel': '@Kestrel'});
      await c.sendThreadReply(to: to);
      expect(c.operationError, isNull);
      final sent = server.posts.last['command'] as Map;
      expect(sent['conversationId'], 'offline');
      expect(sent['replyTo'], 'message-1');
      expect(sent['recipientIds'], ['kestrel']);
    });

    testWidgets('the Threads view\'s box offers @ as the thread pane does: '
        'whom the thread\'s chat offers, Backspace takes a tag whole, and the '
        'reply carries it', (tester) async {
      final server = tagged();
      final c = await openHere(server);
      c.select('lead');
      final attention = SuperTabAttention.of(c);
      await attention.load();
      await tester.binding.setSurfaceSize(const Size(700, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabThreadsView(
              attention: attention,
              onOpen: (_, _) {},
              machineName: (_) => 'Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final field = find.byKey(
        const ValueKey('super-thread-reply-offline/message-1'),
      );
      final picker = find.byKey(
        const ValueKey('super-thread-completions-offline/message-1'),
      );
      await tester.tap(field);
      await tester.enterText(field, '@Kes');
      await tester.pumpAndSettle();
      expect(picker, findsOneWidget);
      expect(
        find.descendant(of: picker, matching: find.textContaining('Kestrel')),
        findsWidgets,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(picker, findsNothing);
      expect(tester.widget<TextField>(field).controller!.text, '@Kestrel ');
      expect(c.threadMentions('offline', 'message-1'), {'kestrel': '@Kestrel'});
      // Backspace into the tag takes it whole.
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(field).controller!.text, '');
      // Picked again and sent: the reply carries the tag.
      await tester.enterText(field, '@Kes');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.enterText(field, '@Kestrel please look');
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-thread-send-offline/message-1')),
      );
      await tester.pumpAndSettle();
      final sent = server.posts.last['command'] as Map;
      expect(sent['conversationId'], 'offline');
      expect(sent['recipientIds'], ['kestrel']);
      await close(tester, c);
    });
  });
}
