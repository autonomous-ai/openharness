import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// What a chat's or a project's row says is new (desktop design system,
/// People and conversations in lists): unread, its name in bold; the Lead's
/// tags still waiting on the person, bold too, with an `@N` count of them.
void main() {
  const other = 'project-2';

  Map<String, dynamic> mentionRow(
    String id, {
    String conversationId = 'g1',
    String projectId = project,
    String? threadId,
    int? messageSequence,
  }) => {
    'id': id,
    'threadId': ?threadId,
    'messageSequence': ?messageSequence,
    'projectId': projectId,
    'projectName': 'Mobile',
    'conversationId': conversationId,
    'conversationTitle': 'Fix login',
    'messageId': 'msg-$id',
    'leadName': 'River',
    'text': 'Look',
    'createdAt': '2026-10-27T01:00:00.000Z',
  };

  Map<String, dynamic> decisionRow(String id, {String conversationId = 'g1'}) =>
      {
        'id': id,
        'batchId': 'batch-$id',
        'projectId': project,
        'projectName': 'Mobile',
        'conversationId': conversationId,
        'conversationTitle': 'Fix login',
        'askerName': 'River',
        'question': 'Ship it?',
        'options': ['Yes', 'No'],
        'recommended': 0,
        'unblocks': 'The release',
        'createdAt': '2026-10-27T01:00:00.000Z',
      };

  /// A Swarm of two projects: Mobile with its project chat, work g1 and g2,
  /// closed work, a private chat and the reader's Buddy chat; Web with its
  /// project chat. Read once, so what is there counts as read; [tags] wait,
  /// and [decisions] are open. [settings] are the reader's own notification
  /// settings by chat.
  Future<({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks})> rig({
    List<Map<String, dynamic>> tags = const [],
    List<Map<String, dynamic>> decisions = const [],
    Map<String, String> settings = const {},
  }) async {
    final swarm = FakeSwarm();
    Map<String, dynamic> inWeb(Map<String, dynamic> group) => {
      ...group,
      'projectId': other,
    };
    final groups = [
      groupData('g1', title: 'Fix login', lastMessageSequence: 3),
      groupData('g2', title: 'Ship it', lastMessageSequence: 1),
      {...groupData('closed', lastMessageSequence: 1), 'archived': true},
      groupData('private', audience: [me], lastMessageSequence: 1),
      buddyChatData('buddy-chat', lastMessageSequence: 1),
      inWeb(groupData('web-lead', title: 'Web', lastMessageSequence: 1)),
    ];
    final head = headData(
      projects: [
        ...headData()['projects'] as List,
        {
          'id': other,
          'name': 'Web',
          'ownerId': me,
          'leadConversationId': 'web-lead',
          'visibility': 'public',
          'members': <Object>[],
          'updateMinutes': 5,
        },
      ],
    );
    final derived = {
      'mentionsWaiting': tags.length,
      'decisionsWaiting': decisions.length,
      if (settings.isNotEmpty) 'chatSettings': settings,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(head: head, groups: groups, derived: derived);
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': tags,
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': decisions,
    };
    swarm.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body!['sequence'],
    };
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = reader.readMarks = SwarmReadMarks(reader, store: null);
    final asks = SwarmAsks(reader);
    addTearDown(() {
      asks.dispose();
      marks.dispose();
      reader.dispose();
    });
    await reader.refresh();
    await settle();
    return (swarm: swarm, reader: reader, asks: asks);
  }

  /// A change read in which [groups] moved, by id, to their [version].
  Future<void> moveOn(
    ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r,
    Map<String, Map<String, dynamic>> groups, {
    int version = 20,
    Map<String, dynamic> derived = const {},
  }) async {
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c$version',
      derived: derived,
      groups: [
        for (final MapEntry(:key, :value) in groups.entries)
          part(key, version, value),
      ],
    );
    await r.reader.refresh();
    await settle();
  }

  SwarmRowNews chat(
    ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r,
    String id,
  ) => swarmChatNews(r.reader, r.asks, r.reader.snapshot!.conversation(id)!);

  test('nothing is new after the first read', () async {
    final r = await rig();

    expect(chat(r, 'g1'), (bold: false, tags: 0));
    expect(swarmProjectNews(r.reader, r.asks), isEmpty);
  });

  test('an unread chat is bold, with no count', () async {
    final r = await rig();
    await moveOn(r, {
      'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
    });

    expect(chat(r, 'g1'), (bold: true, tags: 0));
    expect(chat(r, 'g2'), (bold: false, tags: 0));
  });

  test('a reply only in a thread leaves a read chat and its project as they '
      'were; a main-stream task message makes only its chat bold', () async {
    final r = await rig();
    await moveOn(r, {
      'g1': {
        ...groupData('g1', title: 'Fix login', lastMessageSequence: 4),
        'lastMainSequence': 3,
      },
    });

    expect(chat(r, 'g1'), (bold: false, tags: 0));
    expect(swarmProjectNews(r.reader, r.asks), isEmpty);

    await moveOn(r, version: 21, {
      'g1': {
        ...groupData('g1', title: 'Fix login', lastMessageSequence: 5),
        'lastMainSequence': 5,
      },
    });

    expect(chat(r, 'g1'), (bold: true, tags: 0));
    expect(swarmProjectNews(r.reader, r.asks), isEmpty);
  });

  test("a chat the Lead tagged the person in is bold with the count of the "
      "tags still waiting, from a server that does not say where they are "
      "past any read mark", () async {
    final r = await rig(
      tags: [
        mentionRow('t1'),
        mentionRow('t2'),
        mentionRow('t3', conversationId: 'g2'),
      ],
    );

    expect(chat(r, 'g1'), (bold: true, tags: 2));
    expect(chat(r, 'g2'), (bold: true, tags: 1));
    expect(chat(r, leadChat), (bold: false, tags: 0));
  });

  test('a project counts only tags opening its chat clears, while task tags stay on their own row', () async {
    final r = await rig(
      tags: [
        mentionRow('project-tag', conversationId: leadChat, messageSequence: 4),
        mentionRow('task-tag', messageSequence: 4),
      ],
    );
    await moveOn(r, {
      leadChat: groupData(leadChat, title: 'Mobile', lastMessageSequence: 4),
      'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
    });
    expect(swarmProjectNews(r.reader, r.asks)[project]?.tags, 1);
    expect(chat(r, 'g1'), (bold: true, tags: 1));

    r.reader.readMarks!.markRead(leadChat, 4);
    await settle();
    expect(swarmProjectNews(r.reader, r.asks)[project], (
      bold: false,
      tags: 0,
      hasWaitingTag: true,
    ));
    expect(chat(r, 'g1'), (bold: true, tags: 1));
    expect(
      r.asks.mentions,
      hasLength(2),
      reason: 'Activity retains waiting tags',
    );
  });

  test('a project is bold for people in its own chat, while task tags '
      'only keep it under the filters', () async {
    final r = await rig(tags: [mentionRow('t1'), mentionRow('t2')]);

    expect(swarmProjectNews(r.reader, r.asks), {
      project: (bold: false, tags: 0, hasWaitingTag: true),
    });

    final quiet = await rig();
    await moveOn(quiet, {
      leadChat: {
        ...groupData(leadChat, title: 'Mobile', lastMessageSequence: 5),
        'lastPersonSequence': 5,
      },
      'web-lead': {
        ...groupData('web-lead', title: 'Web', lastMessageSequence: 2),
        'lastPersonSequence': 2,
        'projectId': other,
      },
    });

    expect(swarmProjectNews(quiet.reader, quiet.asks), {
      project: (bold: true, tags: 0, hasWaitingTag: false),
      other: (bold: true, tags: 0, hasWaitingTag: false),
    });
  });

  test('a project is not bold for its closed work, a private chat or the '
      "person's Buddy chat, which has its own row", () async {
    final r = await rig();
    await moveOn(r, {
      'closed': {
        ...groupData('closed', lastMessageSequence: 9),
        'archived': true,
      },
      'private': groupData('private', audience: [me], lastMessageSequence: 9),
      'buddy-chat': buddyChatData('buddy-chat', lastMessageSequence: 9),
    });

    expect(swarmProjectNews(r.reader, r.asks), isEmpty);
    // The Buddy chat's own row is bold.
    expect(chat(r, 'buddy-chat'), (bold: true, tags: 0));
  });

  test('without read marks or tags read, nothing is new', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [groupData('g1', lastMessageSequence: 3)]);
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    addTearDown(reader.dispose);
    await reader.refresh();

    expect(swarmChatNews(reader, null, reader.snapshot!.conversation('g1')!), (
      bold: false,
      tags: 0,
    ));
    expect(swarmProjectNews(reader, null), isEmpty);
  });

  group('counts as the desktop counts (attention.dart mentionsIn)', () {
    test('a tag stops counting once the person has read past it', () async {
      final r = await rig(
        tags: [
          mentionRow('t-read', messageSequence: 3),
          mentionRow('t-new', messageSequence: 4),
        ],
      );
      // The person read through t-read; the first read alone marks no tag.
      r.reader.readMarks!.markRead('g1', 3);
      await moveOn(r, {
        'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
      });

      expect(chat(r, 'g1'), (bold: true, tags: 1));
      expect(swarmProjectNews(r.reader, r.asks), {
        project: (bold: false, tags: 0, hasWaitingTag: true),
      });

      r.reader.readMarks!.markRead('g1', 4);
      await settle();

      expect(chat(r, 'g1'), (bold: false, tags: 0));
      expect(swarmProjectNews(r.reader, r.asks), isEmpty);
    });

    test('a tag already waiting when the Swarm is first read counts: that '
        'first read marks no tag read', () async {
      final r = await rig(tags: [mentionRow('t1', messageSequence: 3)]);

      expect(chat(r, 'g1'), (bold: true, tags: 1));
      expect(swarmProjectNews(r.reader, r.asks), {
        project: (bold: false, tags: 0, hasWaitingTag: true),
      });

      // The person reads the chat as far as the first read had marked it.
      r.reader.readMarks!.markRead('g1', 3);
      await settle();

      expect(chat(r, 'g1'), (bold: false, tags: 0));
    });

    test('reading a chat to its newest main-stream message is a read of its '
        'tags, though replies only in a thread came after it', () async {
      final r = await rig(tags: [mentionRow('t1', messageSequence: 3)]);
      // Read once as it is now: the newest message is a reply only in its
      // thread.
      await moveOn(r, {
        'g1': {
          ...groupData('g1', title: 'Fix login', lastMessageSequence: 5),
          'lastMainSequence': 3,
        },
      });
      final fresh = SwarmReadMarks(r.reader, store: null);
      addTearDown(fresh.dispose);
      r.reader.readMarks = fresh;
      await settle();
      expect(chat(r, 'g1'), (bold: true, tags: 1));

      // The chat read to its end: its newest main-stream message, offline.
      fresh.markRead('g1', 3);
      await settle();

      expect(chat(r, 'g1'), (bold: false, tags: 0));
    });

    test("the first read's marks are kept apart on the phone: read back, the "
        'tag still counts, and once read it stays read', () async {
      final store = MemoryKeyValueStore();
      final r = await rig(tags: [mentionRow('t1', messageSequence: 3)]);
      final first = SwarmReadMarks(r.reader, store: store);
      r.reader.readMarks = first;
      await settle();
      first.dispose();

      final again = SwarmReadMarks(r.reader, store: store);
      r.reader.readMarks = again;
      await settle();
      expect(chat(r, 'g1'), (bold: true, tags: 1));

      again.markRead('g1', 3);
      again.dispose();
      final last = SwarmReadMarks(r.reader, store: store);
      addTearDown(last.dispose);
      r.reader.readMarks = last;
      await settle();

      expect(chat(r, 'g1'), (bold: false, tags: 0));
    });

    test('marks a phone kept before first reads were apart still count as '
        'read', () async {
      final store = MemoryKeyValueStore();
      final r = await rig(tags: [mentionRow('t1', messageSequence: 3)]);
      await store.write(
        'swarm_read_marks.$me.$tab',
        jsonEncode({
          'marks': {'g1': 3},
        }),
      );
      final kept = SwarmReadMarks(r.reader, store: store);
      addTearDown(kept.dispose);
      r.reader.readMarks = kept;
      await settle();

      expect(chat(r, 'g1'), (bold: false, tags: 0));
    });

    test('a tag in a reply only in its thread counts on Threads, not in its '
        'chat or project', () async {
      final r = await rig(
        tags: [mentionRow('t1', threadId: 'm-root', messageSequence: 9)],
      );

      expect(chat(r, 'g1'), (bold: false, tags: 0));
      expect(swarmProjectNews(r.reader, r.asks), isEmpty);
    });

    test('a tag in a reply also sent to a task chat counts there, not on its '
        'project', () async {
      // The server names no thread for a reply also in the chat
      // (backend mentions.ts threadsOf).
      final r = await rig(tags: [mentionRow('t1', messageSequence: 4)]);
      await moveOn(r, {
        'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
      });

      expect(chat(r, 'g1'), (bold: true, tags: 1));
      expect(swarmProjectNews(r.reader, r.asks), {
        project: (bold: false, tags: 0, hasWaitingTag: true),
      });
    });

    test('a muted chat never counts and is never bold; its tags stay in '
        'Activity', () async {
      final r = await rig(
        tags: [
          mentionRow('t1'),
          mentionRow('t2', conversationId: 'g2'),
        ],
        settings: {'g1': 'muted'},
      );
      await moveOn(r, {
        'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
      });

      expect(chat(r, 'g1'), (bold: false, tags: 0));
      expect(chat(r, 'g2'), (bold: true, tags: 1));
      expect(swarmProjectNews(r.reader, r.asks), {
        project: (bold: false, tags: 0, hasWaitingTag: true),
      });
      expect(r.asks.mentions, hasLength(2));
    });

    test("a project counts only the chats this Swarm lists under it: not "
        "another project's chat a tag names it for, closed work, a private "
        "chat, the person's Buddy chat or a chat not listed", () async {
      final r = await rig(
        tags: [
          mentionRow('t-web', conversationId: 'web-lead'),
          mentionRow('t-closed', conversationId: 'closed'),
          mentionRow('t-private', conversationId: 'private'),
          mentionRow('t-buddy', conversationId: 'buddy-chat'),
          mentionRow('t-gone', conversationId: 'not-listed'),
        ],
      );

      expect(swarmProjectNews(r.reader, r.asks), {
        other: (bold: true, tags: 1, hasWaitingTag: true),
      });
      // The private chat's own row still counts its tag, as the desktop's.
      expect(chat(r, 'private'), (bold: true, tags: 1));
    });

    test('nothing counts until the phone has its read marks back', () async {
      final r = await rig(tags: [mentionRow('t1', messageSequence: 9)]);
      final waiting = Completer<String?>();
      final slow = SwarmReadMarks(r.reader, store: _HeldStore(waiting.future));
      addTearDown(slow.dispose);
      r.reader.readMarks = slow;

      expect(chat(r, 'g1'), (bold: false, tags: 0));
      expect(swarmProjectNews(r.reader, r.asks), isEmpty);

      waiting.complete(null);
      await settle();

      expect(chat(r, 'g1').tags, 1);
    });

    test('nothing counts once access is gone', () async {
      final r = await rig(tags: [mentionRow('t1')]);
      final g1 = r.reader.snapshot!.conversation('g1')!;
      expect(chat(r, 'g1'), (bold: true, tags: 1));

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      await r.reader.refresh();
      await settle();

      expect(r.reader.accessRevoked, isTrue);
      expect(swarmChatNews(r.reader, r.asks, g1), (bold: false, tags: 0));
      expect(swarmProjectNews(r.reader, r.asks), isEmpty);
    });

    test(
      'a decision asked in a chat counts while the chat is unread',
      () async {
        final r = await rig(decisions: [decisionRow('d1')]);

        expect(chat(r, 'g1'), (bold: false, tags: 0), reason: 'read');

        await moveOn(r, {
          'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4),
        });

        expect(chat(r, 'g1'), (bold: true, tags: 1));
        expect(swarmProjectNews(r.reader, r.asks), {
          project: (bold: false, tags: 0, hasWaitingTag: true),
        });
      },
    );

    // Task #2927: a project's number is its chat's tags alone; decisions are
    // in Activity and on the chat's own row.
    test('a decision asked in the project chat raises its chat row, not the '
        "project's number, even while the chat is unread", () async {
      final r = await rig(
        decisions: [decisionRow('d1', conversationId: leadChat)],
      );
      await moveOn(r, {
        leadChat: groupData(leadChat, title: 'Mobile', lastMessageSequence: 4),
      });

      expect(chat(r, leadChat), (bold: true, tags: 1));
      expect(swarmProjectNews(r.reader, r.asks)[project], (
        bold: false,
        tags: 0,
        hasWaitingTag: true,
      ));
      expect(r.asks.decisions, hasLength(1), reason: 'Activity keeps it');
    });

    test('a decision answered on another device leaves the count without a '
        'reload', () async {
      final r = await rig(decisions: [decisionRow('d1')]);
      await moveOn(
        r,
        {'g1': groupData('g1', title: 'Fix login', lastMessageSequence: 4)},
        derived: {'decisionsWaiting': 1, 'mentionsWaiting': 0},
      );
      expect(chat(r, 'g1'), (bold: true, tags: 1));
      final loads = r.swarm.paths.where((p) => p.endsWith('/parts')).length;

      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c30',
        derived: {'decisionsWaiting': 0, 'mentionsWaiting': 0},
      );
      await r.reader.refresh();
      await settle();

      expect(chat(r, 'g1'), (bold: true, tags: 0));
      expect(swarmProjectNews(r.reader, r.asks), isEmpty);
      expect(
        r.swarm.paths.where((p) => p.endsWith('/parts')),
        hasLength(loads),
        reason: 'no reload',
      );
    });
  });
}

/// A phone store whose read answers when [value] does.
class _HeldStore implements LocalKeyValueStore {
  _HeldStore(this.value);

  final Future<String?> value;

  @override
  Future<String?> read(String key) => value;

  @override
  Future<void> write(String key, String value) async {}

  @override
  Future<void> delete(String key) async {}
}
