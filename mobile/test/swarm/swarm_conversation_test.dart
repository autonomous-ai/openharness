import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// One conversation on the phone: its messages (latest page first, older on
/// demand, new ones as the Swarm says they arrived), and what the person
/// posts to it (backend message.send, section 4.6 of the parts design).
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'hello',
    String authorId = 'agent-builder',
    bool fromAgent = true,
    String conversationId = 'g1',
  }) => {
    'id': id,
    'conversationId': conversationId,
    'text': text,
    'sequence': sequence,
    'author': {
      'kind': fromAgent ? 'agent' : 'person',
      'id': authorId,
      'name': fromAgent ? 'Builder' : 'me',
    },
    'createdAt': '2026-10-27T01:00:00.000Z',
  };

  /// A Swarm with conversation g1 at [sequence], and [rest] of its groups.
  ({FakeSwarm swarm, SwarmReader reader}) rig({
    int sequence = 2,
    List<String> agentIds = const ['agent-lead', 'agent-builder'],
    String role = 'owner',
    bool archived = false,
  }) {
    final swarm = FakeSwarm();
    Map<String, dynamic> g1(int seq) => {
      ...groupData(
        'g1',
        title: 'Fix login',
        agentIds: agentIds,
        lastMessageSequence: seq,
      ),
      'archived': archived,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(groups: [g1(sequence)]),
      'members': [part(me, 1, person(me, role: role))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    addTearDown(reader.dispose);
    return (swarm: swarm, reader: reader);
  }

  Future<SwarmConversation> open(SwarmReader reader) async {
    await reader.refresh();
    final conversation = SwarmConversation(reader, 'g1');
    addTearDown(conversation.dispose);
    await conversation.load();
    return conversation;
  }

  test('opening reads the latest page, oldest first', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m2', 2), message('m1', 1)],
      'next': {'sequence': 1, 'id': 'm1'},
    };

    final c = await open(r.reader);

    expect([for (final m in c.messages) m.id], ['m1', 'm2']);
    expect(c.hasOlder, isTrue);
    expect(r.swarm.paths.last, messages);
  });

  test(
    'older messages are read before the oldest shown, until there are none',
    () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m5', 5)],
        'next': {'sequence': 5, 'id': 'm5'},
      };
      r.swarm.routes['$messages?before=5&beforeId=m5'] = (_) => {
        'messages': [message('m3', 3), message('m4', 4)],
        'next': null,
      };
      final c = await open(r.reader);

      await c.loadOlder();

      expect([for (final m in c.messages) m.id], ['m3', 'm4', 'm5']);
      expect(c.hasOlder, isFalse);
    },
  );

  test(
    'new messages are read when the Swarm says the conversation moved',
    () async {
      final r = rig(sequence: 2);
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2)],
        'next': null,
      };
      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message('m3', 3, text: 'done')],
        'next': null,
      };
      final c = await open(r.reader);

      // A change that leaves the conversation where it was reads no messages.
      await r.reader.refresh();
      await settle();
      expect(r.swarm.paths.where((p) => p.contains('after=')), isEmpty);

      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            'g1',
            30,
            groupData(
              'g1',
              title: 'Fix login',
              agentIds: ['agent-lead', 'agent-builder'],
              lastMessageSequence: 3,
            ),
          ),
        ],
      );
      await r.reader.refresh();
      await settle();

      expect([for (final m in c.messages) m.text], ['hello', 'done']);
    },
  );

  test(
    'a post goes to the agents mentioned in it, and clears the draft',
    () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
      r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': {'messageId': 'm9'},
      };
      final c = await open(r.reader);

      c.draft = 'Please check ';
      c.mention('agent-builder');
      expect(c.draft, 'Please check @Nova ');
      c.draft = '${c.draft}the build';
      expect(await c.send(), isTrue);

      final sent = r.swarm.calls.singleWhere((call) => call.method == 'POST');
      expect(sent.body!['operationId'], isA<String>());
      expect(sent.body!['command'], {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': 'Please check @Nova the build',
        'replyTo': null,
        'recipientIds': ['agent-builder'],
      });
      expect(c.draft, isEmpty);
    },
  );

  test('a mention taken out of the text addresses nobody', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    final c = await open(r.reader);

    c.mention('agent-builder');
    c.draft = 'never mind';
    await c.send();

    expect(r.swarm.commands.single['recipientIds'], isEmpty);
  });

  test('a refused post keeps the draft and says why', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
        throw const SuperTabFailure(
          'READ_ONLY',
          'This conversation is read only.',
          statusCode: 403,
        );
    final c = await open(r.reader);

    c.draft = 'hi';
    expect(await c.send(), isFalse);

    expect(c.draft, 'hi');
    expect(c.error, 'This conversation is read only.');
    expect(c.unconfirmed, isFalse, reason: 'refused means nothing was done');
  });

  test('a post whose answer was lost is retried as the same post', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    var lost = true;
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => lost
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : {'result': <String, dynamic>{}};
    final c = await open(r.reader);

    c.draft = 'hi';
    expect(await c.send(), isFalse);
    expect(c.unconfirmed, isTrue);

    lost = false;
    expect(await c.send(), isTrue);

    final posts = [
      for (final call in r.swarm.calls)
        if (call.method == 'POST') call.body!['operationId'],
    ];
    expect(posts, hasLength(2));
    expect(posts.toSet(), hasLength(1), reason: 'the backend runs it once');
  });

  test('a reply carries the message it answers, and the reply goes once it '
      'is sent', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m1', 1, text: 'Ship it?')],
      'next': null,
    };
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    final c = await open(r.reader);

    c.replyingTo = c.messages.single;
    c.draft = 'Yes';
    expect(await c.send(), isTrue);

    expect(r.swarm.commands.single['replyTo'], 'm1');
    expect(c.replyingTo, isNull);
  });

  test('a post shows at once as sending, out of the draft, until it is read '
      'back', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    final taken = Completer<Object?>();
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => taken.future;
    final c = await open(r.reader);

    c.draft = 'On my way';
    final sent = c.send();
    await settle();

    expect(c.draft, isEmpty, reason: 'the field is free at once');
    expect(c.pending?.text, 'On my way');
    expect(c.sending, isTrue);

    r.swarm.routes[messages] = (_) => {
      'messages': [
        message('m9', 3, text: 'On my way', authorId: me, fromAgent: false),
      ],
      'next': null,
    };
    taken.complete({'result': <String, dynamic>{}});
    expect(await sent, isTrue);

    expect(c.pending, isNull);
    expect([for (final m in c.messages) m.text], ['On my way']);
  });

  test('a post whose answer was lost stays at the foot, not confirmed, and '
      'out of the draft', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
        throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
    final c = await open(r.reader);

    c.draft = 'hi';
    expect(await c.send(), isFalse);

    expect(c.pending?.text, 'hi');
    expect(c.sending, isFalse);
    expect(c.unconfirmed, isTrue);
    expect(c.draft, isEmpty);
  });

  test('a refused post puts its text back in the draft, with its mention and '
      'its reply', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m1', 1, text: 'Ship it?')],
      'next': null,
    };
    var refuse = true;
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => refuse
        ? throw const SuperTabFailure(
            'TOO_LONG',
            'This message is too long.',
            statusCode: 400,
          )
        : {'result': <String, dynamic>{}};
    final c = await open(r.reader);
    c.replyingTo = c.messages.single;
    c.mention('agent-builder');
    c.draft = '${c.draft}please';

    expect(await c.send(), isFalse);

    expect(c.pending, isNull);
    expect(c.draft, '@Nova please');
    expect(c.replyingTo?.id, 'm1');
    expect(c.error, 'This message is too long.');

    refuse = false;
    expect(await c.send(), isTrue);
    expect(r.swarm.commands.last['recipientIds'], ['agent-builder']);
    expect(r.swarm.commands.last['replyTo'], 'm1');
  });

  test('the mention picker reads the name typed after an @ at the end', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    final c = await open(r.reader);

    c.draft = 'hey';
    expect(c.mentionQuery, isNull);
    c.draft = 'hey @';
    expect(c.mentionQuery, '');
    c.draft = '@No';
    expect(c.mentionQuery, 'No');
    c.draft = 'mail me@home';
    expect(c.mentionQuery, isNull, reason: 'an @ inside a word is not one');
    c.draft = 'hey @No then';
    expect(c.mentionQuery, isNull);
  });

  test('a name picked for the @ being typed takes its place, and the post '
      'goes to that agent', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    final c = await open(r.reader);

    c.draft = 'Can you check @No';
    c.completeMention('agent-builder');
    expect(c.draft, 'Can you check @Nova ');
    expect(c.mentionQuery, isNull);

    c.draft = '${c.draft}this';
    await c.send();
    expect(r.swarm.commands.single['recipientIds'], ['agent-builder']);
  });

  test('a viewer, or an archived conversation, cannot post', () async {
    final viewer = rig(role: 'viewer');
    viewer.swarm.routes[messages] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    final c = await open(viewer.reader);
    c.draft = 'hi';
    expect(c.canPost, isFalse);
    expect(await c.send(), isFalse);

    final archived = rig(archived: true);
    archived.swarm.routes[messages] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    final a = await open(archived.reader);
    expect(a.canPost, isFalse);
  });

  test(
    'messages of a conversation the person can no longer read are dropped',
    () async {
      final r = rig();
      var allowed = true;
      r.swarm.routes[messages] = (_) => allowed
          ? {
              'messages': [message('m1', 1)],
              'next': null,
            }
          : throw const SuperTabFailure(
              'FORBIDDEN',
              'Not yours.',
              statusCode: 403,
            );
      final c = await open(r.reader);
      expect(c.messages, hasLength(1));

      allowed = false;
      await c.load();

      expect(c.messages, isEmpty);
    },
  );

  group('a chat a full read leaves out', () {
    /// g1 as the first load lists it while [listed]; a change read answers
    /// with a reload, as when the person's access moved.
    ({FakeSwarm swarm, SwarmReader reader, void Function() leaveOut})
    reloadRig() {
      final r = rig();
      var listed = true;
      r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            if (listed)
              groupData(
                'g1',
                title: 'Fix login',
                agentIds: ['agent-lead', 'agent-builder'],
                audience: [me, 'person-other'],
                lastMessageSequence: 1,
              ),
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m1', 1, text: 'private plan')],
        'next': null,
      };
      return (
        swarm: r.swarm,
        reader: r.reader,
        leaveOut: () {
          listed = false;
          r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
            'reload': true,
          };
        },
      );
    }

    test('and the person can no longer read loses its messages, draft and '
        'unconfirmed post, and a late answer brings none back', () async {
      final r = reloadRig();
      r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final c = await open(r.reader);
      expect(c.messages.single.text, 'private plan');
      c.draft = 'my reply';
      await c.send();
      expect(c.unconfirmed, isTrue);
      final late = Completer<Object?>();
      r.swarm.routes['$messages?after=1'] = (_) => late.future;
      final reading = c.load();

      r.leaveOut();
      await r.reader.refresh();
      await settle();

      expect(c.conversation, isNull);
      expect(
        r.swarm.paths,
        contains('/api/super-tabs/$tab/groups/g1'),
        reason: 'a closed chat is left out too, so it is asked by id',
      );
      expect(c.messages, isEmpty);
      expect(c.draft, isEmpty);
      expect(c.unconfirmed, isFalse);

      late.complete({
        'messages': [message('m2', 2, text: 'more of the plan')],
        'next': null,
      });
      await reading;
      await settle();
      expect(c.messages, isEmpty);
    });

    test(
      'but can still read, as a closed one, keeps its draft and messages',
      () async {
        final r = reloadRig();
        r.swarm.routes['/api/super-tabs/$tab/groups/g1'] = (_) => {
          'group': part(
            'g1',
            9,
            groupData(
              'g1',
              title: 'Fix login',
              audience: [me, 'person-other'],
              lastMessageSequence: 1,
              dormant: true,
            ),
          ),
        };
        final c = await open(r.reader);
        c.draft = 'my reply';

        r.leaveOut();
        await r.reader.refresh();
        await settle();

        expect(c.conversation?.closed, isTrue);
        expect(c.messages.single.text, 'private plan');
        expect(c.draft, 'my reply');
      },
    );
  });

  group('Chat with PM', () {
    test(
      "is the project's conversation whose audience is the person alone",
      () async {
        final r = rig();
        r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
          groups: [
            groupData('shared', title: 'Team'),
            groupData('mine', title: 'me', audience: [me]),
            groupData('both', title: 'Pair', audience: [me, 'person-other']),
          ],
        );
        await r.reader.refresh();

        expect(swarmPmChat(r.reader, project)?.id, 'mine');
      },
    );

    test('opening it the first time creates it, once per membership', () async {
      final r = rig();
      var created = false;
      r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) {
        created = true;
        return {
          'result': {'conversationId': 'pm-1'},
        };
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c2',
        groups: created
            ? [
                part('pm-1', 40, groupData('pm-1', title: me, audience: [me])),
              ]
            : const [],
      );
      await r.reader.refresh();

      expect(await openSwarmPmChat(r.reader, project), 'pm-1');

      final sent = r.swarm.calls.singleWhere((call) => call.method == 'POST');
      expect(sent.body!['operationId'], 'pm-chat-$project-$me-gen-$me');
      expect(sent.body!['command'], {
        'type': 'conversation.create',
        'projectId': project,
        'title': me,
        'brief': '',
        'checks': <Object>[],
        'audience': {
          'personIds': [me],
        },
      });
      expect(swarmPmChat(r.reader, project)?.id, 'pm-1');
    });
  });
}
