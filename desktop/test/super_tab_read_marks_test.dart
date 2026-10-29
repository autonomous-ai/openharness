import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';

import 'support/super_tab_fixture.dart';

/// A message from the Lead agent, so it is never the reader's own.
void fromLead(ConversationServer server, String text) {
  server.append(text);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

void main() {
  Future<SuperTabController> open(ConversationServer server) async {
    final c = server.controller();
    addTearDown(() async {
      await c.flush();
      c.dispose();
    });
    await c.refresh();
    return c;
  }

  test('a conversation read on another device is read here too', () async {
    final server = ConversationServer();
    fromLead(server, 'First update');
    fromLead(server, 'Second update');
    final c = await open(server);
    c.select('offline');
    expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
    server.markReadElsewhere('lead', 2);
    await c.refresh();
    expect(c.unread(c.snapshot!.conversation('lead')!), isFalse);
    expect(c.readMark('lead'), 2);
    // A later message is unread again, past the other device's mark.
    fromLead(server, 'Third update');
    await c.refresh();
    expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
  });

  test('a reply that lives only in its thread leaves the chat read; one also '
      'sent to the chat counts once', () async {
    final server = ConversationServer()..threads = true;
    final lead = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'lead');
    fromLead(server, 'Root');
    // As the threads backend keeps it: the newest message the chat shows.
    lead['lastMainSequence'] = server.revision;
    final c = await open(server);
    await c.loadMessages('lead');
    c.markRead('lead', through: 1);
    fromLead(server, 'Thread-only reply');
    server.messages.last['thread'] = 'message-1';
    await c.refresh();
    await c.loadMessages('lead');
    expect(c.unread(c.selected!), isFalse);
    expect(c.unreadCount(c.selected!), 0);
    fromLead(server, 'Also in the chat');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['alsoInChat'] = true;
    lead['lastMainSequence'] = server.revision;
    await c.refresh();
    await c.loadMessages('lead');
    expect(c.unread(c.selected!), isTrue);
    expect(c.unreadCount(c.selected!), 1);
    // The mark still moves over the thread's replies.
    c.markRead('lead');
    await pumpEventQueue();
    expect(server.readMarkPosts.last, {
      'conversationId': 'lead',
      'sequence': 3,
    });
  });

  test(
    'another person\'s marks never mark the reader\'s conversations read',
    () async {
      final server = ConversationServer();
      fromLead(server, 'Update');
      final c = await open(server);
      c.select('offline');
      server.markReadElsewhere('lead', 1, reader: 'peer');
      await c.refresh();
      expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
    },
  );

  test('a chat not loaded here stays unbolded for a reply only in its '
      'thread, past the mark another device kept', () async {
    final server = ConversationServer()..threads = true;
    final offline = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'offline');
    server.append('Root', conversationId: 'offline');
    offline['lastMainSequence'] = server.revision;
    server.markReadElsewhere('offline', server.revision);
    final c = await open(server);
    // Its messages were never read on this device.
    expect(c.messages('offline'), isEmpty);
    server.append('Only in the thread.', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['author'] = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};
    await c.refresh();
    SuperTabConversation group() => c.snapshot!.conversation('offline')!;
    expect(c.messages('offline'), isEmpty);
    expect(c.unread(group()), isFalse);
    // A reply also sent to the chat makes it bold.
    server.append('For everyone.', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['alsoInChat'] = true;
    offline['lastMainSequence'] = server.revision;
    await c.refresh();
    expect(c.unread(group()), isTrue);
  });

  test('reading sends the mark forward once, never a lower one', () async {
    final server = ConversationServer();
    fromLead(server, 'One');
    fromLead(server, 'Two');
    final c = await open(server);
    await c.loadMessages('lead');
    c.markRead('lead', through: 1);
    await pumpEventQueue();
    c.markRead('lead', through: 1);
    await pumpEventQueue();
    c.markRead('lead', through: 2);
    await pumpEventQueue();
    c.markRead('lead', through: 1);
    await pumpEventQueue();
    expect(server.readMarkPosts, [
      {'conversationId': 'lead', 'sequence': 1},
      {'conversationId': 'lead', 'sequence': 2},
    ]);
  });

  test('offline, this device\'s mark still reads the conversation, and the '
      'mark is sent again on the next read', () async {
    final server = ConversationServer();
    fromLead(server, 'One');
    final c = await open(server);
    await c.loadMessages('lead');
    server.failReadMarks = true;
    c.markRead('lead', through: 1);
    await pumpEventQueue();
    expect(c.unread(c.selected!), isFalse);
    server.failReadMarks = false;
    c.markRead('lead', through: 1);
    await pumpEventQueue();
    expect(server.readMarkPosts, [
      {'conversationId': 'lead', 'sequence': 1},
      {'conversationId': 'lead', 'sequence': 1},
    ]);
    await c.refresh();
    expect(c.unread(c.selected!), isFalse);
  });

  group('the parts held on this device', () {
    Map<String, dynamic> group(
      String id,
      int version, {
      bool deleted = false,
    }) => {
      'key': id,
      'version': version,
      if (deleted) 'deleted': true else 'data': {'id': id},
    };
    Map<String, dynamic> load(Map<String, int> marks) => {
      'format': superTabReadFormat,
      'cursor': 'c1',
      'epoch': 1,
      'head': {'key': 'head', 'version': 1, 'data': <String, dynamic>{}},
      'groups': [group('lead', 1), group('web', 1)],
      'derived': {'readMarks': marks},
    };
    Map<String, dynamic> changes(
      Map<String, int> marks, {
      List<Map<String, dynamic>> groups = const [],
    }) => {
      'format': superTabReadFormat,
      'reload': false,
      'cursor': 'c2',
      'epoch': 1,
      'head': null,
      'groups': groups,
      'derived': {'readMarks': marks},
    };

    test('keep the highest mark each read sent, across a restart', () {
      final parts = SuperTabParts.firstLoad(load({'lead': 4, 'web': 2}));
      // A change read sends only the marks that moved; an older copy the
      // cursor's overlap sends again never lowers one.
      expect(parts.apply(changes({'web': 9})).changed, isTrue);
      expect(parts.apply(changes({'lead': 3})).changed, isFalse);
      expect(parts.state['readMarks'], {'lead': 4, 'web': 9});
      final restored = SuperTabParts.fromJson(
        SuperTabParts.drawnOnly(parts.toJson()),
      );
      expect(restored.state['readMarks'], {'lead': 4, 'web': 9});
    });

    test('drop the mark of a conversation that is gone', () {
      final parts = SuperTabParts.firstLoad(load({'lead': 4, 'web': 2}));
      parts.apply(changes({}, groups: [group('web', 2, deleted: true)]));
      expect(parts.state['readMarks'], {'lead': 4});
    });
  });
}
