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

/// The task in `offline` waiting on its requester, the default reader.
void wait(ConversationServer server, {String requester = 'owner'}) {
  _group(server, 'offline')['requesterId'] = requester;
  _group(server, 'offline')['assignment'] = {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': 'needs_human',
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
    test('lists the decisions asked of the reader, the agents waiting on them '
        'and their tags, in that order, and counts each', () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it?']);
      wait(server);
      server.tag('message-1');
      final activity = await load(server);
      expect(
        [for (final n in activity.needsYou) n.kind],
        [
          SuperTabNeedKind.decision,
          SuperTabNeedKind.agent,
          SuperTabNeedKind.mention,
        ],
      );
      expect(
        [for (final n in activity.needsYou) n.title],
        [
          'Ship it?',
          'Kestrel is waiting on you',
          'Wren mentioned you in # web-project',
        ],
      );
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

    test('a task waiting on nobody named is for its requester alone', () async {
      final server = twoPeople();
      wait(server, requester: 'peer');
      final other = await load(server);
      expect(other.needsYou, isEmpty);
      expect(other.count, 0);
      expect(other.unread, isFalse);
      final requester = await load(server, account: 'peer');
      expect(
        [for (final n in requester.needsYou) n.kind],
        [SuperTabNeedKind.agent],
      );
      expect(requester.count, 1);
    });

    test('a task asked of one person is for that person alone', () async {
      final server = twoPeople();
      wait(server, requester: 'owner');
      _group(server, 'offline')['assignment']['askedOf'] = 'peer';
      expect((await load(server)).count, 0);
      expect((await load(server, account: 'peer')).count, 1);
    });

    test(
      'a tag in a thread the reader does not follow is still Needs you',
      () async {
        final server = swarm();
        server.tag('message-2', threadId: 'message-1', messageSequence: 2);
        server.followedThreads = {'unread': [], 'read': [], 'more': false};
        final activity = await load(server);
        expect(
          [for (final n in activity.needsYou) n.kind],
          [SuperTabNeedKind.mention],
        );
        expect(activity.count, 1);
        expect(activity.newReplies, isEmpty);
      },
    );
  });

  group('the number', () {
    test('counts only Needs you: new replies, done work and replies to the '
        'reader add nothing', () async {
      final server = swarm();
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
        expect(activity.count, 1);
        expect(activity.newReplies, hasLength(1));
        expect(activity.doneToday, hasLength(1));
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

    test(
      'a tag counts until its chat is read past it, then it leaves Needs you',
      () async {
        final server = swarm()..followedThreads = null;
        server.tag('message-1', messageSequence: 5);
        server.state['readMarks'] = {
          'owner': {'lead': 4},
        };
        final activity = await load(server);
        expect(activity.count, 1);
        expect(
          [for (final n in activity.needsYou) n.kind],
          [SuperTabNeedKind.mention],
        );
        server.state['readMarks'] = {
          'owner': {'lead': 5},
        };
        await reload(activity, server);
        expect(activity.count, 0);
        expect(activity.needsYou, isEmpty);
      },
    );

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

    test(
      'a tag in a thread-only reply is Needs you and a new reply',
      () async {
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
        expect(activity.needsYou, hasLength(1));
        expect(activity.needsYou.single.kind, SuperTabNeedKind.mention);
        expect(activity.needsYou.single.conversationId, 'offline');
        expect(activity.count, 1);
        expect(activity.newReplies.map((t) => t.rootId), ['message-1']);
      },
    );
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

  group('Done today', () {
    test(
      'lists what shipped today, newest first, not yesterday, not a step',
      () async {
        final server = swarm()..followedThreads = null;
        finish(server, DateTime(2026, 11, 2, 8, 8));
        (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          {
            ...conversationFixture('later', 'Commits read Harness'),
            'projectId': 'lead',
            'assignment': {'id': 'a2', 'agentId': 'kestrel', 'status': 'done'},
            'shippedAt': DateTime(2026, 11, 2, 8, 28).millisecondsSinceEpoch,
          },
          {
            ...conversationFixture('yesterday', 'Shipped yesterday'),
            'projectId': 'lead',
            'assignment': {'id': 'a3', 'agentId': 'kestrel', 'status': 'done'},
            'shippedAt': DateTime(2026, 11, 1, 23, 50).millisecondsSinceEpoch,
          },
          {
            ...conversationFixture('review', 'Review: Windows credential fix'),
            'projectId': 'lead',
            'reviewOf': 'offline',
            'assignment': {'id': 'a4', 'agentId': 'kestrel', 'status': 'done'},
            'shippedAt': DateTime(2026, 11, 2, 9).millisecondsSinceEpoch,
          },
        ]);
        await withClock(Clock.fixed(_evening), () async {
          final activity = await load(server);
          expect(
            [for (final g in activity.doneToday) g.title],
            ['Commits read Harness', 'Windows credential fix'],
          );
        });
      },
    );

    test(
      'is empty from a server that does not say when work shipped',
      () async {
        final server = swarm()..followedThreads = null;
        _group(server, 'offline')['assignment'] = {
          'id': 'a1',
          'agentId': 'kestrel',
          'status': 'done',
        };
        await withClock(Clock.fixed(_evening), () async {
          expect((await load(server)).doneToday, isEmpty);
        });
      },
    );
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
