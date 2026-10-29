import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
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

  // The chat page redraws on what its conversation says: a read that brings
  // nothing, or a letter typed, is not news for its messages.
  test('a read that brings nothing new tells no one', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m2', 2), message('m1', 1)],
      'next': {'sequence': 1, 'id': 'm1'},
    };
    final c = await open(r.reader);
    final shown = c.messages;
    var told = 0;
    c.addListener(() => told++);

    await c.load();

    expect(told, 0);
    expect(c.messages, same(shown));
    expect(c.hasOlder, isTrue);
  });

  test('a draft typed is told to the composer, not to the messages', () async {
    final r = rig();
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m1', 1)],
      'next': null,
    };
    final c = await open(r.reader);
    var told = 0;
    c.addListener(() => told++);

    c.draft = 'Hel';
    c.draft = 'Hello';

    expect(told, 0);
    expect(c.draft, 'Hello');
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

  test(
    'the mention picker reads the name typed after an @ at the end',
    () async {
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
    },
  );

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

  group('where it stands', () {
    const lookup = '/api/super-tabs/$tab/groups/g-old';
    const old = '/api/super-tabs/$tab/conversations/g-old/messages';

    test('loading, then loaded', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      expect(c.state, SwarmChatState.loading);

      await c.load();

      expect(c.state, SwarmChatState.loaded);
    });

    test('a chat no full read has is looked for, its messages read '
        'meanwhile', () async {
      final r = rig();
      final found = Completer<Object?>(), page = Completer<Object?>();
      r.swarm.routes[lookup] = (_) => found.future;
      r.swarm.routes[old] = (_) => page.future;
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g-old');
      addTearDown(c.dispose);

      final loading = c.load();
      await settle();

      expect(c.state, SwarmChatState.locating);
      expect(r.swarm.paths, containsAll([lookup, old]));

      page.complete({
        'messages': [
          message('m1', 1, text: 'old plan', conversationId: 'g-old'),
        ],
        'next': null,
      });
      found.complete({
        'group': part(
          'g-old',
          9,
          groupData(
            'g-old',
            title: 'Old work',
            lastMessageSequence: 1,
            dormant: true,
          ),
        ),
      });
      await loading;
      await settle();

      expect(c.conversation?.closed, isTrue);
      expect(c.messages.single.text, 'old plan');
      expect(c.state, SwarmChatState.loaded);
    });

    test('not open to the person only once the lookup refuses it', () async {
      final r = rig();
      final found = Completer<Object?>();
      r.swarm.routes[lookup] = (_) => found.future;
      r.swarm.routes[old] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g-old');
      addTearDown(c.dispose);
      var told = 0;
      c.addListener(() => told++);

      final loading = c.load();
      await settle();
      expect(c.state, isNot(SwarmChatState.lost));

      found.completeError(
        const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403),
      );
      await loading;
      await settle();

      expect(c.state, SwarmChatState.lost);
      expect(told, greaterThan(0), reason: 'the page is told');
    });
  });

  test('reading back to a quoted message tells the chat once, not at each '
      'page', () async {
    final r = rig(sequence: 30);
    r.swarm.routes[messages] = (_) => {
      'messages': [message('m30', 30)],
      'next': {'sequence': 30, 'id': 'm30'},
    };
    for (var top = 30; top > 26; top--) {
      r.swarm.routes['$messages?before=$top&beforeId=m$top'] = (_) => {
        'messages': [message('m${top - 1}', top - 1)],
        'next': {'sequence': top - 1, 'id': 'm${top - 1}'},
      };
    }
    final c = await open(r.reader);
    var told = 0;
    c.addListener(() => told++);

    expect(await c.readBackTo('m27'), isTrue);

    expect(told, 1);
    expect([for (final m in c.messages) m.id], ['m27', 'm28', 'm29', 'm30']);
    expect(r.swarm.paths.where((p) => p.contains('?before=')), hasLength(3));

    told = 0;
    expect(await c.readBackTo('m1', pages: 1), isFalse);
    expect(told, 1);
    expect(c.hasOlder, isTrue);
  });

  group('opened again', () {
    /// g1 read once and closed.
    Future<void> readAndClose(SwarmReader reader) async {
      await reader.refresh();
      final first = SwarmConversation(reader, 'g1');
      await first.load();
      first.dispose();
    }

    test(
      'shows at once what was read, and reads only what came after',
      () async {
        final r = rig();
        r.swarm.routes[messages] = (_) => {
          'messages': [message('m2', 2), message('m1', 1)],
          'next': {'sequence': 1, 'id': 'm1'},
        };
        await readAndClose(r.reader);

        final c = SwarmConversation(r.reader, 'g1');
        addTearDown(c.dispose);

        expect([for (final m in c.messages) m.id], ['m1', 'm2']);
        expect(c.hasOlder, isTrue);
        expect(c.state, SwarmChatState.loaded);
        r.swarm.routes['$messages?after=2'] = (_) => {
          'messages': [message('m3', 3)],
          'next': null,
        };
        await c.load();
        expect(r.swarm.paths.last, '$messages?after=2');
        expect([for (final m in c.messages) m.id], ['m1', 'm2', 'm3']);
      },
    );

    test('more than a page newer reads the latest page instead', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
      };
      await readAndClose(r.reader);
      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [for (var i = 3; i < 103; i++) message('m$i', i)],
        'next': {'sequence': 102, 'id': 'm102'},
      };
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m300', 300), message('m299', 299)],
        'next': {'sequence': 299, 'id': 'm299'},
      };

      final c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      await c.load();

      expect(r.swarm.paths.last, messages);
      expect([for (final m in c.messages) m.id], ['m299', 'm300']);
      expect(c.hasOlder, isTrue);
    });
  });

  // Desktop's reactions (backend reactions.ts): the person's own emoji counts
  // at once, the backend confirms it, and a change made anywhere reads the
  // page shown again so the counts match Desktop.
  group('reactions', () {
    const commands = '/api/super-tabs/$tab/commands';

    Map<String, dynamic> reacted(
      Map<String, dynamic> row,
      Map<String, List<(String, String)>> by,
    ) => {
      ...row,
      'reactions': [
        for (final MapEntry(key: emoji, value: who) in by.entries)
          {
            'emoji': emoji,
            'count': who.length,
            'by': [
              for (final (kind, id) in who) {'kind': kind, 'id': id},
            ],
          },
      ],
    };

    /// g1 at [sequence] with its reaction counter at [reactionSeq], as a
    /// change read brings it.
    Map<String, dynamic> moved(int version, int reactionSeq) => changes(
      cursor: 'c$version',
      groups: [
        part('g1', version, {
          ...groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            lastMessageSequence: 2,
          ),
          'reactionSeq': reactionSeq,
        }),
      ],
    );

    String counts(SwarmConversation c, String id) => [
      for (final r in c.reactionsOf(c.messages.firstWhere((m) => m.id == id)))
        '${r.emoji.key}:${[for (final who in r.by) who.id].join('+')}',
    ].join(' ');

    test('reacting counts the emoji at once, sends it, and reads the page '
        'shown back', () async {
      final r = rig();
      var page = [message('m2', 2), message('m1', 1)];
      r.swarm.routes[messages] = (_) => {
        'messages': page,
        'next': null,
        'reactionSeq': 0,
      };
      final sent = Completer<Object?>();
      r.swarm.routes[commands] = (_) => sent.future;
      final c = await open(r.reader);

      final reacting = c.react(c.messages.first, SuperTabReactionEmoji.tada);

      expect(counts(c, 'm1'), 'tada:$me');
      expect(r.swarm.commands.single, {
        'type': 'message.react',
        'conversationId': 'g1',
        'messageId': 'm1',
        'emoji': 'tada',
        'on': true,
      });
      page = [
        message('m2', 2),
        reacted(message('m1', 1), {
          'tada': [('agent', 'agent-lead'), ('person', me)],
        }),
      ];
      r.swarm.routes['$messages?before=3'] = (_) => {
        'messages': page,
        'next': null,
        'reactionSeq': 2,
      };
      sent.complete({'result': <String, dynamic>{}});

      expect(await reacting, isTrue);
      expect(counts(c, 'm1'), 'tada:agent-lead+$me');
      expect(c.messages.first.reactions.single.count, 2);
    });

    test('reacting with your own emoji again takes it back', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [
          reacted(message('m1', 1), {
            'heart': [('person', me), ('agent', 'agent-lead')],
          }),
        ],
        'next': null,
        'reactionSeq': 4,
      };
      final sent = Completer<Object?>();
      r.swarm.routes[commands] = (_) => sent.future;
      final c = await open(r.reader);

      final reacting = c.react(c.messages.single, SuperTabReactionEmoji.heart);

      expect(counts(c, 'm1'), 'heart:agent-lead');
      expect(r.swarm.commands.single['on'], isFalse);
      sent.complete({'result': <String, dynamic>{}});
      await reacting;
    });

    test('a refused reaction goes back and says why', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
        'reactionSeq': 0,
      };
      r.swarm.routes[commands] = (_) => throw SuperTabFailure(
        'NOT_FOUND',
        'This message is unavailable.',
        statusCode: 404,
      );
      final c = await open(r.reader);
      var told = 0;
      c.addListener(() => told++);

      expect(
        await c.react(c.messages.single, SuperTabReactionEmoji.eyes),
        isFalse,
      );

      expect(counts(c, 'm1'), '');
      expect(c.error, 'This message is unavailable.');
      expect(told, greaterThan(0));
    });

    test('a person who cannot post cannot react', () async {
      final r = rig(role: 'viewer');
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final c = await open(r.reader);

      expect(
        await c.react(c.messages.single, SuperTabReactionEmoji.eyes),
        isFalse,
      );
      expect(r.swarm.commands, isEmpty);
    });

    test('a reaction made elsewhere reads the page shown again; a Swarm read '
        'that moved no counter reads nothing', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
        'reactionSeq': 0,
      };
      final c = await open(r.reader);
      await r.reader.refresh();
      await settle();
      expect(r.swarm.paths.where((p) => p.contains('before=')), isEmpty);

      r.swarm.routes['$messages?before=3'] = (_) => {
        'messages': [
          message('m2', 2),
          reacted(message('m1', 1), {
            'rocket': [('person', 'person-ann')],
          }),
        ],
        'next': null,
        'reactionSeq': 1,
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => moved(30, 1);
      await r.reader.refresh();
      await settle();

      expect(counts(c, 'm1'), 'rocket:person-ann');
      await r.reader.refresh();
      await settle();
      expect(
        r.swarm.paths.where((p) => p.contains('before=')),
        hasLength(1),
        reason: 'the counter it read is the one the Swarm says',
      );
    });

    test('new messages that come with a moved counter read the page shown '
        'again too', () async {
      final r = rig(sequence: 2);
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
        'reactionSeq': 0,
      };
      final c = await open(r.reader);
      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message('m3', 3)],
        'next': null,
        'reactionSeq': 1,
      };
      r.swarm.routes['$messages?before=4'] = (_) => {
        'messages': [
          message('m3', 3),
          reacted(message('m2', 2), {
            'laugh': [('agent', 'agent-lead')],
          }),
          message('m1', 1),
        ],
        'next': null,
        'reactionSeq': 1,
      };

      await c.load();

      expect([for (final m in c.messages) m.id], ['m1', 'm2', 'm3']);
      expect(counts(c, 'm2'), 'laugh:agent-lead');
    });

    test('a chat opened again reads its page again only when a reaction '
        'changed while it was closed', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
        'reactionSeq': 3,
      };
      await r.reader.refresh();
      var c = SwarmConversation(r.reader, 'g1');
      await c.load();
      c.dispose();

      // Opened again with nothing changed: what was kept, and new messages
      // only.
      c = SwarmConversation(r.reader, 'g1');
      await c.load();
      await settle();
      expect(r.swarm.paths.where((p) => p.contains('before=')), isEmpty);
      c.dispose();

      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': <Object>[],
        'next': null,
        'reactionSeq': 5,
      };
      r.swarm.routes['$messages?before=3'] = (_) => {
        'messages': [
          message('m2', 2),
          reacted(message('m1', 1), {
            'thumbs_up': [('person', 'person-ann')],
          }),
        ],
        'next': null,
        'reactionSeq': 5,
      };
      c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      await c.load();
      await settle();

      expect(counts(c, 'm1'), 'thumbs_up:person-ann');
    });
  });

  group('read marks', () {
    const read = '/api/super-tabs/$tab/conversations/g1/read';

    /// [r]'s Swarm with read marks the inbox would give it, and the marks it
    /// sends.
    ({SwarmReadMarks marks, List<Object?> sent}) marked(
      ({FakeSwarm swarm, SwarmReader reader}) r,
    ) {
      final marks = SwarmReadMarks(r.reader, store: null);
      r.reader.readMarks = marks;
      addTearDown(marks.dispose);
      final sent = <Object?>[];
      r.swarm.routes[read] = (body) {
        sent.add(body!['sequence']);
        return {'sequence': body['sequence']};
      };
      return (marks: marks, sent: sent);
    }

    /// A change read in which g1 moved on to [sequence].
    void moveOn(FakeSwarm swarm, int sequence) =>
        swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
          cursor: 'c3',
          groups: [
            part(
              'g1',
              9 + sequence,
              groupData(
                'g1',
                title: 'Fix login',
                agentIds: const ['agent-lead', 'agent-builder'],
                lastMessageSequence: sequence,
              ),
            ),
          ],
        );

    test('an open chat is read through its newest message, and again as '
        'new ones come', () async {
      final r = rig();
      final m = marked(r);
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
      };

      await open(r.reader);
      await settle();
      expect(m.sent, [2]);

      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message('m3', 3)],
        'next': null,
      };
      moveOn(r.swarm, 3);
      await r.reader.refresh();
      await settle();

      expect(m.sent, [2, 3]);
      expect(m.marks.unread(r.reader.snapshot!.conversation('g1')!), isFalse);
    });

    test('a covered chat is not read until it shows again', () async {
      final r = rig();
      final m = marked(r);
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
      };
      final c = await open(r.reader);
      await settle();

      c.shown = false;
      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message('m3', 3)],
        'next': null,
      };
      moveOn(r.swarm, 3);
      await r.reader.refresh();
      await settle();
      expect(c.messages.last.id, 'm3');
      expect(m.sent, [2]);
      expect(m.marks.unread(r.reader.snapshot!.conversation('g1')!), isTrue);

      c.shown = true;
      await settle();

      expect(m.sent, [2, 3]);
      expect(m.marks.unread(r.reader.snapshot!.conversation('g1')!), isFalse);
    });

    test('a chat read before, opened again covered or at an earlier '
        'message, marks nothing past what is seen of what it kept', () async {
      final r = rig();
      final m = marked(r);
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m2', 2), message('m1', 1)],
        'next': null,
      };
      await r.reader.refresh();
      // Read while covered: kept, and not read.
      var c = SwarmConversation(r.reader, 'g1', shown: false);
      await c.load();
      c.dispose();
      await settle();
      expect(m.sent, isEmpty);

      c = SwarmConversation(r.reader, 'g1', shown: false);
      c.dispose();
      await settle();
      expect(m.sent, isEmpty, reason: 'covered from the start');

      c = SwarmConversation(r.reader, 'g1', heldAt: 'm1');
      addTearDown(c.dispose);
      await settle();
      expect(m.sent, [1], reason: 'only through the message it opened at');
    });

    test('a Swarm without read marks marks nothing', () async {
      final r = rig();
      r.swarm.routes[messages] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };

      await open(r.reader);
      await settle();

      expect(r.swarm.paths.where((p) => p.endsWith('/read')), isEmpty);
    });
  });
}
