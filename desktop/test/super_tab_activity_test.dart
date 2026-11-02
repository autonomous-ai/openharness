import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/workgroup_name.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_attention_test.dart'
    show close, fromLead, inRow, openHere, projectServer, unreadThread;
import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

Future<SuperTabController> open(ConversationServer server) async {
  final c = server.controller();
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  await c.refresh();
  return c;
}

Future<void> settle() async {
  for (var i = 0; i < 6; i++) {
    await pumpEventQueue();
  }
}

Future<void> pumpSidebar(
  WidgetTester tester,
  SuperTabController c, {
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(320, 900));
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
            attention: SuperTabAttention.of(c),
            activity: SuperTabActivity.of(c),
            onNotifications: () {},
            onThreads: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('the read model keeps the reader\'s chat settings', () {
    Map<String, dynamic> load(Map<String, dynamic> derived) => {
      'format': superTabReadFormat,
      'tabId': 'tab',
      'cursor': 'c1',
      'epoch': 1,
      'lastChangedAt': 1,
      'head': {
        'key': 'head',
        'version': 1,
        'changedAt': 1,
        'data': {
          'id': 'tab',
          'name': 'Swarm',
          'ownerId': 'owner',
          'projects': <dynamic>[],
          'invitations': <dynamic>[],
        },
      },
      'groups': [
        {
          'key': 'lead',
          'version': 1,
          'changedAt': 1,
          'data': conversationFixture('lead', 'Lead'),
        },
      ],
      'derived': derived,
    };

    test('a change read without them keeps them; a moved one replaces it; '
        'the conversation gone takes it', () {
      final parts = SuperTabParts.firstLoad(
        load({
          'activityDigest': 'd1',
          'chatSettings': {'lead': 'muted', 'gone': 'loud'},
        }),
      );
      expect(parts.state['chatSettings'], {'lead': 'muted'});
      expect(parts.state['activityDigest'], 'd1');
      var change = parts.apply({
        'cursor': 'c2',
        'derived': {'activityDigest': 'd2'},
      });
      expect(parts.state['chatSettings'], {'lead': 'muted'});
      expect(parts.state['activityDigest'], 'd2');
      change = parts.apply({
        'cursor': 'c3',
        'derived': {
          'activityDigest': 'd2',
          'chatSettings': {'lead': 'all'},
        },
      });
      expect(change.changed, isTrue);
      expect(parts.state['chatSettings'], {'lead': 'all'});
      // Kept on this device and read back.
      final back = SuperTabParts.fromJson(parts.toJson());
      expect(back.state['chatSettings'], {'lead': 'all'});
      parts.apply({
        'cursor': 'c4',
        'groups': [
          {'key': 'lead', 'version': 2, 'changedAt': 4, 'deleted': true},
        ],
      });
      expect(parts.state['chatSettings'], isNull);
      // A setting the app does not know reads as the default.
      expect(SuperTabNotify.parse('muted'), SuperTabNotify.muted);
      expect(SuperTabNotify.parse('all'), SuperTabNotify.all);
      expect(SuperTabNotify.parse('loud'), SuperTabNotify.mentions);
    });
  });

  group('per-chat notification setting', () {
    test('shows at once, is kept on the server, and a failure puts the old '
        'setting back', () async {
      final server = projectServer();
      final c = await open(server);
      expect(c.notifyOf('offline'), SuperTabNotify.mentions);
      server.holdNotify = Completer();
      final kept = c.setNotify('offline', SuperTabNotify.muted);
      expect(c.notifyOf('offline'), SuperTabNotify.muted);
      server.holdNotify!.complete();
      expect(await kept, isTrue);
      expect(server.notifyPosts.last, {
        'conversationId': 'offline',
        'notify': 'muted',
      });
      // Still muted until a read carries it, and after.
      expect(c.notifyOf('offline'), SuperTabNotify.muted);
      await c.refresh();
      expect(c.snapshot!.chatSettings['offline'], SuperTabNotify.muted);
      expect(c.notifyOf('offline'), SuperTabNotify.muted);
      server.failNotify = true;
      expect(await c.setNotify('offline', SuperTabNotify.all), isFalse);
      expect(c.notifyOf('offline'), SuperTabNotify.muted);
    });

    test('another device\'s change wins once a read carries it', () async {
      final server = projectServer();
      final c = await open(server);
      await c.setNotify('offline', SuperTabNotify.muted);
      await c.refresh();
      (server.state['chatSettings'] as Map)['owner']['offline'] = 'all';
      server.revision++;
      await c.refresh();
      expect(c.notifyOf('offline'), SuperTabNotify.all);
    });

    test(
      'access lost while a setting is on its way: nothing of it stays',
      () async {
        final server = projectServer();
        final c = await open(server);
        server.holdNotify = Completer();
        final kept = c.setNotify('offline', SuperTabNotify.muted);
        expect(c.notifyOf('offline'), SuperTabNotify.muted);
        c.revokeAccess('Removed from this Swarm.');
        // At once, not when the answer comes.
        expect(c.notifyOf('offline'), SuperTabNotify.mentions);
        server.holdNotify!.complete();
        await kept;
        expect(c.notifyOf('offline'), SuperTabNotify.mentions);
      },
    );

    test('a muted chat is never unread in the sidebar and its tags never '
        'count', () async {
      final server = projectServer();
      fromLead(server, 'News', conversationId: 'offline');
      server.tag('message-1', conversationId: 'offline');
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      final group = c.snapshot!.conversation('offline')!;
      expect(c.unreadShown(group), isTrue);
      expect(attention.mentionsIn('offline'), 1);
      await c.setNotify('offline', SuperTabNotify.muted);
      expect(c.unread(group), isTrue);
      expect(c.unreadShown(group), isFalse);
      expect(attention.mentionsIn('offline'), 0);
    });

    test('a muted chat\'s thread tags never count on Threads either; '
        'unmuted, they count again', () async {
      final server = projectServer();
      server.followedThreads = {
        'unread': [
          unreadThread('message-1', 2),
          unreadThread('message-1', 2, conversationId: 'offline'),
        ],
        'read': [],
        'more': false,
      };
      fromLead(server, 'Root', conversationId: 'offline');
      server.tag(
        'message-1',
        conversationId: 'offline',
        threadId: 'message-1',
        messageSequence: 2,
      );
      server.tag('message-1', threadId: 'message-1', messageSequence: 2);
      final c = await open(server);
      final attention = SuperTabAttention.of(c);
      await attention.mentions.load();
      await attention.load();
      expect(attention.threadMentions, 2);
      await c.setNotify('offline', SuperTabNotify.muted);
      // Only the tag in the chat that is not muted.
      expect(attention.threadMentions, 1);
      await c.setNotify('offline', SuperTabNotify.all);
      expect(attention.threadMentions, 2);
    });
  });

  group('Mark all read (Shift+Esc) holds its write for Undo', () {
    test('marks every unread chat here at once, sends nothing until the hold '
        'ends, then sends each', () {
      fakeAsync((async) {
        final server = projectServer();
        fromLead(server, 'One');
        fromLead(server, 'Two', conversationId: 'offline');
        late SuperTabController c;
        c = server.controller();
        unawaited(c.refresh());
        async.flushMicrotasks();
        final groups = c.snapshot!.conversations;
        expect(groups.where(c.unreadShown).length, 2);
        final held = c.markAllRead()!;
        expect(held.count, 2);
        expect(groups.where(c.unreadShown), isEmpty);
        async.elapse(const Duration(seconds: 5));
        expect(server.readMarkPosts, isEmpty);
        async.elapse(const Duration(seconds: 2));
        async.flushMicrotasks();
        expect(server.readMarkPosts.map((p) => p['conversationId']).toSet(), {
          'lead',
          'offline',
        });
        unawaited(c.flush());
        async.flushMicrotasks();
        c.dispose();
      });
    });

    test('Undo puts each chat back as it was and sends nothing', () {
      fakeAsync((async) {
        final server = projectServer();
        fromLead(server, 'One', conversationId: 'offline');
        final c = server.controller();
        unawaited(c.refresh());
        async.flushMicrotasks();
        final group = c.snapshot!.conversation('offline')!;
        final held = c.markAllRead()!;
        expect(c.unreadShown(group), isFalse);
        held.undo();
        expect(c.unreadShown(group), isTrue);
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(server.readMarkPosts, isEmpty);
        expect(c.markAllRead(), isNotNull);
        unawaited(c.flush());
        async.flushMicrotasks();
        c.dispose();
      });
    });

    test('access lost during the hold sends nothing; closing the Swarm sends '
        'the marks', () {
      fakeAsync((async) {
        final server = projectServer();
        fromLead(server, 'One', conversationId: 'offline');
        final c = server.controller();
        unawaited(c.refresh());
        async.flushMicrotasks();
        c.markAllRead();
        c.revokeAccess('Removed from this Swarm.');
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(server.readMarkPosts, isEmpty);
        c.dispose();

        final again = projectServer();
        fromLead(again, 'One', conversationId: 'offline');
        final d = again.controller();
        unawaited(d.refresh());
        async.flushMicrotasks();
        d.markAllRead();
        d.dispose();
        async.flushMicrotasks();
        expect(again.readMarkPosts.map((p) => p['conversationId']), [
          'offline',
        ]);
      });
    });

    test(
      'a muted chat is left as it is; nothing unread gives nothing',
      () async {
        final server = projectServer();
        fromLead(server, 'One', conversationId: 'offline');
        final c = await open(server);
        await c.setNotify('offline', SuperTabNotify.muted);
        expect(c.markAllRead(), isNull);
      },
    );
  });

  group('next unread chat follows the sidebar\'s order', () {
    test('projects A to Z, each chat then its newest workgroups first, then '
        'Buddy chats', () async {
      final server = projectServer();
      (server.state['projects'] as List).add(
        projectFixture('alpha', 'alpha', 'alpha-chat'),
      );
      (server.state['conversations'] as List)
        ..add({
          ...conversationFixture('alpha-chat', 'alpha'),
          'projectId': 'alpha',
        })
        ..add({
          ...conversationFixture('newer', 'Newer'),
          'projectId': 'lead',
          'number': 20,
        });
      final c = await open(server);
      expect(superTabSidebarOrder(c), [
        'alpha-chat',
        'lead',
        'newer',
        'offline',
      ]);
    });
  });

  group('All new messages tells the system about each new message', () {
    test('only for a chat set to all, not on the first look, not the open '
        'chat', () async {
      final server = projectServer();
      final c = await open(server);
      final told = <(String, int)>[];
      SuperTabChatNotices.of(c).onMessage = (g, s) => told.add((g.id, s));
      fromLead(server, 'Before', conversationId: 'offline');
      await c.refresh();
      expect(told, isEmpty);
      await c.setNotify('offline', SuperTabNotify.all);
      fromLead(server, 'After', conversationId: 'offline');
      await c.refresh();
      expect(told.map((t) => t.$1), ['offline']);
      fromLead(server, 'In the project chat');
      await c.refresh();
      expect(told.map((t) => t.$1), ['offline']);
    });

    Future<(SuperTabController, ConversationServer, List<int>)>
    openChatSetToAll() async {
      final binding = TestWidgetsFlutterBinding.ensureInitialized();
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      final server = projectServer();
      final c = await open(server);
      final told = <int>[];
      SuperTabChatNotices.of(c).onMessage = (_, s) => told.add(s);
      await c.setNotify(c.selectedId, SuperTabNotify.all);
      return (c, server, told);
    }

    test('the open chat is told while its Swarm is away', () async {
      final (c, server, told) = await openChatSetToAll();
      c.away = true;
      fromLead(server, 'While on another Swarm');
      await c.refresh();
      expect(told, hasLength(1));
    });

    test('the open chat is told while another app is in front', () async {
      final (c, server, told) = await openChatSetToAll();
      final binding = TestWidgetsFlutterBinding.instance;
      addTearDown(
        () => binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      fromLead(server, 'While in another app');
      await c.refresh();
      expect(told, hasLength(1));
    });

    test('the open chat on screen in a focused app is not told', () async {
      final (c, server, told) = await openChatSetToAll();
      fromLead(server, 'While reading it');
      await c.refresh();
      expect(told, isEmpty);
    });
  });

  group('sidebar', () {
    for (final brightness in Brightness.values) {
      testWidgets('Activity takes Notifications\' place; a muted chat is '
          'greyed with its mark and no number ($brightness)', (tester) async {
        final server = projectServer();
        fromLead(server, 'News', conversationId: 'offline');
        server.tag('message-1', conversationId: 'offline');
        final c = await openHere(server);
        await SuperTabAttention.of(c).mentions.load();
        c.toggleProject('lead');
        await c.setNotify('offline', SuperTabNotify.muted);
        await pumpSidebar(tester, c, brightness: brightness);
        expect(find.text('Notifications'), findsNothing);
        expect(inRow('super-activity', find.text('Activity')), findsOneWidget);
        expect(inRow('super-activity', find.text('1')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-muted-offline')),
          findsOneWidget,
        );
        expect(
          inRow('super-group-offline', find.byType(SuperTabCountBadge)),
          findsNothing,
        );
        // The workgroup's name, drawn in the row's style.
        final name = tester.widget<SuperTabWorkgroupName>(
          find.descendant(
            of: find.byKey(const ValueKey('super-group-offline')),
            matching: find.byType(SuperTabWorkgroupName),
          ),
        );
        expect(name.style.color, DesktopChrome.muted);
        expect(name.style.fontWeight, isNot(grid.AppFont.semibold));
        await close(tester, c);
      });
    }

    testWidgets('the unread filter lists only unread chats and the open one, '
        'and hides muted ones', (tester) async {
      final server = projectServer();
      (server.state['conversations'] as List)
        ..add({
          ...conversationFixture('quiet', 'Quiet'),
          'projectId': 'lead',
          'number': 13,
        })
        ..add({
          ...conversationFixture('hushed', 'Hushed'),
          'projectId': 'lead',
          'number': 14,
        });
      fromLead(server, 'Read');
      server.markReadElsewhere('lead', server.revision);
      fromLead(server, 'News', conversationId: 'offline');
      fromLead(server, 'Hushed news', conversationId: 'hushed');
      final c = await openHere(server);
      c.toggleProject('lead');
      await c.setNotify('hushed', SuperTabNotify.muted);
      await pumpSidebar(tester, c);
      expect(find.byKey(const ValueKey('super-group-quiet')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-unread-only')));
      await tester.pumpAndSettle();
      expect(c.unreadOnly, isTrue);
      expect(find.byKey(const ValueKey('super-group-offline')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-quiet')), findsNothing);
      expect(find.byKey(const ValueKey('super-group-hushed')), findsNothing);
      await close(tester, c);
    });
  });

  group('the one # buddy row (#2447) follows the same rules', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: 'peer');
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
              machineName: (_) => 'Kens-MacBook',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return c;
    }

    final buddyRow = find.byKey(const ValueKey('super-swarm-buddy'));
    Text buddyName(WidgetTester tester) => tester.widget<Text>(
      find.descendant(of: buddyRow, matching: find.text('buddy')),
    );

    testWidgets('muted: greyed with its mark, never bold; first in the next '
        'unread order', (tester) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      server.append('A word from Wren', conversationId: 'swarm-buddy-peer');
      final c = await show(tester, server);
      expect(superTabSidebarOrder(c).first, 'swarm-buddy-peer');
      expect(buddyName(tester).style?.fontWeight, grid.AppFont.semibold);
      await c.setNotify('swarm-buddy-peer', SuperTabNotify.muted);
      await tester.pumpAndSettle();
      expect(buddyName(tester).style?.color, DesktopChrome.muted);
      expect(buddyName(tester).style?.fontWeight, isNot(grid.AppFont.semibold));
      expect(
        find.byKey(const ValueKey('super-muted-swarm-buddy-peer')),
        findsOneWidget,
      );
      expect(
        c.unreadShown(c.snapshot!.conversation('swarm-buddy-peer')!),
        isFalse,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('the unread filter keeps it shown, bold only while it has '
        'something unread', (tester) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      final c = await show(tester, server);
      expect(buddyRow, findsOneWidget);
      c.toggleUnreadOnly();
      await tester.pumpAndSettle();
      expect(c.unreadOnly, isTrue);
      expect(buddyRow, findsOneWidget);
      expect(buddyName(tester).style?.fontWeight, isNot(grid.AppFont.semibold));
      server.append('A word from Wren', conversationId: 'swarm-buddy-peer');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(buddyRow, findsOneWidget);
      expect(buddyName(tester).style?.fontWeight, grid.AppFont.semibold);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  });
}
