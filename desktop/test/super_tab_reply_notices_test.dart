import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/reply_notices.dart';

import 'super_tab_mentions_test.dart' show ShownNotices;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// One Activity row as the backend lists it (backend activity.ts).
Map<String, dynamic> row(
  String id, {
  String kind = 'reply',
  String conversationId = 'offline',
  String? threadId = 'root-1',
  String text = 'Sounds good, I will ship the copy today',
  bool read = false,
}) => {
  'id': id,
  'kind': kind,
  'conversationId': conversationId,
  'conversationTitle': 'Web launch',
  'projectName': 'openharness',
  'messageId': 'message-$id',
  'messageSequence': 4,
  'threadId': threadId,
  'actor': {'kind': 'person', 'id': 'mia', 'name': 'Mia'},
  'emoji': kind == 'reaction' ? '👍' : null,
  'text': text,
  'createdAt': '2026-11-04T05:00:00.000Z',
  'read': read,
};

/// A Swarm whose Activity holds [items], newest first, and a controller that
/// read it once.
Future<(ConversationServer, SuperTabController, List<SuperTabReplyRow>)>
opened([List<Map<String, dynamic>> items = const []]) async {
  final server = ConversationServer();
  server.state['activityDigest'] = 'd1';
  server.activity = {'items': items, 'more': false};
  final c = server.controller();
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  final told = <SuperTabReplyRow>[];
  SuperTabReplyNotices.of(c).onReply = told.add;
  await c.refresh();
  await pumpEventQueue();
  return (server, c, told);
}

/// The server lists [items] now, and the digest moves so the app reads them.
Future<void> arrive(
  ConversationServer server,
  SuperTabController c,
  List<Map<String, dynamic>> items,
) async {
  server.activity = {'items': items, 'more': false};
  server.state['activityDigest'] = 'd${server.revision + 2}';
  server.revision++;
  await c.refresh();
  await pumpEventQueue();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SuperTabReplyNotices', () {
    test(
      'the first read tells nothing: rows there before are no news',
      () async {
        final (server, _, told) = await opened([row('r1'), row('r2')]);
        expect(server.activityReads, hasLength(1));
        expect(told, isEmpty);
      },
    );

    test('a new unread reply row tells once, with its copy', () async {
      final (server, c, told) = await opened([row('r1')]);
      await arrive(server, c, [row('r2'), row('r1')]);
      expect(told.map((r) => r.id), ['r2']);
      final reply = told.single;
      expect(reply.actorName, 'Mia');
      expect(reply.projectName, 'openharness');
      expect(reply.conversationTitle, 'Web launch');
      expect(reply.conversationId, 'offline');
      expect(reply.messageId, 'message-r2');
      expect(reply.threadId, 'root-1');
      expect(reply.text, 'Sounds good, I will ship the copy today');

      // The same row again, in a later read: told once only.
      await arrive(server, c, [row('r2'), row('r1')]);
      expect(told.map((r) => r.id), ['r2']);
    });

    test('a read row and a reaction row tell nothing', () async {
      final (server, c, told) = await opened();
      await arrive(server, c, [
        row('x1', kind: 'reaction'),
        row('r1', read: true),
      ]);
      expect(told, isEmpty);
    });

    test(
      'a reply in the thread open and being read now tells nothing',
      () async {
        final (server, c, told) = await opened();
        c.openThread('root-1');
        await arrive(server, c, [row('r1', conversationId: c.selectedId)]);
        expect(told, isEmpty);
        // The same thread with its pane off screen: told.
        c.threadPaneHidden();
        await pumpEventQueue();
        await arrive(server, c, [
          row('r2', conversationId: c.selectedId),
          row('r1', conversationId: c.selectedId),
        ]);
        expect(told.map((r) => r.id), ['r2']);
      },
    );

    test(
      'a reply also in the chat open and being read tells nothing',
      () async {
        final (server, c, told) = await opened();
        final notices = SuperTabChatNotices.of(c);
        var shown = true;
        notices.chatShown = () => shown;
        await arrive(server, c, [
          row('r1', conversationId: c.selectedId, threadId: null),
        ]);
        expect(told, isEmpty);
        shown = false;
        await arrive(server, c, [
          row('r2', conversationId: c.selectedId, threadId: null),
          row('r1', conversationId: c.selectedId, threadId: null),
        ]);
        expect(told.map((r) => r.id), ['r2']);
      },
    );

    test(
      'a server answering 404 tells nothing and is not asked again',
      () async {
        final server = ConversationServer();
        server.state['activityDigest'] = 'd1';
        server.activity = null;
        final c = server.controller();
        addTearDown(c.dispose);
        final told = <SuperTabReplyRow>[];
        SuperTabReplyNotices.of(c).onReply = told.add;
        await c.refresh();
        await pumpEventQueue();
        expect(server.activityReads, hasLength(1));
        server.state['activityDigest'] = 'd2';
        server.revision++;
        await c.refresh();
        await pumpEventQueue();
        expect(server.activityReads, hasLength(1));
        expect(told, isEmpty);
      },
    );

    test('a backend without the Activity digest is never asked', () async {
      final server = ConversationServer();
      final c = server.controller();
      addTearDown(c.dispose);
      SuperTabReplyNotices.of(c).onReply = (_) {};
      await c.refresh();
      await pumpEventQueue();
      expect(server.activityReads, isEmpty);
    });
  });

  group('system notice', () {
    test('only Desktop hands a new reply to the operating system; a click '
        'opens the thread at the reply', () async {
      final notices = ShownNotices();
      final store = DesktopNotificationStore(storage: MemoryStore());
      await store.set(true);
      final system = SystemNotifications(store: store, notifier: notices);
      expect(superTabReplyNotice(system, web: true), isNull);
      superTabReplyNotice(system, web: false)!(
        'tab-1',
        SuperTabReplyRow.fromJson(row('r1')),
      );
      await pumpEventQueue();
      expect(notices.shown, [
        (
          title: 'Mia replied in a thread',
          body:
              'openharness · Web launch: Sounds good, I will ship the copy '
              'today',
        ),
      ]);
      // The click opens it as a message link does: its thread, at the reply.
      final (machine, target) = notices.routes.single;
      expect(machine, SystemNotifications.messageNoticeMachine);
      final link = SwarmMessageLink.parse(target)!;
      expect(
        (link.tabId, link.conversationId, link.messageId),
        ('tab-1', 'offline', 'message-r1'),
      );
    });

    test('the client hands each new reply of an open Swarm over', () async {
      final server = ConversationServer();
      server.state['activityDigest'] = 'd1';
      server.activity = {
        'items': [row('r1')],
        'more': false,
      };
      final told = <String>[];
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: (method, path, {body}) =>
            server.request(method, path, body: body),
        discoveryInterval: Duration.zero,
        onReply: (tab, reply) => told.add('$tab: ${reply.id}'),
      );
      addTearDown(client.dispose);
      client.bind('owner');
      final c = await client.open('tab');
      await c.refresh();
      await pumpEventQueue();
      await arrive(server, c, [row('r2'), row('r1')]);
      expect(told, ['tab: r2']);
    });
  });
}
