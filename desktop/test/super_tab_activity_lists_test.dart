import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/activity.dart';

import 'support/super_tab_fixture.dart';

/// One project, "web-project", whose chat is `lead`; `offline` is a workgroup
/// of it that Kestrel works in.
ConversationServer swarm() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  server.state['agents'] = [
    {
      'id': 'kestrel',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Kestrel',
      'machineId': 'host',
      'harnessId': 'session',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  final offline = _group(server, 'offline');
  offline
    ..['projectId'] = 'lead'
    ..['title'] = 'Windows credential fix'
    ..['agentIds'] = ['kestrel'];
  return server;
}

Map<String, dynamic> _group(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

/// The task in `offline` whose agent asked [askedOf], the default reader, by name.
void wait(ConversationServer server, {String askedOf = 'owner'}) {
  _group(server, 'offline')['assignment'] = {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': 'needs_human',
    'askedOf': askedOf,
  };
}

/// The task in `offline` finished at [at], local time.
void finish(ConversationServer server, DateTime at, {String? title}) {
  _group(server, 'offline')
    ..['title'] = title ?? 'Windows credential fix'
    ..['assignment'] = {'id': 'a1', 'agentId': 'kestrel', 'status': 'done'}
    ..['shippedAt'] = at.millisecondsSinceEpoch;
}

Map<String, dynamic> unreadThread(String root, {String text = 'Root text'}) => {
  'conversationId': 'offline',
  'rootId': root,
  'root': {
    'id': root,
    'sequence': 1,
    'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
    'text': text,
    'createdAt': '2026-10-31T01:00:00Z',
    'attachments': 0,
  },
  'lastReplyAt': '2026-10-31T02:00:00Z',
  'lastReplySequence': 2,
  'lastReplier': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'unreadReplies': 3,
  'follow': null,
};

Future<SuperTabActivity> load(
  ConversationServer server, {
  String account = 'owner',
}) async {
  final c = server.controller(account: account);
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  await c.refresh();
  final activity = SuperTabActivity.of(c);
  await activity.mentions.load();
  await activity.decisions.load();
  await activity.attention.load();
  return activity;
}

final _evening = DateTime(2026, 11, 2, 20, 30);

void main() {
  group('Needs you', () {
    test('lists the decisions asked of the reader and the agents waiting on '
        'them, in that order, and counts each; a tag is not listed, but '
        'counts on Activity (#2887)', () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it?']);
      wait(server);
      server.tag('message-1');
      final activity = await load(server);
      expect(
        [for (final n in activity.needsYou) n.kind],
        [SuperTabNeedKind.decision, SuperTabNeedKind.agent],
      );
      expect(
        [for (final n in activity.needsYou) n.title],
        ['Ship it?', 'Kestrel is waiting on you'],
      );
      expect(activity.needsCount, 2);
      expect(activity.count, 3);
    });

    test(
      'an agent whose question is already a decision is listed once',
      () async {
        final server = swarm();
        server.ask(['Ship it?'], conversationId: 'offline');
        wait(server);
        final activity = await load(server);
        expect(
          [for (final n in activity.needsYou) n.kind],
          [SuperTabNeedKind.decision],
        );
      },
    );

    test(
      'a task asked of someone else, or not waiting, is not listed',
      () async {
        final server = swarm();
        _group(server, 'offline')['assignment'] = {
          'id': 'a1',
          'agentId': 'kestrel',
          'status': 'needs_human',
          'askedOf': 'someone-else',
        };
        final asked = await load(server);
        expect(asked.needsYou, isEmpty);
        _group(server, 'offline')['assignment'] = {
          'id': 'a1',
          'agentId': 'kestrel',
          'status': 'working',
        };
        final working = await load(server);
        expect(working.needsYou, isEmpty);
      },
    );
  });

  group('what is for this reader', () {
    ConversationServer twoPeople() {
      final server = swarm()..followedThreads = null;
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      return server;
    }

    test('a task waiting on nobody named is for no one, not its requester '
        'or the owner', () async {
      final server = twoPeople();
      wait(server);
      _group(server, 'offline')
        ..['requesterId'] = 'peer'
        ..['assignment'].remove('askedOf');
      for (final account in ['owner', 'peer']) {
        final activity = await load(server, account: account);
        expect(activity.needsYou, isEmpty);
        expect(activity.count, 0);
        expect(activity.unread, isFalse);
      }
    });

    test('a task asked of one person is for that person alone', () async {
      final server = twoPeople();
      wait(server, askedOf: 'peer');
      expect((await load(server)).count, 0);
      expect((await load(server, account: 'peer')).count, 1);
    });

    test('a tag in a thread the reader does not follow is a mention, not Needs you', () async {
      final server = swarm();
      server.tag('message-2', threadId: 'message-1', messageSequence: 2);
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      final activity = await load(server);
      expect(activity.needsYou, isEmpty);
      expect(activity.needsCount, 0);
      expect(activity.count, 1);
      expect(activity.mentionRows, hasLength(1));
      expect(activity.unread, isTrue);
      expect(activity.newReplies, isEmpty);
    });
  });

  group('the number', () {
    test('counts Needs you and the unread tags: new replies, done work and '
        'replies to the reader add nothing', () async {
      final server = swarm();
      server.ask(['Ship it?']);
      server.tag('message-1');
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      finish(server, DateTime(2026, 11, 2, 8));
      server.state['activityDigest'] = 'd1';
      server.activity = {
        'items': [
          {
            'id': 'r1',
            'kind': 'reply',
            'conversationId': 'lead',
            'conversationTitle': 'Lead',
            'projectName': 'web-project',
            'messageId': 'm-r1',
            'messageSequence': 4,
            'threadId': 'root',
            'actor': {'kind': 'person', 'id': 'peer', 'name': 'peer'},
            'emoji': null,
            'text': 'Reply',
            'createdAt': '2026-10-31T03:00:00.000Z',
            'read': false,
          },
        ],
        'more': false,
      };
      await withClock(Clock.fixed(_evening), () async {
        final activity = await load(server);
        expect(activity.needsCount, 1);
        expect(activity.count, 2);
        expect(activity.newReplies, hasLength(1));
      });
    });

    test('is bold for new replies alone, and not for done work', () async {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      final replies = await load(server);
      expect(replies.count, 0);
      expect(replies.unread, isTrue);

      final done = swarm()..followedThreads = null;
      finish(done, DateTime(2026, 11, 2, 8));
      await withClock(Clock.fixed(_evening), () async {
        final activity = await load(done);
        expect(activity.unread, isFalse);
      });
    });
  });

  group('the number clears by reading (Dee: every number)', () {
    Future<void> reload(
      SuperTabActivity activity,
      ConversationServer server,
    ) async {
      server.revision++;
      await activity.controller.refresh();
      await activity.mentions.load();
      await activity.decisions.load();
    }

    test('a tag counts and is bold until its chat is read past it', () async {
      final server = swarm()..followedThreads = null;
      server.tag('message-1', messageSequence: 5);
      server.state['readMarks'] = {
        'owner': {'lead': 4},
      };
      final activity = await load(server);
      expect(activity.count, 1);
      expect(activity.needsYou, isEmpty);
      expect(activity.unread, isTrue);
      server.state['readMarks'] = {
        'owner': {'lead': 5},
      };
      await reload(activity, server);
      expect(activity.count, 0);
      expect(activity.unread, isFalse);
    });

    test('a decision counts until it is answered', () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it?']);
      final activity = await load(server);
      expect(activity.count, 1);
      server.answerDecision('decision-1', 0);
      server.state['decisionsWaiting'] = 0;
      await reload(activity, server);
      expect(activity.count, 0);
      expect(activity.needsYou, isEmpty);
    });

    test('an agent waiting counts until it is answered', () async {
      final server = swarm()..followedThreads = null;
      wait(server);
      final activity = await load(server);
      expect(activity.count, 1);
      _group(server, 'offline')['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
      await reload(activity, server);
      expect(activity.count, 0);
      expect(activity.needsYou, isEmpty);
    });

    test('a tag in a thread-only reply is a mention and a new reply, not Needs you', () async {
      final server = swarm();
      server.tag(
        'message-2',
        conversationId: 'offline',
        threadId: 'message-1',
        messageSequence: 2,
      );
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      final activity = await load(server);
      expect(activity.needsYou, isEmpty);
      expect(activity.mentionRows.single.newest.conversationId, 'offline');
      expect(activity.needsCount, 0);
      expect(activity.count, 1);
      expect(activity.newReplies.map((t) => t.rootId), ['message-1']);
    });
  });

  group('New replies', () {
    test(
      'are the followed threads with replies the reader has not read',
      () async {
        final server = swarm();
        server.followedThreads = {
          'unread': [unreadThread('message-1', text: 'Fix the credential')],
          'read': [],
          'more': false,
        };
        final activity = await load(server);
        expect(
          [for (final t in activity.newReplies) (t.rootText, t.unreadReplies)],
          [('Fix the credential', 3)],
        );
      },
    );
  });

  group('batch actions', () {
    test('mark all read keeps going past a failure', () async {
      final server = swarm()
        ..tag('message-1')
        ..tag('message-2')
        ..tag('message-3');
      var done = 0;
      server.unknownCommand = (command) =>
          command['type'] == 'mention.done' && ++done == 2;
      final activity = await load(server);
      final mentions = activity.mentions;
      final reads = server.mentionReads;
      final posts = server.posts.length;

      final marked = await mentions.doneAll(mentions.waiting);

      expect(marked, 2);
      expect(server.posts.length - posts, 3);
      expect(mentions.error, 'Could not mark some as read. Try again.');
      // The one read after: waiting and earlier are two lists.
      expect(server.mentionReads - reads, 2);
      expect(mentions.waiting.length, 1);
    });

    test('mark all read sends two at a time, never more', () async {
      final server = swarm();
      for (var i = 1; i <= 5; i++) {
        server.tag('message-$i');
      }
      final activity = await load(server);
      final before = server.posts.length;
      final hold = server.holdCommands = Completer<void>();

      final marked = activity.mentions.doneAll(activity.mentions.waiting);
      await pumpEventQueue();
      expect(server.posts.length - before, 2);

      hold.complete();
      expect(await marked, 5);
      expect(server.posts.length - before, 5);
    });

    test('mark read moves the thread mark to its newest reply', () async {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      final activity = await load(server);
      final attention = activity.attention;
      final thread = attention.unread.single;
      expect(attention.isNew(thread), isTrue);

      attention.markRead(thread);

      expect(
        activity.controller.threadReadMark(thread.rootId),
        thread.lastReplySequence,
      );
      expect(attention.isNew(thread), isFalse);
    });
  });

  group('leaving', () {
    test(
      'marks nothing read: the visit showed no reply or reaction row',
      () async {
        final server = swarm();
        server.state['activityDigest'] = 'd1';
        server.followedThreads = {
          'unread': [unreadThread('message-1')],
          'read': [],
          'more': false,
        };
        final activity = await load(server);
        activity.opened();
        await pumpEventQueue();
        activity.closed();
        await pumpEventQueue();
        expect(server.activityReadPosts, isEmpty);
        expect(server.activityReads, isEmpty);
      },
    );
  });
}
