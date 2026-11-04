import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_outbox.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_thread.dart';

import 'swarm_fixture.dart';

/// One thread of a chat on the phone (the desktop's thread panel): read
/// through the chat's own path, replies that arrive later with the chat's
/// reads, and a reply that goes to its root, to the chat too with Also send.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const thread = '$messages?thread=m1';
  const commands = '/api/super-tabs/$tab/commands';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String? root,
    bool also = false,
    String conversationId = 'g1',
  }) => {
    'id': id,
    'conversationId': conversationId,
    'text': 'text of $id',
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Builder'},
    'createdAt': '2026-10-27T01:00:00.000Z',
    'thread': root ?? id,
    if (also) 'alsoInChat': true,
  };

  Map<String, dynamic> line(String root, int replies, int last) => {
    'id': root,
    'replies': replies,
    'lastSequence': last,
    'lastAt': '2026-10-27T01:05:00.000Z',
    'authors': [
      {'kind': 'agent', 'id': 'agent-builder', 'name': 'Builder'},
    ],
    'people': [me],
  };

  /// A Swarm with conversation g1 at [sequence] while [listed] says so, its
  /// chat read with [chatRows]: root m1 and its first reply unless told.
  /// Files go up to [uploads]; [others] are members besides the person.
  Future<({FakeSwarm swarm, SwarmReader reader, SwarmConversation chat})> rig({
    int sequence = 2,
    String role = 'owner',
    int? number,
    List<Map<String, dynamic>>? chatRows,
    bool Function()? listed,
    FakeUploads? uploads,
    List<Map<String, dynamic>> others = const [],
  }) async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          if (listed?.call() ?? true)
            groupData(
              'g1',
              title: 'Fix login',
              number: number,
              agentIds: ['agent-lead', 'agent-builder'],
              lastMessageSequence: sequence,
            ),
        ],
      ),
      'members': [
        part(me, 1, person(me, role: role)),
        for (final other in others) part(other['id'] as String, 1, other),
      ],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes[messages] = (_) => {
      'messages': chatRows ?? [message('m1', 1), message('m2', 2, root: 'm1')],
      'next': null,
      'threads': [line('m1', 1, 2)],
    };
    final reader = uploads == null
        ? SwarmReader(tabId: tab, accountId: me, request: swarm.request)
        : SwarmReader(
            tabId: tab,
            accountId: me,
            request: swarm.request,
            upload: uploads.upload,
          );
    addTearDown(reader.dispose);
    await reader.refresh();
    final chat = SwarmConversation(reader, 'g1');
    addTearDown(chat.dispose);
    await chat.load();
    return (swarm: swarm, reader: reader, chat: chat);
  }

  /// Takes each reply as the backend does — written under its operation id —
  /// and has the chat's next read bring it back with m1 and m2.
  void readsBack(FakeSwarm swarm, {bool Function()? lost}) {
    final rows = [message('m1', 1), message('m2', 2, root: 'm1')];
    swarm.routes[commands] = (body) {
      if (lost?.call() ?? false) throw StateError('connection reset');
      final id = sentId(body!['operationId'] as String);
      rows.add(message(id, rows.length + 1, root: 'm1'));
      return {'ok': true};
    };
    swarm.routes[messages] = (_) => {
      'messages': rows.reversed.toList(),
      'next': null,
    };
  }

  SwarmThread open(SwarmConversation chat, [String root = 'm1']) {
    final t = SwarmThread(chat, root);
    addTearDown(t.dispose);
    return t;
  }

  group('read on every device (backend readMarks.ts thread marks)', () {
    List<Object?> threadWrites(FakeSwarm swarm) => [
      for (final call in swarm.calls)
        if (call.method == 'POST' && call.path.contains('/threads/'))
          (call.path, call.body?['sequence']),
    ];

    Future<({FakeSwarm swarm, SwarmReader reader, SwarmThread thread})>
    marked() async {
      final r = await rig();
      r.swarm.routes['/api/super-tabs/$tab/conversations/g1/threads/'] = (
        body,
      ) => {'sequence': body!['sequence']};
      final marks = SwarmReadMarks(r.reader, store: null);
      addTearDown(marks.dispose);
      r.reader.readMarks = marks;
      return (swarm: r.swarm, reader: r.reader, thread: open(r.chat));
    }

    test('a thread seen once its read is back marks it through its newest '
        'row, once', () async {
      final r = await marked();
      // Nothing of it read yet: nothing to mark.
      r.thread.markRead();
      await settle();
      expect(threadWrites(r.swarm), isEmpty);
      await r.thread.load();
      r.thread.markRead();
      r.thread.markRead();
      await settle();
      expect(threadWrites(r.swarm), [
        ('/api/super-tabs/$tab/conversations/g1/threads/m1/read', 2),
      ]);
      expect(r.reader.readMarks!.threadThrough('g1', 'm1'), 2);
    });

    test('once access is lost the thread marks nothing', () async {
      final r = await marked();
      await r.thread.load();
      r.reader.revoke();
      await settle();
      r.thread.markRead();
      await settle();
      expect(threadWrites(r.swarm), isEmpty);
    });
  });

  test('opening reads the thread through the chat\'s own path: its root, '
      'then its replies', () async {
    final r = await rig();
    r.swarm.routes[thread] = (_) => {
      'messages': [
        message('m1', 1),
        message('m2', 2, root: 'm1'),
        message('m3', 3, root: 'm1', also: true),
      ],
      'next': null,
      'threads': [line('m1', 2, 3)],
    };
    final t = open(r.chat);
    expect(t.state, SwarmChatState.loading);

    await t.load();

    expect(r.swarm.paths.last, thread);
    expect(t.state, SwarmChatState.loaded);
    expect(t.rootMessage?.id, 'm1');
    expect([for (final m in t.replies) m.id], ['m2', 'm3']);
    expect(t.count, 2, reason: 'as its line says');
    expect(r.chat.thread('m1')?.replies, 2, reason: 'the chat\'s line moved');
    expect(t.hasEarlier, isFalse);
  });

  test('a long thread reads five pages on opening, its root by itself, then '
      'earlier replies a page at a time', () async {
    // The chat holds only its newest message: the root is far back.
    final r = await rig(sequence: 200, chatRows: [message('m200', 200)]);
    r.swarm.routes[thread] = (_) => {
      'messages': [message('m100', 100, root: 'm1')],
      'next': {'sequence': 100, 'id': 'm100'},
      'threads': [line('m1', 99, 100)],
    };
    for (var top = 100; top > 90; top--) {
      r.swarm.routes['$thread&before=$top&beforeId=m$top'] = (_) => {
        'messages': [message('m${top - 1}', top - 1, root: 'm1')],
        'next': {'sequence': top - 1, 'id': 'm${top - 1}'},
      };
    }
    r.swarm.routes['$messages?messageId=m1'] = (_) => {
      'messages': [message('m1', 1)],
      'next': null,
    };
    final t = open(r.chat);

    await t.load();

    expect(
      r.swarm.paths.where((p) => p.startsWith(thread)),
      hasLength(SwarmThread.pagesOnOpen),
    );
    expect(
      [for (final m in t.replies) m.id],
      ['m96', 'm97', 'm98', 'm99', 'm100'],
    );
    expect(t.rootMessage?.id, 'm1');
    expect(t.hasEarlier, isTrue);
    expect(t.count, 99);

    await t.loadEarlier();

    expect(
      r.swarm.paths.where((p) => p.startsWith(thread)),
      hasLength(SwarmThread.pagesOnOpen + 1),
    );
    expect(t.replies.map((m) => m.id), contains('m95'));
    expect(t.readingEarlier, isFalse);
  });

  test('its root is not read by itself when the chat has it', () async {
    final r = await rig();
    r.swarm.routes[thread] = (_) => {
      'messages': [message('m2', 2, root: 'm1')],
      'next': null,
    };
    final t = open(r.chat);

    await t.load();

    expect(r.swarm.paths.where((p) => p.contains('messageId=')), isEmpty);
    expect(t.rootMessage?.id, 'm1');
  });

  test('replies that arrive later come with the chat\'s own reads', () async {
    final r = await rig();
    r.swarm.routes[thread] = (_) => {
      'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
      'next': null,
    };
    final t = open(r.chat);
    await t.load();
    var told = 0;
    t.addListener(() => told++);
    r.swarm.routes['$messages?after=2'] = (_) => {
      'messages': [message('m3', 3, root: 'm1')],
      'next': null,
      'threads': [line('m1', 2, 3)],
    };

    await r.chat.load();

    expect([for (final m in t.replies) m.id], ['m2', 'm3']);
    expect(t.count, 2);
    expect(told, greaterThan(0));
  });

  test('rows of another conversation or another thread in an answer are '
      'left out', () async {
    final r = await rig();
    r.swarm.routes[thread] = (_) => {
      'messages': [
        message('m1', 1),
        message('x1', 5, root: 'm1', conversationId: 'g-private'),
        message('x2', 6, root: 'm9'),
      ],
      'next': null,
    };
    final t = open(r.chat);

    await t.load();

    expect([for (final m in t.messages) m.id], ['m1', 'm2']);
  });

  test('a root from another chat finds nothing here, as one that is gone '
      'does', () async {
    final r = await rig();
    r.swarm.routes['$messages?thread=elsewhere'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    r.swarm.routes['$messages?messageId=elsewhere'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    final t = open(r.chat, 'elsewhere');

    await t.load();

    expect(t.state, SwarmChatState.loaded);
    expect(t.rootMessage, isNull);
    expect(t.messages, isEmpty);
  });

  group('a reply', () {
    test('goes to the root with no one named, and to the chat too only with '
        'Also send', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      readsBack(r.swarm);
      final t = open(r.chat);
      await t.load();

      t.draft = '  Looks good  ';
      expect(t.canSend, isTrue);
      expect(await t.send(), isTrue);
      t.draft = 'Shipping it';
      t.alsoSend = true;
      expect(await t.send(), isTrue);

      expect(r.swarm.commands, [
        {
          'type': 'message.send',
          'conversationId': 'g1',
          'text': 'Looks good',
          'replyTo': 'm1',
          'recipientIds': <String>[],
        },
        {
          'type': 'message.send',
          'conversationId': 'g1',
          'text': 'Shipping it',
          'replyTo': 'm1',
          'recipientIds': <String>[],
          'alsoSend': true,
        },
      ]);
      expect(t.draft, isEmpty);
      expect(t.alsoSend, isFalse, reason: 'each reply asks again');
      expect(t.outgoing, isEmpty);
      expect(r.chat.threadDraft('m1'), isEmpty);
    });

    test('shows as on its way until the chat\'s read brings it back', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final answer = Completer<Object?>();
      String? sent;
      r.swarm.routes[commands] = (body) {
        sent = body!['operationId'] as String;
        return answer.future;
      };
      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message(sentId(sent!), 3, root: 'm1')],
        'next': null,
      };
      final t = open(r.chat);
      await t.load();
      t.draft = 'On it';

      final sending = t.send();
      await settle();
      expect(t.outgoing.firstOrNull?.text, 'On it');
      expect(t.sending, isTrue);
      expect(t.draft, isEmpty);

      answer.complete({'ok': true});
      await sending;

      expect(t.outgoing, isEmpty);
      expect([for (final m in t.replies) m.id], ['m2', sentId(sent!)]);
    });

    test('taken by the backend and not read back yet, it shows as sent until '
        'a read brings it, and never holds the next reply', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final sent = <String>[];
      r.swarm.routes[commands] = (body) {
        sent.add(body!['operationId'] as String);
        return {'ok': true};
      };
      var reads = 0;
      r.swarm.routes['$messages?after=2'] = (_) => switch (reads++) {
        // The reads after the posts fail; the next one has not got them yet.
        0 || 1 => throw StateError('offline'),
        2 => {'messages': <Object>[], 'next': null},
        _ => {
          'messages': [message(sentId(sent.first), 3, root: 'm1')],
          'next': null,
        },
      };
      final t = open(r.chat);
      await t.load();
      t.draft = 'On it';

      expect(await t.send(), isTrue, reason: 'the backend took it');

      expect(t.outgoing.single.text, 'On it');
      expect(t.outgoing.single.state, SwarmPostState.confirmed);
      expect(t.unconfirmed, isFalse, reason: 'not to be sent again');
      t.draft = 'And another';
      expect(t.canSend, isTrue, reason: 'Send never waits on an echo');
      expect(await t.send(), isTrue);
      expect(r.swarm.commands, hasLength(2));
      expect(sent.toSet(), hasLength(2), reason: 'two posts, two receipts');
      expect([for (final p in t.outgoing) p.text], ['On it', 'And another']);

      await r.chat.load();
      expect(t.outgoing, hasLength(2));

      await r.chat.load();
      expect([for (final p in t.outgoing) p.text], ['And another']);
      expect([for (final m in t.replies) m.id], ['m2', sentId(sent.first)]);
    });

    test('refused goes back to the box, with Also send as it was', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      r.swarm.routes[commands] = (_) => throw const SuperTabFailure(
        'ARCHIVED',
        'This chat is archived.',
        statusCode: 409,
      );
      final t = open(r.chat);
      await t.load();
      t.draft = 'Too late';
      t.alsoSend = true;

      expect(await t.send(), isFalse);

      expect(t.draft, 'Too late');
      expect(t.alsoSend, isTrue);
      expect(t.outgoing, isEmpty);
      expect(t.error, 'This chat is archived.');
      expect(r.chat.threadDraft('m1'), 'Too late');
    });

    test('whose answer was lost is sent again as the same reply', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      var lost = true;
      readsBack(r.swarm, lost: () => lost);
      final t = open(r.chat);
      await t.load();
      t.draft = 'Once only';

      expect(await t.send(), isFalse);
      expect(t.unconfirmed, isTrue);
      expect(t.outgoing.firstOrNull?.text, 'Once only');
      expect(t.error, contains('not sent'));

      lost = false;
      expect(await t.send(), isTrue);

      final posts = [
        for (final call in r.swarm.calls)
          if (call.path == commands) call.body!['operationId'],
      ];
      expect(posts, hasLength(2));
      expect(posts.toSet(), hasLength(1));
      expect(t.outgoing, isEmpty);
    });

    test('a viewer cannot reply', () async {
      final r = await rig(role: 'viewer');
      final t = open(r.chat);
      t.draft = 'Hello';
      expect(t.canPost, isFalse);
      expect(t.canSend, isFalse);
      expect(await t.send(), isFalse);
      expect(r.swarm.commands, isEmpty);
    });
  });

  group('@ in a reply (Desktop thread panel `@`)', () {
    /// Thread m1 of g1 read, with Dee in the Swarm besides the person.
    Future<({FakeSwarm swarm, SwarmConversation chat, SwarmThread thread})>
    tagging() async {
      final r = await rig(others: [person('dee', role: 'collaborator')]);
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      readsBack(r.swarm);
      final t = open(r.chat);
      await t.load();
      return (swarm: r.swarm, chat: r.chat, thread: t);
    }

    test('offers whom the chat\'s composer offers: its agents and the people '
        'who read it, never the reader', () async {
      final r = await tagging();
      expect(
        [for (final a in r.thread.mentionable) a.id],
        ['agent-lead', 'agent-builder'],
      );
      expect([for (final p in r.thread.mentionablePeople) p.id], ['dee']);
    });

    test('a picked agent is a recipient and a picked person is tagged, while '
        'the text names them', () async {
      final r = await tagging();
      final t = r.thread;

      t.draft = 'Can you check';
      t.mention('agent-builder');
      t.mention('dee');
      expect(t.draft, 'Can you check @Nova @dee ');
      t.draft = '${t.draft}this';
      expect(await t.send(), isTrue);

      expect(r.swarm.commands.single, {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': 'Can you check @Nova @dee this',
        'replyTo': 'm1',
        'recipientIds': ['agent-builder'],
        'mentions': ['dee'],
      });
      expect(t.mentions, isEmpty, reason: 'the next reply names no one yet');
      expect(r.chat.threadMentions('m1'), isEmpty);
    });

    test('Tag ends the draft in an @ or takes it back, and a pick takes the '
        'place of the name being typed', () async {
      final r = await tagging();
      final t = r.thread;

      t.draft = 'ask';
      t.toggleMention();
      expect(t.draft, 'ask @');
      expect(t.mentionQuery, '');
      t.toggleMention();
      expect(t.draft, 'ask ');
      expect(t.mentionQuery, isNull);

      t.draft = 'ask @No';
      expect(t.mentionQuery, 'No');
      t.completeMention('agent-builder');
      expect(t.draft, 'ask @Nova ');
      expect(t.mentionQuery, isNull);
      expect(t.mentions, {'agent-builder': '@Nova'});
    });

    test('a name taken out of the text names nobody', () async {
      final r = await tagging();
      final t = r.thread;

      t.mention('agent-builder');
      t.mention('dee');
      t.draft = 'never mind';
      expect(t.mentions, isEmpty);
      expect(await t.send(), isTrue);

      expect(r.swarm.commands.single['recipientIds'], isEmpty);
      expect(r.swarm.commands.single.containsKey('mentions'), isFalse);
    });

    test('refused, the reply goes back to the box with its names, which go '
        'with it again', () async {
      final r = await tagging();
      var refuse = true;
      r.swarm.routes[commands] = (body) => refuse
          ? throw const SuperTabFailure(
              'TOO_LONG',
              'This message is too long.',
              statusCode: 400,
            )
          : {'ok': true};
      final t = r.thread;
      t.mention('agent-builder');
      t.mention('dee');
      t.draft = '${t.draft}please';

      expect(await t.send(), isFalse);
      expect(t.draft, '@Nova @dee please');
      expect(t.mentions, {'agent-builder': '@Nova', 'dee': '@dee'});
      expect(t.error, 'This message is too long.');

      refuse = false;
      expect(await t.send(), isTrue);
      expect(r.swarm.commands.last['recipientIds'], ['agent-builder']);
      expect(r.swarm.commands.last['mentions'], ['dee']);
    });

    test('the names stay with the thread\'s draft while the chat is open, '
        'and not with another thread\'s', () async {
      final r = await rig();
      readsBack(r.swarm);
      final first = SwarmThread(r.chat, 'm1')..mention('agent-builder');
      first.dispose();

      final again = open(r.chat);
      expect(again.draft, '@Nova ');
      expect(again.mentions, {'agent-builder': '@Nova'});
      expect(open(r.chat, 'm9').mentions, isEmpty);
      again.draft = '${again.draft}look';
      expect(await again.send(), isTrue);
      expect(r.swarm.commands.single['recipientIds'], ['agent-builder']);
    });

    /// Nova (agent-builder) taken out of g1, and the Swarm read again.
    Future<void> novaLeaves(FakeSwarm swarm, SwarmReader reader) async {
      final parts = swarm.routes['/api/super-tabs/$tab/parts']!;
      swarm.routes['/api/super-tabs/$tab/parts'] = (body) {
        final read = parts(body) as Map<String, dynamic>;
        return {
          ...read,
          'groups': [
            for (final g in (read['groups'] as List).cast<Map>())
              g['key'] == 'g1'
                  ? part('g1', (g['version'] as int) + 1, {
                      ...(g['data'] as Map<String, dynamic>),
                      'agentIds': ['agent-lead'],
                    })
                  : g,
          ],
        };
      };
      // The changes say read it all again.
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await reader.refresh();
      await settle();
    }

    const left =
        'A mentioned agent is no longer in this conversation. '
        'Remove its mention or choose another agent.';

    test('a picked agent who has left the chat since is refused in the '
        "desktop's words, the reply kept in the box (controller.dart "
        'sendThreadReply)', () async {
      final r = await tagging();
      final t = r.thread;
      t.draft = 'Can you check';
      t.mention('agent-builder');
      t.mention('dee');
      expect(t.draft, 'Can you check @Nova @dee ');

      await novaLeaves(r.swarm, r.chat.reader);
      expect(r.chat.conversation!.agentIds, ['agent-lead']);
      expect(await t.send(), isFalse);

      expect(t.error, left);
      expect(r.swarm.commands, isEmpty, reason: 'nothing sent without Nova');
      expect(t.draft, 'Can you check @Nova @dee ');
      expect(t.mentions, {'agent-builder': '@Nova', 'dee': '@dee'});
    });

    test('the same in the chat\'s own box (controller.dart send)', () async {
      final r = await tagging();
      final c = r.chat;
      c.draft = 'Can you check';
      c.mention('agent-builder');

      await novaLeaves(r.swarm, c.reader);
      expect(await c.send(), isFalse);

      expect(c.error, left);
      expect(r.swarm.commands, isEmpty);
      expect(c.draft, 'Can you check @Nova ');
      expect(c.mentions, {'agent-builder': '@Nova'});
    });

    test('once the mention is taken out, the reply goes', () async {
      final r = await tagging();
      final t = r.thread;
      t.mention('agent-builder');
      await novaLeaves(r.swarm, r.chat.reader);
      t.draft = 'never mind';

      expect(await t.send(), isTrue);
      expect(r.swarm.commands.single['recipientIds'], isEmpty);
    });

    test('access lost while the thread is open takes its names too', () async {
      final r = await tagging();
      r.thread.mention('agent-builder');

      r.chat.reader.revoke();
      await settle();

      expect(r.thread.state, SwarmChatState.lost);
      expect(r.thread.draft, isEmpty);
      expect(r.thread.mentions, isEmpty);
      expect(r.chat.threadMentions('m1'), isEmpty);
    });
  });

  test('the draft stays with its thread while the chat is open', () async {
    final r = await rig();
    final first = SwarmThread(r.chat, 'm1')..draft = 'Half a reply';
    first.dispose();

    expect(open(r.chat).draft, 'Half a reply');
    expect(open(r.chat, 'm9').draft, isEmpty);
  });

  test('Also send names the chat as the desktop does', () async {
    final work = await rig(number: 12);
    expect(open(work.chat).alsoSendLabel, 'Also send to the workgroup');
    final chat = await rig();
    expect(open(chat.chat).alsoSendLabel, 'Also send to the chat');
  });

  group('files', () {
    SwarmOutgoingFile file(String name, [int size = 3]) =>
        SwarmOutgoingFile(name, Uint8List.fromList(List.filled(size, 7)));
    List<String> names(Iterable<SwarmOutgoingFile> files) => [
      for (final f in files) f.name,
    ];

    test('attached files go up for the chat, then the reply names them, to '
        'the chat too with Also send', () async {
      final uploads = FakeUploads();
      final r = await rig(uploads: uploads);
      readsBack(r.swarm);
      final t = open(r.chat);
      t.draft = 'Here are the shots';
      t.alsoSend = true;
      t.files.add([file('a.jpg'), file('b.pdf', 5)]);
      expect(t.canSend, isTrue);

      expect(await t.send(), isTrue);

      expect(uploads.names, ['a.jpg', 'b.pdf']);
      for (final u in uploads.asked) {
        expect((u.tabId, u.conversationId), (tab, 'g1'));
      }
      expect(uploads.asked.last.mime, 'application/pdf');
      expect(r.swarm.commands, [
        {
          'type': 'message.send',
          'conversationId': 'g1',
          'text': 'Here are the shots',
          'replyTo': 'm1',
          'recipientIds': <String>[],
          'alsoSend': true,
          'attachmentIds': ['id-a.jpg', 'id-b.pdf'],
        },
      ]);
      expect(t.files.files, isEmpty);
      expect(t.outgoing, isEmpty, reason: 'read back');
      expect(r.chat.files.files, isEmpty, reason: 'the chat\'s own box');
    });

    test('a reply of files alone goes with no text', () async {
      final uploads = FakeUploads();
      final r = await rig(uploads: uploads);
      readsBack(r.swarm);
      final t = open(r.chat);
      expect(t.canSend, isFalse);
      t.files.add([file('crash.log')]);
      expect(t.canSend, isTrue);

      expect(await t.send(), isTrue);

      expect(r.swarm.commands.single['text'], '');
      expect(r.swarm.commands.single['attachmentIds'], ['id-crash.log']);
    });

    test('while the files go up the box holds them and cannot send; on their '
        'way the reply shows them', () async {
      final uploads = FakeUploads()..answersAtOnce = false;
      final r = await rig(uploads: uploads);
      final answer = Completer<Object?>();
      r.swarm.routes[commands] = (_) => answer.future;
      final t = open(r.chat);
      final a = file('a.jpg');
      t.draft = 'look';
      t.files.add([a]);

      final sending = t.send();
      await settle();
      expect(t.uploading, isTrue);
      expect(t.isUploading(a), isTrue);
      expect(t.canSend, isFalse);
      expect(await t.send(), isFalse, reason: 'one send at a time');
      expect(t.draft, 'look');
      expect(names(t.files.files), ['a.jpg']);
      uploads.asked.single.onProgress(0.5);
      expect(t.uploadProgress(a), 0.5);

      uploads.asked.single.answer.complete(FakeUploads.attachment('f1'));
      await settle();
      expect(t.uploading, isFalse);
      expect(t.outgoing.firstOrNull?.text, 'look');
      expect(names(t.outgoing.single.files), ['a.jpg']);
      expect(t.files.files, isEmpty);

      answer.complete({'ok': true});
      await sending;
    });

    test('files are the thread\'s own: apart from the chat\'s and other '
        'threads\', and kept with the thread while the chat is open', () async {
      final r = await rig();
      final first = SwarmThread(r.chat, 'm1');
      first.files.add([file('a.jpg')]);
      first.dispose();

      expect(r.chat.files.files, isEmpty);
      expect(open(r.chat, 'm9').files.files, isEmpty);
      expect(names(open(r.chat).files.files), ['a.jpg']);
    });

    test('an upload refused shows what the chat shows, keeps the draft and '
        'the files, and sends nothing', () async {
      const refused = SuperTabFailure(
        'ATTACHMENT_TOO_LARGE',
        'Files can be up to 256 MB.',
        statusCode: 413,
      );
      final uploads = FakeUploads()..refuse['b.jpg'] = refused;
      final r = await rig(uploads: uploads);
      r.chat.files.add([file('a.jpg'), file('b.jpg')]);
      expect(await r.chat.send(), isFalse);
      final t = open(r.chat);
      t.draft = 'look';
      t.files.add([file('a.jpg'), file('b.jpg')]);

      expect(await t.send(), isFalse);

      expect(t.error, r.chat.error);
      expect(t.error, 'Files can be up to 256 MB.');
      expect(t.draft, 'look');
      expect(names(t.files.files), ['a.jpg', 'b.jpg']);
      expect(r.swarm.commands, isEmpty);
      expect(t.uploading, isFalse);
      expect(t.outgoing, isEmpty);
      expect(t.canSend, isTrue, reason: 'not stuck: Send tries again');
    });

    test(
      'an upload that fails for any other reason says what the chat says',
      () async {
        final uploads = FakeUploads()..answersAtOnce = false;
        final r = await rig(uploads: uploads);
        r.chat.files.add([file('a.jpg')]);
        final chatSending = r.chat.send();
        await settle();
        uploads.asked.last.answer.completeError(StateError('socket closed'));
        expect(await chatSending, isFalse);
        final t = open(r.chat);
        t.files.add([file('a.jpg')]);

        final sending = t.send();
        await settle();
        uploads.asked.last.answer.completeError(StateError('socket closed'));

        expect(await sending, isFalse);
        expect(t.error, r.chat.error);
        expect(t.error, 'Could not upload the file. Try again.');
      },
    );

    test(
      'Send again after a failed upload sends only what did not go up',
      () async {
        final uploads = FakeUploads()
          ..refuse['b.jpg'] = const SuperTabFailure('UPLOAD_FAILED', 'No.');
        final r = await rig(uploads: uploads);
        readsBack(r.swarm);
        final t = open(r.chat);
        t.files.add([file('a.jpg'), file('b.jpg')]);
        expect(await t.send(), isFalse);
        uploads.refuse.clear();

        expect(await t.send(), isTrue);

        expect(uploads.names, ['a.jpg', 'b.jpg', 'b.jpg']);
        expect(r.swarm.commands.single['attachmentIds'], [
          'id-a.jpg',
          'id-b.jpg',
        ]);
      },
    );

    test('a reply refused for its files puts them back and sends them up '
        'again; one refused for anything else keeps them uploaded', () async {
      final uploads = FakeUploads();
      final r = await rig(uploads: uploads);
      var refusal = const SuperTabFailure(
        'ATTACHMENT_UNAVAILABLE',
        'That file is no longer there. Attach it again.',
        statusCode: 400,
      );
      r.swarm.routes[commands] = (_) => throw refusal;
      final t = open(r.chat);
      t.draft = 'look';
      t.files.add([file('a.jpg')]);

      expect(await t.send(), isFalse);
      expect(t.draft, 'look');
      expect(names(t.files.files), ['a.jpg']);
      expect(t.outgoing, isEmpty);
      expect(t.error, 'That file is no longer there. Attach it again.');

      refusal = const SuperTabFailure(
        'INVALID_COMMAND',
        'That reply could not be sent.',
        statusCode: 400,
      );
      expect(await t.send(), isFalse);
      expect(uploads.names, ['a.jpg', 'a.jpg'], reason: 'up again');
      expect(names(t.files.files), ['a.jpg']);

      readsBack(r.swarm);
      expect(await t.send(), isTrue);
      expect(uploads.names, ['a.jpg', 'a.jpg'], reason: 'kept uploaded');
    });

    test('taking a file off while it goes up gives the upload up and sends '
        'nothing', () async {
      final uploads = FakeUploads()..answersAtOnce = false;
      final r = await rig(uploads: uploads);
      final t = open(r.chat);
      final a = file('a.jpg');
      t.draft = 'look';
      t.files.add([a, file('b.jpg')]);
      final sending = t.send();
      await settle();

      t.files.remove(a);

      expect(t.uploading, isFalse);
      expect(uploads.asked.single.cancel.isCancelled, isTrue);
      expect(await sending, isFalse);
      expect(r.swarm.commands, isEmpty);
      expect(t.draft, 'look');
      expect(names(t.files.files), ['b.jpg']);
      expect(t.canSend, isTrue);
    });

    test('leaving the thread while its files go up changes nothing: the '
        'upload stops, nothing is sent, and the draft and the files wait for '
        'it', () async {
      final uploads = FakeUploads()..answersAtOnce = false;
      final r = await rig(uploads: uploads);
      readsBack(r.swarm);
      final t = SwarmThread(r.chat, 'm1');
      t.draft = 'look';
      t.files.add([file('a.jpg')]);
      final sending = t.send();
      await settle();

      t.dispose();
      expect(uploads.asked.single.cancel.isCancelled, isTrue);
      uploads.asked.single.answer.complete(FakeUploads.attachment('late'));

      expect(await sending, isFalse);
      await settle();
      expect(r.swarm.commands, isEmpty);
      expect(r.chat.error, isNull);
      final again = open(r.chat);
      expect(again.draft, 'look');
      expect(names(again.files.files), ['a.jpg']);
      expect(again.uploading, isFalse);
      expect(again.error, isNull);
      expect(again.canSend, isTrue);
    });

    test('access taken away while the files go up: the upload stops, the '
        'files and the draft go, and the late answer sends nothing', () async {
      final uploads = FakeUploads()..answersAtOnce = false;
      final r = await rig(uploads: uploads);
      final t = open(r.chat);
      t.draft = 'Secret plan';
      t.files.add([file('plan.pdf')]);
      final sending = t.send();
      await settle();

      r.reader.revoke();

      expect(t.state, SwarmChatState.lost);
      expect(t.uploading, isFalse);
      expect(t.files.files, isEmpty);
      expect(t.draft, isEmpty);
      expect(uploads.asked.single.cancel.isCancelled, isTrue);
      uploads.asked.single.answer.complete(FakeUploads.attachment('late'));
      expect(await sending, isFalse);
      expect(r.swarm.commands, isEmpty);
      expect(t.error, isNull);
      expect(r.chat.threadFiles('m1').files, isEmpty);
    });

    for (final code in ['FORBIDDEN', 'NOT_FOUND']) {
      test('an upload refused with $code drops the thread, as a refused reply '
          'does', () async {
        final uploads = FakeUploads()
          ..refuse['plan.pdf'] = SuperTabFailure(
            code,
            'You cannot read this chat.',
            statusCode: code == 'FORBIDDEN' ? 403 : 404,
          );
        final r = await rig(uploads: uploads);
        final t = open(r.chat);
        t.draft = 'Secret plan';
        t.files.add([file('plan.pdf')]);
        final before = r.swarm.paths.length;

        expect(await t.send(), isFalse);

        expect(t.state, SwarmChatState.lost);
        expect(t.files.files, isEmpty);
        expect(t.draft, isEmpty);
        expect(t.error, isNull, reason: 'no message from a chat not open');
        expect(r.swarm.commands, isEmpty);
        await settle();
        expect(
          r.swarm.paths.skip(before).where((p) => p.startsWith(messages)),
          isNotEmpty,
          reason: 'the chat reads again to learn it',
        );
      });
    }

    test('the chat losing access empties every thread\'s files, those a '
        'thread screen holds too', () async {
      final r = await rig();
      final held = r.chat.threadFiles('m1')..add([file('a.jpg')]);
      final other = r.chat.threadFiles('m9')..add([file('b.jpg')]);

      r.reader.revoke();
      await settle();

      expect(held.files, isEmpty);
      expect(other.files, isEmpty);
      expect(r.chat.threadFiles('m1').files, isEmpty);
    });
  });

  group('privacy', () {
    test('access taken away while the thread is open drops its rows, its '
        'draft and an answer on its way', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
        'next': null,
      };
      final t = open(r.chat);
      await t.load();
      t.draft = 'Secret plan';
      final late = Completer<Object?>();
      r.swarm.routes[thread] = (_) => late.future;
      final reading = t.load();
      await settle();

      r.reader.revoke();
      late.complete({
        'messages': [message('m1', 1), message('m4', 4, root: 'm1')],
        'next': null,
      });
      await reading;
      await settle();

      expect(t.state, SwarmChatState.lost);
      expect(t.messages, isEmpty);
      expect(t.draft, isEmpty);
      expect(r.chat.threadDraft('m1'), isEmpty);
      expect(t.canSend, isFalse);
    });

    test('a chat refused to the person refuses its thread alike, showing '
        'nothing', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      final t = open(r.chat);
      t.draft = 'Hello';

      await t.load();

      expect(t.state, SwarmChatState.lost);
      expect(t.messages, isEmpty);
      expect(t.draft, isEmpty);
      expect(t.error, isNull, reason: 'the page says it is not open');
    });

    for (final code in ['FORBIDDEN', 'NOT_FOUND']) {
      test('a reply refused with $code drops the thread as a refused read '
          'does, and the chat reads again', () async {
        final r = await rig();
        r.swarm.routes[thread] = (_) => {
          'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
          'next': null,
        };
        final t = open(r.chat);
        await t.load();
        r.swarm.routes[commands] = (_) =>
            throw SuperTabFailure(code, 'Not yours.', statusCode: 403);
        final before = r.swarm.paths.length;
        t.draft = 'Secret plan';
        t.alsoSend = true;

        expect(await t.send(), isFalse);
        await settle();

        expect(t.state, SwarmChatState.lost);
        expect(t.messages, isEmpty);
        expect(t.draft, isEmpty, reason: 'not put back in the box');
        expect(t.alsoSend, isFalse);
        expect(t.outgoing, isEmpty);
        expect(t.error, isNull, reason: 'the page says it is not open');
        expect(r.chat.threadDraft('m1'), isEmpty);
        expect(
          r.swarm.paths.skip(before).where((p) => p.startsWith(messages)),
          isNotEmpty,
          reason: 'the chat reads again',
        );
      });
    }

    test(
      'a reaction whose read of the thread is refused drops the thread',
      () async {
        final r = await rig();
        r.swarm.routes[thread] = (_) => {
          'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
          'next': null,
        };
        final t = open(r.chat);
        await t.load();
        r.swarm.routes[commands] = (_) => {'ok': true};
        r.swarm.routes[thread] = (_) => throw const SuperTabFailure(
          'FORBIDDEN',
          'Not yours.',
          statusCode: 403,
        );

        expect(
          await t.react(t.replies.single, SuperTabReactionEmoji.rocket),
          isTrue,
        );
        await settle();

        expect(t.state, SwarmChatState.lost);
        expect(t.messages, isEmpty);
      },
    );

    test('a refused reaction has the chat read again, and a chat refused '
        'there drops the thread', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
        'next': null,
      };
      final t = open(r.chat);
      await t.load();
      const refused = SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      r.swarm.routes[commands] = (_) => throw refused;
      r.swarm.routes[messages] = (_) => throw refused;

      expect(
        await t.react(t.replies.single, SuperTabReactionEmoji.rocket),
        isFalse,
      );
      await settle();

      expect(r.chat.state, SwarmChatState.lost);
      expect(t.state, SwarmChatState.lost);
      expect(t.messages, isEmpty);
    });

    test('a reply refused after its thread closed puts nothing back', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final answer = Completer<Object?>();
      r.swarm.routes[commands] = (_) => answer.future;
      final t = SwarmThread(r.chat, 'm1');
      await t.load();
      t.draft = 'Too late';
      final sending = t.send();
      await settle();

      t.dispose();
      answer.completeError(
        const SuperTabFailure(
          'ARCHIVED',
          'This chat is archived.',
          statusCode: 409,
        ),
      );

      expect(await sending, isFalse);
      expect(r.chat.threadDraft('m1'), isEmpty);
    });

    test('a reply refused after access went puts nothing back', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final answer = Completer<Object?>();
      r.swarm.routes[commands] = (_) => answer.future;
      final t = open(r.chat);
      await t.load();
      t.draft = 'Secret plan';
      t.alsoSend = true;
      final sending = t.send();
      await settle();

      r.reader.revoke();
      answer.completeError(
        const SuperTabFailure(
          'ARCHIVED',
          'This chat is archived.',
          statusCode: 409,
        ),
      );

      expect(await sending, isFalse);
      expect(t.state, SwarmChatState.lost);
      expect(t.draft, isEmpty);
      expect(t.alsoSend, isFalse);
      expect(t.error, isNull);
      expect(r.chat.threadDraft('m1'), isEmpty);
    });

    test('taken out of the chat, the thread hides what it read', () async {
      var listed = true;
      final r = await rig(listed: () => listed);
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
        'next': null,
      };
      final t = open(r.chat);
      await t.load();
      expect(t.messages, isNotEmpty);
      listed = false;
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};

      await r.reader.refresh();
      await settle();

      expect(t.messages, isEmpty);
      expect(t.state, isNot(SwarmChatState.loaded));
    });

    test('a failed read says so, is not left loading, and reads again when '
        'asked', () async {
      final r = await rig();
      var fails = true;
      r.swarm.routes[thread] = (_) => fails
          ? throw StateError('offline')
          : {
              'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
              'next': null,
            };
      final t = open(r.chat);

      await t.load();

      expect(t.error, 'Could not load the thread. Try again.');
      expect(r.swarm.paths.where((p) => p.startsWith(thread)), hasLength(1));
      await settle();
      expect(
        r.swarm.paths.where((p) => p.startsWith(thread)),
        hasLength(1),
        reason: 'no read of its own again',
      );

      fails = false;
      await t.load();

      expect(t.error, isNull);
      expect(t.state, SwarmChatState.loaded);
      expect([for (final m in t.replies) m.id], ['m2']);
    });

    test('earlier replies that fail say so and can be asked again', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1), message('m2', 2, root: 'm1')],
        'next': {'sequence': 2, 'id': 'm2'},
      };
      for (var top = 2; top < 10; top++) {
        // Five pages on opening, each ending where it began.
        r.swarm.routes['$thread&before=$top&beforeId=m$top'] = (_) => {
          'messages': <Object>[],
          'next': {'sequence': 2, 'id': 'm2'},
        };
      }
      final t = open(r.chat);
      await t.load();
      expect(t.hasEarlier, isTrue);
      r.swarm.routes['$thread&before=2&beforeId=m2'] = (_) =>
          throw StateError('offline');

      await t.loadEarlier();

      expect(t.error, 'Could not load earlier replies. Try again.');
      expect(t.readingEarlier, isFalse);
      expect(t.hasEarlier, isTrue);
    });
  });

  group('replies on their way (Dee, 11-01)', () {
    /// The bodies [swarm] was sent, by receipt, each answered by hand.
    Map<String, Completer<Object?>> held(FakeSwarm swarm) {
      final answers = <String, Completer<Object?>>{};
      swarm.routes[commands] = (body) =>
          (answers[body!['operationId'] as String] ??= Completer()).future;
      return answers;
    }

    Future<SwarmThread> opened(
      ({FakeSwarm swarm, SwarmReader reader, SwarmConversation chat}) r,
    ) async {
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final t = open(r.chat);
      await t.load();
      return t;
    }

    test('a reply the chat reads back under the id the backend gives it '
        'leaves at once, though its answer is still coming, and Send is free '
        'all along', () async {
      final r = await rig();
      final answers = held(r.swarm);
      final t = await opened(r);
      t.draft = 'why do we need the 13mm floor?';
      final sending = t.send();
      await settle();
      final receipt = answers.keys.single;
      t.draft = 'and the lip?';
      expect(t.canSend, isTrue);

      r.swarm.routes['$messages?after=2'] = (_) => {
        'messages': [message(sentId(receipt), 3, root: 'm1')],
        'next': null,
      };
      await r.chat.load();
      expect(t.outgoing, isEmpty, reason: 'shown once, as its reply');

      answers[receipt]!.complete({'result': <String, dynamic>{}});
      expect(await sending, isTrue);
      expect(t.outgoing, isEmpty);
      expect([for (final m in t.replies) m.id], ['m2', sentId(receipt)]);
    });

    test('its own read brings it back too, and the answer\'s id wins over '
        'the one worked out', () async {
      final r = await rig();
      r.swarm.routes[commands] = (_) => {
        'result': {'messageId': 'server-r9'},
      };
      final t = await opened(r);
      t.draft = 'On it';

      expect(await t.send(), isTrue);
      expect(t.outgoing.single.messageId, 'server-r9');

      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1), message('server-r9', 3, root: 'm1')],
        'next': null,
      };
      await t.load();
      expect(t.outgoing, isEmpty);
    });

    test('its id in another chat settles nothing', () async {
      final r = await rig();
      final answers = held(r.swarm);
      final t = await opened(r);
      t.draft = 'On it';
      unawaited(t.send());
      await settle();
      final receipt = answers.keys.single;

      r.swarm.routes[thread] = (_) => {
        'messages': [
          message('m1', 1),
          message(sentId(receipt), 3, root: 'm1', conversationId: 'g2'),
        ],
        'next': null,
      };
      await t.load();
      expect(t.outgoing.single.text, 'On it');
      answers[receipt]!.complete({'result': <String, dynamic>{}});
      await settle();
    });

    test('no answer in time says Not sent; Retry reuses the receipt and the '
        'late answer counts', () async {
      final r = await rig();
      final answers = held(r.swarm);
      final chat = SwarmConversation(
        r.reader,
        'g1',
        sendTimeout: const Duration(milliseconds: 20),
      );
      addTearDown(chat.dispose);
      await chat.load();
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final t = open(chat);
      await t.load();
      t.draft = 'Once only';

      expect(await t.send(), isFalse);
      final post = t.outgoing.single;
      expect(post.state, SwarmPostState.unconfirmed);
      expect(t.error, contains('not sent'));

      final again = t.retry(post);
      await settle();
      final posts = [
        for (final call in r.swarm.calls)
          if (call.path == commands) call.body!['operationId'],
      ];
      expect(posts, hasLength(2));
      expect(posts.toSet(), hasLength(1), reason: 'one reply, one receipt');
      // A runner slower than the send timeout.
      await Future<void>.delayed(const Duration(milliseconds: 30));
      answers.values.single.complete({'result': <String, dynamic>{}});
      expect(await again, isTrue);
      expect(post.state, SwarmPostState.confirmed);
      expect(t.error, isNull);
    });

    test(
      'a refusal that lands after Not sent still puts the reply back',
      () async {
        final r = await rig();
        final answers = held(r.swarm);
        final chat = SwarmConversation(
          r.reader,
          'g1',
          sendTimeout: const Duration(milliseconds: 20),
        );
        addTearDown(chat.dispose);
        await chat.load();
        r.swarm.routes[thread] = (_) => {
          'messages': [message('m1', 1)],
          'next': null,
        };
        final t = open(chat);
        await t.load();
        t.draft = 'Too long';

        expect(await t.send(), isFalse);
        expect(t.draft, isEmpty);
        answers.values.single.completeError(
          const SuperTabFailure('TOO_LONG', 'Too long.', statusCode: 400),
        );
        await settle();
        expect(t.outgoing, isEmpty);
        expect(t.draft, 'Too long');
        expect(t.error, 'Too long.');
      },
    );

    test('a refused reply goes back to the box while another stays on its '
        'way', () async {
      final r = await rig();
      final answers = held(r.swarm);
      final t = await opened(r);
      t.draft = 'Too long';
      t.alsoSend = true;
      final refused = t.send();
      await settle();
      t.draft = 'Fine';
      final fine = t.send();
      await settle();

      answers.values.first.completeError(
        const SuperTabFailure('TOO_LONG', 'Too long.', statusCode: 400),
      );
      expect(await refused, isFalse);
      expect(t.draft, 'Too long');
      expect(t.alsoSend, isTrue);
      expect([for (final p in t.outgoing) p.text], ['Fine']);
      answers.values.last.complete({'result': <String, dynamic>{}});
      expect(await fine, isTrue);
    });

    test('access lost while a reply is on its way drops it, and its answer '
        'changes nothing', () async {
      final r = await rig();
      final answers = held(r.swarm);
      final t = await opened(r);
      t.draft = 'Secret plan';
      final sending = t.send();
      await settle();

      r.reader.revoke();
      await settle();
      expect(t.outgoing, isEmpty);

      answers.values.single.completeError(
        const SuperTabFailure('TOO_LONG', 'Too long.', statusCode: 400),
      );
      expect(await sending, isFalse);
      expect(t.draft, isEmpty, reason: 'nothing put back');
      expect(t.outgoing, isEmpty);
      expect(t.error, isNull);
    });

    test('an answer after the thread closed changes nothing', () async {
      final r = await rig();
      final answers = held(r.swarm);
      r.swarm.routes[thread] = (_) => {
        'messages': [message('m1', 1)],
        'next': null,
      };
      final t = SwarmThread(r.chat, 'm1');
      await t.load();
      t.draft = 'Bye';
      final sending = t.send();
      await settle();

      t.dispose();
      answers.values.single.complete({'result': <String, dynamic>{}});
      expect(await sending, isFalse);
      expect(r.chat.threadDraft('m1'), isEmpty);
    });

    test('a first read that failed and later recovered still sends and '
        'settles', () async {
      final r = await rig();
      r.swarm.routes[thread] = (_) => throw StateError('offline');
      final t = open(r.chat);
      await t.load();
      expect(t.readError, isNotNull);
      readsBack(r.swarm);
      t.draft = 'Hello';

      expect(t.canSend, isTrue);
      expect(await t.send(), isTrue);
      await settle();
      expect(t.outgoing, isEmpty);
      final receipt =
          r.swarm.calls
                  .lastWhere((call) => call.path == commands)
                  .body!['operationId']
              as String;
      expect(t.replies.last.id, sentId(receipt));
    });
  });
}
