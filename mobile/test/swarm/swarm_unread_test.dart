import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

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
  }) => {
    'id': id,
    'projectId': projectId,
    'projectName': 'Mobile',
    'conversationId': conversationId,
    'conversationTitle': 'Fix login',
    'messageId': 'msg-$id',
    'leadName': 'River',
    'text': 'Look',
    'createdAt': '2026-10-27T01:00:00.000Z',
  };

  /// A Swarm of two projects: Mobile with its project chat, work g1 and g2,
  /// closed work, a private chat and the reader's Buddy chat; Web with its
  /// project chat. Read once, so what is there counts as read; [tags] wait.
  Future<({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks})> rig({
    List<Map<String, dynamic>> tags = const [],
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
    final derived = {'mentionsWaiting': tags.length};
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(head: head, groups: groups, derived: derived);
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': tags,
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
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

  /// A change read in which [ids] moved on to [sequence].
  Future<void> moveOn(
    ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r,
    Map<String, Map<String, dynamic>> groups,
  ) async {
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c3',
      groups: [
        for (final MapEntry(:key, :value) in groups.entries)
          part(key, 20, value),
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

  test("a chat the Lead tagged the person in is bold with the count of the "
      "tags still waiting, read or not", () async {
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

  test('a project is bold while its project chat or open work is unread, '
      'and counts every tag waiting in it', () async {
    final r = await rig(tags: [mentionRow('t1'), mentionRow('t2')]);

    expect(swarmProjectNews(r.reader, r.asks), {
      project: (bold: true, tags: 2),
    });

    final quiet = await rig();
    await moveOn(quiet, {
      leadChat: groupData(
        leadChat,
        title: 'Mobile',
        agentIds: ['agent-lead'],
        leadId: 'agent-lead',
        lastMessageSequence: 5,
      ),
      'web-lead': {
        ...groupData('web-lead', title: 'Web', lastMessageSequence: 2),
        'projectId': other,
      },
    });

    expect(swarmProjectNews(quiet.reader, quiet.asks), {
      project: (bold: true, tags: 0),
      other: (bold: true, tags: 0),
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
}
