import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';
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
    show
        close,
        conversation,
        fromLead,
        inRow,
        openHere,
        projectServer,
        rowText,
        unreadThread;
import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

Map<String, dynamic> reply(
  String id, {
  String conversationId = 'lead',
  bool read = false,
  String createdAt = '2026-10-31T03:00:00.000Z',
}) => {
  'id': id,
  'kind': 'reply',
  'conversationId': conversationId,
  'conversationTitle': 'Chat $conversationId',
  'projectName': 'web-project',
  'messageId': 'm-$id',
  'messageSequence': 4,
  'threadId': 'root',
  'actor': {'kind': 'person', 'id': 'peer', 'name': 'peer'},
  'emoji': null,
  'text': 'Reply $id',
  'createdAt': createdAt,
  'read': read,
};

Map<String, dynamic> reaction(String id, {bool read = false}) => {
  ...reply(id, read: read),
  'kind': 'reaction',
  'emoji': 'check',
  'text': 'My message',
};

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

  group('Activity: replies and reactions to the reader', () {
    test('reads when its digest moves, not again for the same digest, and '
        'keeps only chats this Swarm lists', () async {
      final server = projectServer();
      server.state['activityDigest'] = 'd1';
      server.activity = {
        'items': [reply('r1'), reply('r2', conversationId: 'other-swarm-chat')],
        'more': false,
      };
      final c = await open(server);
      final activity = SuperTabActivity.of(c);
      await settle();
      expect(server.activityReads, hasLength(1));
      expect(activity.items.map((i) => i.id), ['r1']);
      expect(activity.count, 1);
      await c.refresh();
      await settle();
      expect(server.activityReads, hasLength(1));
      server.state['activityDigest'] = 'd2';
      server.revision++;
      await c.refresh();
      await settle();
      expect(server.activityReads, hasLength(2));
    });

    test('a server before Activity (404) asks once; tags and decisions still '
        'count', () async {
      final server = projectServer();
      server.state['activityDigest'] = 'd1';
      server.state['mentionsWaiting'] = 2;
      server.activity = null;
      final c = await open(server);
      final activity = SuperTabActivity.of(c);
      await settle();
      expect(activity.supported, isFalse);
      expect(activity.count, 2);
      server.state['activityDigest'] = 'd2';
      server.revision++;
      await c.refresh();
      await settle();
      expect(server.activityReads, hasLength(1));
    });

    test(
      'a failed first read says so, and a later digest recovers it',
      () async {
        final server = projectServer();
        server.state['activityDigest'] = 'd1';
        server.activityStatus = 503;
        server.activity = {
          'items': [reply('r1')],
          'more': false,
        };
        final c = await open(server);
        final activity = SuperTabActivity.of(c);
        await settle();
        expect(activity.error, isNotNull);
        expect(activity.items, isEmpty);
        server.activityStatus = 0;
        // The next change of the Swarm reads it again, though its digest
        // did not move.
        fromLead(server, 'Something else changed');
        await c.refresh();
        await settle();
        expect(activity.error, isNull);
        expect(activity.items.map((i) => i.id), ['r1']);
      },
    );

    test(
      'access lost: rows go at once and an answer on its way is dropped',
      () async {
        final server = projectServer();
        server.state['activityDigest'] = 'd1';
        server.activity = {
          'items': [reply('r1')],
          'more': false,
        };
        final c = await open(server);
        final activity = SuperTabActivity.of(c);
        await settle();
        expect(activity.items, hasLength(1));
        server.holdActivity = Completer();
        unawaited(activity.load());
        await pumpEventQueue();
        c.revokeAccess('Removed from this Swarm.');
        expect(activity.items, isEmpty);
        expect(activity.count, 0);
        server.holdActivity!.complete();
        await settle();
        expect(activity.items, isEmpty);
      },
    );

    test(
      'a read that answers after the Swarm\'s audience moved is dropped',
      () async {
        final server = projectServer();
        server.state['activityDigest'] = 'd1';
        server.activity = {
          'items': [reply('r1')],
          'more': false,
        };
        final c = await open(server);
        final activity = SuperTabActivity.of(c);
        await settle();
        server.holdActivity = Completer();
        unawaited(activity.load());
        await pumpEventQueue();
        server.parts.epoch++;
        server.revision++;
        server.activity = {'items': <dynamic>[], 'more': false};
        await c.refresh();
        // Every state shown from here: the old answer must never show.
        final shown = <List<String>>[];
        activity.addListener(
          () => shown.add([for (final i in activity.items) i.id]),
        );
        server.holdActivity!.complete();
        await settle();
        expect(activity.items, isEmpty);
        expect(shown.where((ids) => ids.contains('r1')), isEmpty);
      },
    );

    test(
      'leaving the view marks what it showed read, bold until then',
      () async {
        final server = projectServer();
        server.state['activityDigest'] = 'd1';
        server.activity = {
          'items': [reply('r1'), reaction('x1', read: true)],
          'more': false,
        };
        final c = await open(server);
        final activity = SuperTabActivity.of(c);
        await settle();
        activity.opened();
        await settle();
        final r1 = activity.items.firstWhere((i) => i.id == 'r1');
        expect(activity.isUnread(r1), isTrue);
        expect(activity.unread, isTrue);
        activity.closed();
        await settle();
        expect(
          server.activityReadPosts.single['through'],
          '2026-10-31T03:00:00.000Z',
        );
        expect(activity.items.every((i) => i.read), isTrue);
        expect(activity.count, 0);
      },
    );
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
      await settle();
      expect(told, isEmpty);
      await c.setNotify('offline', SuperTabNotify.all);
      fromLead(server, 'After', conversationId: 'offline');
      await c.refresh();
      await settle();
      expect(told.map((t) => t.$1), ['offline']);
      fromLead(server, 'In the project chat');
      await c.refresh();
      await settle();
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
      await settle();
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
      await settle();
      expect(told, hasLength(1));
    });

    // Task #2224: what a person sent from their phone, the web or another Mac tells them nothing.
    Future<(SuperTabController, ConversationServer, List<int>)>
    chatSetToAll() async {
      final server = projectServer();
      final c = await open(server);
      final told = <int>[];
      SuperTabChatNotices.of(c).onMessage = (_, s) => told.add(s);
      await c.setNotify('offline', SuperTabNotify.all);
      return (c, server, told);
    }

    test('their own message from another device tells them nothing', () async {
      final (c, server, told) = await chatSetToAll();
      server.append('From my phone', conversationId: 'offline');
      await c.refresh();
      await settle();
      expect(told, isEmpty);
    });

    test(
      'a message whose author can\'t be read is told about, never lost',
      () async {
        final server = projectServer();
        final c = SuperTabController(
          tabId: 'tab',
          accountId: 'owner',
          save: server.save,
          request: (method, path, {body}) async {
            if (path.contains('offline/messages?after=')) {
              throw StateError('Offline');
            }
            return server.request(method, path, body: body);
          },
        );
        addTearDown(c.dispose);
        await c.refresh();
        final told = <int>[];
        SuperTabChatNotices.of(c).onMessage = (_, s) => told.add(s);
        await c.setNotify('offline', SuperTabNotify.all);
        fromLead(server, 'From the Lead', conversationId: 'offline');
        await c.refresh();
        await settle();
        expect(told, hasLength(1));
      },
    );

    test('a teammate\'s message still does', () async {
      final (c, server, told) = await chatSetToAll();
      fromLead(server, 'From the Lead', conversationId: 'offline');
      await c.refresh();
      await settle();
      expect(told, hasLength(1));
    });

    test('a teammate\'s message among their own still does', () async {
      final (c, server, told) = await chatSetToAll();
      fromLead(server, 'From the Lead', conversationId: 'offline');
      server.append('From my phone', conversationId: 'offline');
      await c.refresh();
      await settle();
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

  group('Activity view', () {
    testWidgets('lists tags, replies and reactions newest first, filters one '
        'kind, and opens a row at its message', (tester) async {
      final server = projectServer();
      server.state['activityDigest'] = 'd1';
      server.activity = {
        'items': [
          reply('r1', createdAt: '2026-10-31T05:00:00.000Z'),
          reaction('x1', read: true),
        ],
        'more': false,
      };
      final c = await openHere(server);
      final activity = SuperTabActivity.of(c);
      await tester.runAsync(settle);
      final opened = <(String, String)>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabActivityView(
              activity: activity,
              onOpenMention: (_) {},
              onOpenMessage: (id, m) => opened.add((id, m)),
              now: () => DateTime.utc(2026, 10, 31, 6),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('peer replied to your message'), findsOneWidget);
      expect(find.text('peer reacted ✅ to your message'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('super-activity-filter-reactions')),
      );
      await tester.pumpAndSettle();
      expect(find.text('peer replied to your message'), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('super-activity-filter-replies')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-activity-r1')));
      expect(opened, [('lead', 'm-r1')]);
      await close(tester, c);
      expect(server.activityReadPosts, isNotEmpty);
    });
  });

  group('leaving Activity marks read only what the visit showed (Diego)', () {
    Future<void> visit(
      WidgetTester tester,
      SuperTabActivity activity, {
      List<SuperTabActivityFilter> filters = const [],
      Future<void> Function()? during,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabActivityView(
              activity: activity,
              onOpenMention: (_) {},
              onOpenMessage: (_, _) {},
              now: () => DateTime.utc(2026, 10, 31, 6),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final filter in filters) {
        await tester.tap(
          find.byKey(ValueKey('super-activity-filter-${filter.name}')),
        );
        await tester.pumpAndSettle();
      }
      await during?.call();
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(settle);
    }

    Future<(ConversationServer, SuperTabController, SuperTabActivity)> unread(
      WidgetTester tester,
      List<Map<String, dynamic>> items,
    ) async {
      final server = projectServer();
      server.state['activityDigest'] = 'd1';
      server.activity = {'items': items, 'more': false};
      final c = await openHere(server);
      final activity = SuperTabActivity.of(c);
      await tester.runAsync(settle);
      return (server, c, activity);
    }

    Map<String, dynamic> at(Map<String, dynamic> item, String time) => {
      ...item,
      'createdAt': '2026-10-31T$time:00.000Z',
    };

    testWidgets('a Decisions-only visit leaves replies unread', (tester) async {
      final (server, c, activity) = await unread(tester, [reply('r1')]);
      final count = activity.count;
      await visit(
        tester,
        activity,
        filters: [SuperTabActivityFilter.decisions],
      );
      expect(server.activityReadPosts, isEmpty);
      expect(activity.items.single.read, isFalse);
      expect(activity.count, count);
      await close(tester, c);
    });

    testWidgets('a Mentions-only visit leaves reactions unread', (
      tester,
    ) async {
      final (server, c, activity) = await unread(tester, [reaction('x1')]);
      await visit(tester, activity, filters: [SuperTabActivityFilter.mentions]);
      expect(server.activityReadPosts, isEmpty);
      expect(activity.items.single.read, isFalse);
      await close(tester, c);
    });

    testWidgets('a visit on All marks both kinds through the newest', (
      tester,
    ) async {
      final (server, c, activity) = await unread(tester, [
        at(reply('r1'), '05:00'),
        at(reaction('x1'), '04:00'),
      ]);
      await visit(tester, activity);
      expect(server.activityReadPosts, hasLength(1));
      expect(
        server.activityReadPosts.single['through'],
        '2026-10-31T05:00:00.000Z',
      );
      expect(activity.items.every((i) => i.read), isTrue);
      await close(tester, c);
    });

    testWidgets(
      'only the list showing when it is left counts: Replies, then Reactions',
      (tester) async {
        final (server, c, activity) = await unread(tester, [
          at(reaction('x1'), '05:00'),
          at(reply('r1'), '06:00'),
        ]);
        await visit(
          tester,
          activity,
          filters: [
            SuperTabActivityFilter.replies,
            SuperTabActivityFilter.reactions,
          ],
        );
        expect(
          server.activityReadPosts.single['through'],
          '2026-10-31T05:00:00.000Z',
        );
        expect(
          {for (final i in activity.items) i.id: i.read},
          {'x1': true, 'r1': false},
        );
        await close(tester, c);
      },
    );

    testWidgets(
      'a Replies visit stops before an unread reaction it did not show: '
      'the mark is by time',
      (tester) async {
        final (server, c, activity) = await unread(tester, [
          at(reply('new'), '06:00'),
          at(reaction('x1'), '05:00'),
          at(reply('old'), '04:00'),
        ]);
        activity.setFilter(SuperTabActivityFilter.replies);
        await visit(tester, activity);
        expect(
          server.activityReadPosts.single['through'],
          '2026-10-31T04:00:00.000Z',
        );
        final read = {for (final i in activity.items) i.id: i.read};
        expect(read, {'new': false, 'x1': false, 'old': true});
        await close(tester, c);
      },
    );

    testWidgets(
      'an unread reaction at the same moment as a shown reply stops it too',
      (tester) async {
        final (server, c, activity) = await unread(tester, [
          at(reply('r1'), '05:00'),
          at(reaction('x1'), '05:00'),
        ]);
        activity.setFilter(SuperTabActivityFilter.replies);
        await visit(tester, activity);
        expect(server.activityReadPosts, isEmpty);
        await close(tester, c);
      },
    );

    testWidgets(
      'a row that arrives while Replies shows is listed, and is read on leaving',
      (tester) async {
        final (server, c, activity) = await unread(tester, [
          at(reply('r1'), '05:00'),
        ]);
        await visit(
          tester,
          activity,
          filters: [SuperTabActivityFilter.replies],
          during: () async {
            server.activity = {
              'items': [at(reply('r2'), '06:00'), at(reply('r1'), '05:00')],
              'more': false,
            };
            await tester.runAsync(() => activity.load());
          },
        );
        expect(
          server.activityReadPosts.single['through'],
          '2026-10-31T06:00:00.000Z',
        );
        await close(tester, c);
      },
    );

    testWidgets(
      'leaving puts the filter back on All; a filter asked for still opens on it',
      (tester) async {
        final (_, c, activity) = await unread(tester, [reply('r1')]);
        activity.setFilter(SuperTabActivityFilter.decisions);
        await visit(tester, activity);
        expect(activity.filter, SuperTabActivityFilter.all);
        await close(tester, c);
      },
    );
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
